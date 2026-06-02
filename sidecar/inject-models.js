// inject-models.js — 往 GetCommandModelConfigs 的响应里追加自定义模型条目。
// 响应体是 repeated field1 = 模型条目，每条目内：
//   field1 = 显示名（下拉框文字）
//   field22 = Windsurf 内部模型 ID（GetChatMessage 会用它当 requestedModel）
// 注入策略：克隆一个现有条目（保证 field22 是 Windsurf 认识的 ID），只改 field1
// 为自定义显示名，追加到列表末尾。选中后走 chat.js 的 MODEL_MAP/回退 → provider 模型。

import { tryGunzip } from './connect.js';

// 自定义模型：显示名 → 克隆来源条目的 field1 旧值（用于定位要复制哪个条目）。
// 这里直接用 "克隆第一个条目" 的简单策略，显示名替换为 CUSTOM_MODELS。
const CUSTOM_MODELS = ['fucking 1.0'];

function readVarint(buf, i) {
  let shift = 0, result = 0;
  while (true) {
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result >>> 0, i];
}

function writeVarint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

// 切出顶层 repeated field1 的每个条目（返回每个条目的原始字节，含 tag+len+body）。
function splitEntries(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length) {
    const start = i;
    let tag; [tag, i] = readVarint(buf, i);
    const wt = tag & 7;
    if (wt !== 2) return null; // 顶层只预期 len-delimited 条目
    let len; [len, i] = readVarint(buf, i);
    i += len;
    entries.push(buf.subarray(start, i));
  }
  return entries;
}

// 取条目 body（去掉外层 tag+len），返回 { fieldNum, body }。
function entryBody(entry) {
  let i = 0;
  let tag; [tag, i] = readVarint(entry, i);
  let len; [len, i] = readVarint(entry, i);
  return { fieldNum: tag >> 3, body: entry.subarray(i, i + len) };
}

// 把条目 body 里的 field1（显示名）替换为新字符串，返回新 body。
function replaceField1(body, newName) {
  const parts = [];
  let i = 0;
  while (i < body.length) {
    let tag; [tag, i] = readVarint(body, i);
    const fn = tag >> 3, wt = tag & 7;
    if (wt === 2) {
      let len; [len, i] = readVarint(body, i);
      const val = body.subarray(i, i + len);
      i += len;
      if (fn === 1) {
        const nameBuf = Buffer.from(newName, 'utf-8');
        parts.push(writeVarint((1 << 3) | 2), writeVarint(nameBuf.length), nameBuf);
      } else {
        parts.push(writeVarint(tag), writeVarint(len), val);
      }
    } else if (wt === 0) {
      const vStart = i;
      let v; [v, i] = readVarint(body, i);
      parts.push(writeVarint(tag), body.subarray(vStart, i));
    } else {
      return null; // 未知 wire type，放弃
    }
  }
  return Buffer.concat(parts);
}

// 把 body 包成顶层条目（field1, len-delimited）。
function wrapEntry(body) {
  return Buffer.concat([writeVarint((1 << 3) | 2), writeVarint(body.length), body]);
}

// 主入口：输入 Connect 帧（flag+len4+payload），返回追加了自定义模型的新帧（flag=0 不压缩）。
export function injectModels(resBody) {
  if (resBody.length < 5) return null;
  const flags = resBody[0];
  const msgLen = resBody.readUInt32BE(1);
  if (msgLen !== resBody.length - 5 || flags > 1) return null;

  let payload = resBody.subarray(5);
  if (flags === 1) {
    const d = tryGunzip(payload);
    if (!d) return null;
    payload = d;
  }

  const entries = splitEntries(payload);
  if (!entries || entries.length === 0) return null;

  // 克隆第一个条目作为模板，替换显示名后追加。
  const template = entryBody(entries[0]).body;
  const extra = [];
  for (const name of CUSTOM_MODELS) {
    const newBody = replaceField1(template, name);
    if (!newBody) continue;
    extra.push(wrapEntry(newBody));
  }
  if (extra.length === 0) return null;

  const newPayload = Buffer.concat([payload, ...extra]);
  const envelope = Buffer.alloc(5 + newPayload.length);
  envelope[0] = 0;
  envelope.writeUInt32BE(newPayload.length, 1);
  newPayload.copy(envelope, 5);
  return { envelope, count: extra.length, modelId: entryField22(template) };
}

// 取模板条目的 field22（内部模型 ID），用于日志/确认 MODEL_MAP 该映射哪个 ID。
function entryField22(body) {
  let i = 0;
  while (i < body.length) {
    let tag; [tag, i] = readVarint(body, i);
    const fn = tag >> 3, wt = tag & 7;
    if (wt === 2) {
      let len; [len, i] = readVarint(body, i);
      const val = body.subarray(i, i + len);
      i += len;
      if (fn === 22) return val.toString('utf-8');
    } else if (wt === 0) {
      [, i] = readVarint(body, i);
    } else return null;
  }
  return null;
}
