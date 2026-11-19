// sidecar/lib/sse-parser.js — 标准 WHATWG SSE 增量流解析器
// 基于 StringDecoder('utf8')，正确处理多字节 UTF-8 分片、\r\n/\r/\n 跨 chunk 边界、
// 多行 data: 拼接、data:{...} 无空格、无 event: 默认事件，以及流尾 flush()。

import { StringDecoder } from 'node:string_decoder';

/**
 * 创建可增量喂入 Buffer / string 的 SSE 解析器。
 *
 * @param {{
 *   defaultEvent?: string,
 *   parseJson?: boolean,
 *   onInvalidLine?: (line: string) => void,
 * }} [options]
 */
export function createSSEParser(options = {}) {
  const defaultEvent = options.defaultEvent ?? 'message';
  const parseJson = options.parseJson !== false;
  const onInvalidLine = typeof options.onInvalidLine === 'function' ? options.onInvalidLine : null;

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let currentEvent = null;
  let dataLines = [];
  let currentId = undefined;

  function dispatchEvent(out) {
    if (dataLines.length === 0) {
      currentEvent = null;
      return;
    }
    const rawData = dataLines.join('\n');
    const hasExplicitEvent = currentEvent !== null;
    const event = hasExplicitEvent ? currentEvent : defaultEvent;
    currentEvent = null;
    dataLines = [];

    if (rawData === '[DONE]') {
      out.push({
        event,
        hasExplicitEvent,
        data: '[DONE]',
        rawData,
        done: true,
        id: currentId,
        jsonError: null,
      });
      return;
    }

    let data = rawData;
    let jsonError = null;
    if (parseJson) {
      try {
        data = JSON.parse(rawData);
      } catch (err) {
        jsonError = err;
      }
    }

    out.push({
      event,
      hasExplicitEvent,
      data,
      rawData,
      done: false,
      id: currentId,
      jsonError,
    });
  }

  function processLine(rawLine, out) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatchEvent(out);
      return;
    }
    if (line.startsWith(':')) {
      return;
    }

    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      if (dataLines.length > 0) {
        dispatchEvent(out);
      }
      currentEvent = value;
    } else if (field === 'data') {
      if (dataLines.length > 0) {
        const prevRaw = dataLines.join('\n');
        const trimmedPrev = prevRaw.trim();
        let prevComplete = prevRaw === '[DONE]';
        if (!prevComplete && parseJson && (trimmedPrev.startsWith('{') || trimmedPrev.startsWith('['))) {
          try {
            JSON.parse(prevRaw);
            prevComplete = true;
          } catch {}
        }
        if (prevComplete || value === '[DONE]') {
          dispatchEvent(out);
        }
      }
      dataLines.push(value);
    } else if (field === 'id') {
      if (!value.includes('\0')) currentId = value;
    } else if (field === 'retry') {
      // WHATWG SSE retry 提示字段；当前传输由外层统一控制，保留解析识别
    } else if (onInvalidLine) {
      onInvalidLine(line);
    }
  }

  /**
   * 消费缓冲中的完整行。
   * 注意：若末尾恰好停在单个 '\r'，保留到下次 push/flush，以兼容跨 chunk 的 '\r\n'。
   */
  function drainCompleteLines(out, isFlushing = false) {
    let start = 0;
    const len = buffer.length;
    for (let i = 0; i < len; i += 1) {
      const ch = buffer.charCodeAt(i);
      if (ch === 10 /* \n */) {
        processLine(buffer.slice(start, i), out);
        start = i + 1;
      } else if (ch === 13 /* \r */) {
        if (i + 1 < len) {
          if (buffer.charCodeAt(i + 1) === 10 /* \n */) {
            processLine(buffer.slice(start, i), out);
            i += 1;
          } else {
            processLine(buffer.slice(start, i), out);
          }
          start = i + 1;
        } else if (isFlushing) {
          processLine(buffer.slice(start, i), out);
          start = i + 1;
        }
      }
    }
    if (start > 0) buffer = buffer.slice(start);
  }

  return {
    /**
     * 喂入一块原始 chunk（Buffer / Uint8Array / string），返回本轮完整解析出的事件数组。
     */
    push(chunk) {
      if (chunk == null) return [];
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (!text) return [];
      buffer += text;
      const out = [];
      drainCompleteLines(out, false);
      return out;
    },

    /**
     * 刷新 decoder 残余字节与流尾未以空行结尾的最后一个事件。
     */
    flush() {
      const out = [];
      const tail = decoder.end();
      if (tail) buffer += tail;
      if (buffer.length > 0) {
        drainCompleteLines(out, true);
        if (buffer.length > 0) {
          processLine(buffer, out);
          buffer = '';
        }
      }
      dispatchEvent(out);
      return out;
    },

    reset() {
      decoder.end();
      buffer = '';
      currentEvent = null;
      dataLines = [];
      currentId = undefined;
    },
  };
}

/**
 * 解析一段完整的 SSE 文本。
 */
export function parseSSEText(text, options = {}) {
  const parser = createSSEParser(options);
  const events = parser.push(String(text || ''));
  if (options.flush !== false) {
    events.push(...parser.flush());
  }
  return events;
}

/**
 * 从可读流按标准 SSE 协议异步迭代已解析事件。
 */
export async function* parseSSEStream(stream, options = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('SSE stream must be an AsyncIterable');
  }
  const { onChunk, emitDone = false, ...parserOptions } = options;
  const parser = createSSEParser(parserOptions);

  for await (const chunk of stream) {
    if (typeof onChunk === 'function') {
      try { onChunk(chunk); } catch {}
    }
    for (const evt of parser.push(chunk)) {
      if (evt.done) {
        if (emitDone) yield evt;
        return;
      }
      yield evt;
    }
  }

  for (const evt of parser.flush()) {
    if (evt.done) {
      if (emitDone) yield evt;
      return;
    }
    yield evt;
  }
}
