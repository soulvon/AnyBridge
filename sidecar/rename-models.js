// rename-models.js — 改写 GetUserStatus 响应里的模型显示名（label）。
// GetUserStatus body 是 JSON 文本，可能有三种封装：
//   ① 裸明文 JSON（首字节 '{' = 0x7b）
//   ② 裸 gzip（首两字节 1f 8b，HTTP content-encoding: gzip）
//   ③ Connect 帧（flag(1)+len(4)+payload，payload 可能再 gzip）
// 模型条目形如 {"label":"xAI Grok-3","modelUid":"MODEL_XAI_GROK_3",...}。
// 改 label 即改下拉框显示名。改完按原封装方式重新打包，编码方式不变。

import { tryGunzip, gzipSync } from './connect.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  return path.join(os.homedir(), 'AppData', 'Roaming', 'windsurf-byok');
}

// 内置兜底:captured windsurf-models.json 不存在或缺某 modelUid 时，用这张已知表查原始 label。
// 覆盖默认预设的 3 个槽位 + 常见可被改名的模型，确保新装(从未抓过 GetUserStatus)也能改名。
const BUILTIN_LABELS = {
  MODEL_XAI_GROK_3: 'xAI Grok-3',
  MODEL_XAI_GROK_3_MINI_REASONING: 'xAI Grok-3 mini Thinking',
  MODEL_PRIVATE_4: 'Grok Code Fast 1',
};

// 改名表来源:model-map.json 的槽位（displayName 非空才改）。需要把「原始 label → 新名」
// 配对，但 model-map 只有 modelUid+displayName，原始 label 来自 captured windsurf-models.json
// (优先) 或内置 BUILTIN_LABELS (兜底)。热加载，每次响应读最新配置。
function buildRenameTable() {
  const dir = configDir();
  let slots = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.json'), 'utf8'));
    slots = Array.isArray(m.slots) ? m.slots : [];
  } catch { /* 无配置 → 空表，不改名 */ }

  let captured = new Map();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'windsurf-models.json'), 'utf8'));
    for (const e of (c.models || [])) captured.set(e.modelUid, e.label);
  } catch { /* 无 captured → 退化为只用内置兜底表 */ }

  const pairs = [];
  for (const s of slots) {
    if (s.enabled === false) continue; // 未劫持=保持原名（与 provider-pool 分流判断一致）
    if (!s.displayName || !s.displayName.trim()) continue; // 空=显示原名，跳过
    const orig = captured.get(s.modelUid) || BUILTIN_LABELS[s.modelUid];
    if (!orig || orig === s.displayName) continue;
    pairs.push([orig, s.displayName]);
  }
  // 顺序先长后短，避免短 label 抢先匹配长 label 的前缀。
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

// ─── 提取模型清单(modelUid → label)──────────────────────────
// 用于 GUI「添加映射」时的原始名下拉框。复用 renameModels 的解封装逻辑。
// 遍历 protobuf,凡是某 message 同时含一个看起来像 modelUid 的字符串
// (全大写+下划线,或含 'MODEL' / 已知 ID 形态)和一个 label 字符串,即视为模型条目。

// 收集一个 message 内的所有 wire-type-2 字符串子串(可打印 UTF-8)。
function collectStrings(buf, depth, sink) {
  let i = 0;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return;
      i = tagR.next;
      if (wt === 0) { i = decVarint(buf, i).next; }
      else if (wt === 1) { i += 8; }
      else if (wt === 5) { i += 4; }
      else if (wt === 2) {
        const lr = decVarint(buf, i);
        const start = lr.next, end = start + lr.value;
        if (end > buf.length) return;
        const child = buf.subarray(start, end);
        const s = child.toString('utf8');
        // 可打印字符串(无控制字符)记为候选字段
        if (s.length > 0 && /^[\x20-\x7e][\x20-\x7e \u00a0-\uffff]*$/.test(s) && !/[\x00-\x08\x0e-\x1f]/.test(s)) {
          sink.push({ field: fn, value: s });
        }
        // 同时递归下钻(条目可能是嵌套 message)
        if (lr.value > 1 && depth > 0) collectStrings(child, depth - 1, sink);
        i = end;
      } else return;
    }
  } catch { /* ignore */ }
}

// 从一层 message 中找「条目 message」:子 message 里同时有 modelUid 形态和 label。
function walkForModels(buf, depth, out) {
  let i = 0;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return;
      i = tagR.next;
      if (wt === 0) { i = decVarint(buf, i).next; }
      else if (wt === 1) { i += 8; }
      else if (wt === 5) { i += 4; }
      else if (wt === 2) {
        const lr = decVarint(buf, i);
        const start = lr.next, end = start + lr.value;
        if (end > buf.length) return;
        const child = buf.subarray(start, end);
        // 检查该子 message 是否是模型条目
        if (lr.value > 4 && depth > 0) {
          const strs = [];
          collectStrings(child, 2, strs);
          // modelUid 形态:全大写下划线 或包含已知前缀
          const uid = strs.find(s => /^[A-Z][A-Z0-9_]{3,}$/.test(s.value) || /^MODEL_/.test(s.value));
          // label:含小写字母或空格的人类可读名(排除纯大写 ID)
          const label = strs.find(s => s.value !== (uid && uid.value) && /[a-z ]/.test(s.value) && s.value.length <= 60);
          if (uid && label) {
            out.set(uid.value, label.value);
          }
          // 继续递归(列表外层 message)
          walkForModels(child, depth - 1, out);
        }
        i = end;
      } else return;
    }
  } catch { /* ignore */ }
}

// 输入 GetUserStatus 完整响应 body,返回 [{modelUid, label}] 或 null。
export function extractModelList(resBody) {
  if (!resBody || resBody.length < 2) return null;
  const b0 = resBody[0];
  let payload;
  if (b0 === 0x7b) {
    // JSON:直接正则提取 {"label":"..","modelUid":".."}
    const text = resBody.toString('utf8');
    const out = [];
    const re = /"modelUid"\s*:\s*"([^"]+)"/g;
    const labelRe = /"label"\s*:\s*"([^"]*)"/g;
    // 简化:按 modelUid 出现位置,向前找最近的 label
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 300), m.index);
      const lm = [...before.matchAll(labelRe)].pop();
      out.push({ modelUid: m[1], label: lm ? lm[1] : m[1] });
    }
    return out.length ? out : null;
  } else if (b0 === 0x1f && resBody[1] === 0x8b) {
    payload = tryGunzip(resBody);
  } else if ((b0 === 0 || b0 === 1) && resBody.length >= 5) {
    let p = resBody.subarray(5);
    payload = b0 === 1 ? tryGunzip(p) : p;
  }
  if (!payload) return null;
  if (payload[0] === 0x7b) return extractModelList(payload); // 解出来还是 JSON
  const map = new Map();
  walkForModels(payload, 8, map);
  if (map.size === 0) return null;
  return [...map.entries()].map(([modelUid, label]) => ({ modelUid, label }));
}


// 下拉框真实数据源是 gzip 压缩的 protobuf（GetUserStatus 周期刷新返回），
// 模型显示名是嵌套 message 里的 wire-type-2 字符串字段。改名会改变字符串
// 字节长度（"xAI Grok-3"=10 → "Claude Opus 4.6"=15），所以必须递归重新
// 序列化，让每一层外层 message 的 length 前缀自动重算（长度变化向上冒泡）。

// 把 [原始label, 新label] 文本表转成 [Buffer, Buffer] 字节表（protobuf 按字节等长匹配）。
function toBytes(pairs) {
  return pairs.map(([o, n]) => [Buffer.from(o, 'utf8'), Buffer.from(n, 'utf8')]);
}

function encVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; bytes.push(b); } while (v);
  return Buffer.from(bytes);
}

function decVarint(buf, pos) {
  let result = 0, shift = 0, p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, next: p };
}

// 叶子标量：命中替换表则替换并返回新 Buffer，否则返回原值。
function renameLeaf(buf, counter, bytes) {
  for (const [oldB, newB] of bytes) {
    if (buf.length === oldB.length && buf.equals(oldB)) {
      counter.n++;
      return newB;
    }
  }
  return buf;
}

// 递归重写一个 protobuf message。命中替换 → 返回新 Buffer；无命中 → 返回原 buf。
// depth 限制递归层数，避免误把二进制当 message 无限下钻。
function rewriteMessage(buf, counter, depth, bytes) {
  const parts = [];
  let i = 0;
  let mutated = false;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return buf; // 非法字段号 → 当作非 message，原样返回
      const tagBytes = buf.subarray(i, tagR.next);
      i = tagR.next;

      if (wt === 0) {
        const vr = decVarint(buf, i);
        parts.push(tagBytes, buf.subarray(tagR.next, vr.next));
        i = vr.next;
      } else if (wt === 1) {
        parts.push(tagBytes, buf.subarray(i, i + 8)); i += 8;
      } else if (wt === 5) {
        parts.push(tagBytes, buf.subarray(i, i + 4)); i += 4;
      } else if (wt === 2) {
        const lr = decVarint(buf, i);
        const len = lr.value;
        const start = lr.next, end = start + len;
        if (end > buf.length) return buf; // 越界 → 非 message
        let child = buf.subarray(start, end);

        // 先试叶子字符串替换
        const leaf = renameLeaf(child, counter, bytes);
        if (leaf !== child) {
          child = leaf;
          mutated = true;
        } else if (depth > 0 && len > 1) {
          // 否则尝试递归当嵌套 message 重写
          const sub = rewriteMessage(child, counter, depth - 1, bytes);
          if (sub !== child) { child = sub; mutated = true; }
        }
        parts.push(tagBytes, encVarint(child.length), child);
        i = end;
      } else {
        return buf; // 未知 wire type → 非 message
      }
    }
  } catch {
    return buf;
  }
  return mutated ? Buffer.concat(parts) : buf;
}

// 入口：对解压后的 protobuf payload 改名。返回 {body,changed} 或 null。
function renameInProto(payload, pairs) {
  const counter = { n: 0 };
  const out = rewriteMessage(payload, counter, 8, toBytes(pairs));
  if (counter.n === 0) return null;
  return { body: out, changed: counter.n };
}

// 全局替换 JSON 文本里的旧 label 为新 label（带引号边界，避免误伤子串）。
function renameInJson(text, pairs) {
  let changed = 0;
  for (const [oldLabel, newLabel] of pairs) {
    const needle = `"${oldLabel}"`;
    const repl = `"${newLabel}"`;
    let from = 0;
    while (true) {
      const pos = text.indexOf(needle, from);
      if (pos === -1) break;
      text = text.slice(0, pos) + repl + text.slice(pos + needle.length);
      changed++;
      from = pos + repl.length;
    }
  }
  return { text, changed };
}

// 主入口：输入 GetUserStatus 完整响应 body，返回改写后的 body（保持原封装方式）。
// 无改动/解析失败返回 null（调用方保持原 body）。
export function renameModels(resBody) {
  if (!resBody || resBody.length < 2) return null;

  // 改名表来自 model-map.json + captured 清单，热加载。空表 = 无槽位配 displayName，跳过。
  const pairs = buildRenameTable();
  if (pairs.length === 0) return null;

  const b0 = resBody[0];
  let kind, payload;

  if (b0 === 0x7b) {
    // ① 裸明文 JSON
    kind = 'plain';
    payload = resBody;
  } else if (b0 === 0x1f && resBody[1] === 0x8b) {
    // ② 裸 gzip
    const d = tryGunzip(resBody);
    if (!d) return null;
    kind = 'gzip';
    payload = d;
  } else if ((b0 === 0 || b0 === 1) && resBody.length >= 5) {
    // ③ Connect 帧
    const msgLen = resBody.readUInt32BE(1);
    if (msgLen !== resBody.length - 5) return null;
    let p = resBody.subarray(5);
    if (b0 === 1) { const d = tryGunzip(p); if (!d) return null; p = d; }
    kind = 'connect';
    payload = p;
  } else {
    return null;
  }

  // payload 可能是 JSON 文本或 protobuf。下拉框真实源是 protobuf（gzip）。
  const isJson = payload[0] === 0x7b;
  let newPayload, changed;

  if (isJson) {
    const text = payload.toString('utf8');
    if (text.indexOf('"modelUid"') === -1) return null;
    const r = renameInJson(text, pairs);
    if (r.changed === 0) return null;
    newPayload = Buffer.from(r.text, 'utf8');
    changed = r.changed;
  } else {
    const r = renameInProto(payload, pairs);
    if (!r) return null;
    newPayload = r.body;
    changed = r.changed;
  }

  if (kind === 'plain') {
    return { body: newPayload, changed, recompressed: false };
  }
  if (kind === 'gzip') {
    // 重新 gzip，保持 content-encoding: gzip 不变
    return { body: gzipSync(newPayload), changed, recompressed: true };
  }
  // connect: 重新封成未压缩帧（flag=0）
  const envelope = Buffer.alloc(5 + newPayload.length);
  envelope[0] = 0;
  envelope.writeUInt32BE(newPayload.length, 1);
  newPayload.copy(envelope, 5);
  return { body: envelope, changed, recompressed: false, wasConnect: true };
}
