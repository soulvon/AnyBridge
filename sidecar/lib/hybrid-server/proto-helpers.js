import { EventEmitter } from 'node:events';

export const PREFLIGHT_ALLOW_METHODS = new Set(['CheckUserMessageRateLimit', 'CheckChatCapacity']);

export const STREAMING_METHODS = new Set([
  'GetStreamingCompletions',
  'GetStreamingExternalChatCompletions',
]);

export function getRpcMethod(url) {
  const parts = url.split('/');
  return parts[parts.length - 1] || '';
}

export function stripRoutePrefix(url) {
  return url.replace(/^\/_route\/api_server/, '');
}

export function now() {
  return new Date().toISOString().slice(11, 23);
}

export function sanitizeProxyRequestHeaders(headers, body) {
  const out = { ...headers };
  delete out.host;
  delete out.connection;
  delete out['proxy-connection'];
  delete out['keep-alive'];
  delete out.te;
  delete out.trailer;
  delete out.upgrade;
  delete out['transfer-encoding'];
  delete out['content-length'];
  if (body && body.length > 0) out['content-length'] = String(body.length);
  return out;
}

export function sanitizeProxyResponseHeaders(headers, opts = {}) {
  const out = { ...headers };
  delete out.connection;
  delete out['proxy-connection'];
  delete out['keep-alive'];
  delete out.te;
  delete out.trailer;
  delete out.upgrade;
  delete out['transfer-encoding'];
  delete out['content-length'];
  if (opts.stripEncoding) {
    delete out['content-encoding'];
    delete out['connect-content-encoding'];
  }
  if (opts.contentLength !== undefined) out['content-length'] = String(opts.contentLength);
  return out;
}

export function encodeVarintBuf(value) {
  const bytes = [];
  let v = BigInt(value);
  if (v < 0n) v = v + (1n << 64n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

export function createProtoHelpers({
  PORT,
  parseFields,
  writeStringField,
  writeBytesField,
  writeVarintField,
  mergeUnaryFrames,
  wrapUnary,
  unaryHeaders,
}) {
  function rewriteRegisterUser(protoBuf) {
    try {
      const fields = parseFields(protoBuf);
      const parts = [];
      for (const f of fields) {
        if (f.field === 3 && f.wireType === 2) {
          const origUrl = f.value.toString('utf8');
          console.log(`  🔄 RegisterUser: ${origUrl} → http://localhost:${PORT}`);
          parts.push(writeStringField(3, `http://localhost:${PORT}`));
        } else if (f.wireType === 0) {
          parts.push(Buffer.concat([
            Buffer.from([(f.field << 3) | 0]),
            encodeVarintBuf(f.value),
          ]));
        } else if (f.wireType === 2) {
          parts.push(writeBytesField(f.field, f.value));
        } else if (f.wireType === 1) {
          const tag = Buffer.from([(f.field << 3) | 1]);
          parts.push(Buffer.concat([tag, f.value]));
        } else if (f.wireType === 5) {
          const tag = Buffer.from([(f.field << 3) | 5]);
          parts.push(Buffer.concat([tag, f.value]));
        }
      }
      return Buffer.concat(parts);
    } catch (e) {
      console.error(`  ❌ RegisterUser rewrite failed: ${e.message}`);
      return protoBuf;
    }
  }

  function buildPreflightOkResponse(method) {
    const hasCapacity = writeVarintField(1, 1);
    if (method === 'CheckChatCapacity') {
      return Buffer.concat([hasCapacity]);
    }
    const messagesRemaining = writeVarintField(3, 9999);
    const maxMessages = writeVarintField(4, 9999);
    return Buffer.concat([hasCapacity, messagesRemaining, maxMessages]);
  }

  function makeUnaryResponseCollector(realRes) {
    const frames = [];
    const emitter = new EventEmitter();
    let statusCode = 200;
    let sent = false;
    let ended = false;

    realRes.on('close', () => {
      if (!ended) ended = true;
      emitter.emit('close');
    });

    const collector = {
      writeHead(status) {
        statusCode = status;
        sent = true;
      },
      write(data) {
        if (data) frames.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return true;
      },
      end(data) {
        if (data) frames.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        if (ended) return;
        ended = true;
        const merged = mergeUnaryFrames(frames);
        const wrapped = wrapUnary(merged);
        if (!realRes.headersSent) {
          realRes.writeHead(statusCode, { ...unaryHeaders(), 'content-length': wrapped.length });
        }
        realRes.end(wrapped);
      },
      on: (ev, cb) => { emitter.on(ev, cb); return collector; },
      once: (ev, cb) => { emitter.once(ev, cb); return collector; },
      removeListener: (ev, cb) => { emitter.removeListener(ev, cb); return collector; },
      removeAllListeners: () => { emitter.removeAllListeners(); return collector; },
      setHeader() {},
      getHeader() { return undefined; },
      getHeaders() { return {}; },
      removeHeader() {},
      flushHeaders() {},
    };

    Object.defineProperty(collector, 'headersSent', {
      get: () => sent,
      configurable: true,
    });
    Object.defineProperty(collector, 'writableEnded', {
      get: () => ended,
      configurable: true,
    });

    return collector;
  }

  return {
    rewriteRegisterUser,
    buildPreflightOkResponse,
    makeUnaryResponseCollector,
  };
}

