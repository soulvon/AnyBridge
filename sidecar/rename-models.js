// rename-models.js — 改写 GetUserStatus 响应（label 改名 + 模型解锁 + 注入项）。
// GetUserStatus body 是 JSON 文本，可能有三种封装：
//   ① 裸明文 JSON（首字节 '{' = 0x7b）
//   ② 裸 gzip（首两字节 1f 8b，HTTP content-encoding: gzip）
//   ③ Connect 帧（flag(1)+len(4)+payload，payload 可能再 gzip）
// 模型条目形如 {"label":"xAI Grok-3","modelUid":"MODEL_XAI_GROK_3",...}。
// 改完按原封装方式重新打包，编码方式不变。
//
// 阶段 4 起,unlockModels 合并了三种职责:rename + unlock + inject。
// renameModels 保留作为旧 API(已 deprecated),GUI/旧测试可能还会引用。
//
// 模型解锁：ClientModelConfig protobuf 中 field4=disabled (bool, wire type 0)。
// 任何"劫持已开启"的情况(任一 enabled 槽位 或 注入项)都解锁所有模型。

import { tryGunzip, gzipSync } from './connect.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// 引入 catalog 确保 pkg 静态分析时把 windsurf-catalog.js 拉进 bundle
// (实际读取走 JSON 文件, 但 import 让打包器能识别依赖)
import { WINDSURF_CATALOG } from './windsurf-catalog.js';

const RUNTIME_MODEL_SLOT_STATUS = new Map();

export function getRuntimeModelSlotStatus(modelUid) {
  if (!modelUid) return null;
  return RUNTIME_MODEL_SLOT_STATUS.get(modelUid) || null;
}

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  // 跨平台配置目录：macOS → ~/Library/Application Support/ide-byok
  //                    Linux → ~/.config/ide-byok
  //                    Windows → %APPDATA%/ide-byok
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ide-byok');
  if (process.platform === 'linux') return path.join(os.homedir(), '.config', 'ide-byok');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'ide-byok');
}

// 渲染显示模板。
//   tpl: 例如 "{prefix} {label} ({provider})",为空则用 DEFAULT_LABEL_TEMPLATE
//   vars: { prefix, label, provider, apiModel }
//     - prefix 可为空串(用户不想要前缀)
//     - label 必填,空 label 会渲染为空模板结果
//     - provider 为空时,若模板包含 {provider} 占位符 → 替换为「未设置」;否则填空串
//     - apiModel 可为空串
// 渲染后会 trim 收尾,再去掉连续多空格,避免出现 "(BYOK) Claude ()" 之类的尾巴。
//
// 变量白名单(避免用户模板里写别的占位符导致泄漏):
//   {prefix} {label} {provider} {apiModel}
const DEFAULT_LABEL_TEMPLATE = '{prefix} {label} ({provider})';
const TEMPLATE_VARS = ['prefix', 'label', 'provider', 'apiModel'];
const UNLOCK_SCOPES = new Set(['all', 'common', 'configured', 'claude', 'gpt', 'gemini', 'code']);

function normalizeUnlockScope(mode) {
  const s = String(mode || '').trim();
  return UNLOCK_SCOPES.has(s) ? s : 'all';
}

function isCommonManagedSlot(uid, label = '') {
  const s = `${uid || ''} ${label || ''}`.toLowerCase();
  return /claude|opus|sonnet|haiku|gpt|codex|gemini|kimi|swe|grok|glm|deepseek/.test(s);
}

function slotMatchesUnlockScope(uid, label, unlockScope) {
  const mode = normalizeUnlockScope(unlockScope);
  const s = `${uid || ''} ${label || ''}`.toLowerCase();
  if (mode === 'all') return true;
  if (mode === 'common') return isCommonManagedSlot(uid, label);
  if (mode === 'claude') return /claude|opus|sonnet|haiku/.test(s);
  if (mode === 'gpt') return /gpt|openai|o3|o4|codex/.test(s);
  if (mode === 'gemini') return /gemini|google/.test(s);
  if (mode === 'code') return /swe|code|codex|grok/.test(s);
  return false;
}

function shouldRewriteFallbackSlot(uid, label, unlockScope, wasDisabled) {
  // 官方本来可用的槽位始终改名为 "(官方)"，避免用户误以为它走 BYOK。
  // 解锁范围只控制原本 disabled 的模型是否被放出来并标成 "(未配置)"。
  if (!wasDisabled) return true;
  return slotMatchesUnlockScope(uid, label, unlockScope);
}

function renderTemplate(tpl, vars) {
  const tmpl = (tpl && tpl.trim()) || DEFAULT_LABEL_TEMPLATE;
  // provider 为空 → 模板里包含 {provider} 时,显示「未设置」(兄弟硬性要求)
  const hasProvider = /\bprovider\b/.test(tmpl);
  const v = {
    prefix:   vars.prefix   || '',
    label:    vars.label    || '',
    provider: vars.provider || (hasProvider ? '未设置' : ''),
    apiModel: vars.apiModel || '',
  };
  let out = tmpl;
  for (const k of TEMPLATE_VARS) {
    // 词边界匹配 {key},忽略大小写
    const re = new RegExp(`\\{${k}\\}`, 'g');
    out = out.replace(re, v[k]);
  }
  // 合并连续多空格 + trim
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}

function configuredLabelFromRuntime(cfg, fallbackLabel, uid, labelTemplate, namePrefix) {
  if (cfg && cfg.newLabel) return cfg.newLabel;
  if (!cfg || cfg.source !== 'rename') return cfg ? cfg.newLabel : '';
  return renderTemplate(labelTemplate, {
    prefix: namePrefix,
    label: cfg.customName || fallbackLabel || uid,
    provider: cfg.providerName || '未配置',
    apiModel: cfg.apiModel || '',
  });
}

// 内置兜底:captured ide-models.json 不存在或缺某 modelUid 时，用这张已知表查原始 label。
// 覆盖默认预设的 3 个槽位 + 常见可被改名的模型，确保新装(从未抓过 GetUserStatus)也能改名。
const BUILTIN_LABELS = {
  MODEL_XAI_GROK_3: 'xAI Grok-3',
  MODEL_XAI_GROK_3_MINI_REASONING: 'xAI Grok-3 mini Thinking',
  MODEL_PRIVATE_4: 'Grok Code Fast 1',
};

// 已实测这些原生槽位不会稳定上传图片。即使目标 BYOK 模型支持 Vision，
// 也不能把它们伪装成 supportsImages=true，否则 IDE 下拉框会误导用户。
const IMAGE_UNSAFE_NATIVE_SLOT_IDS = new Set([
  'MODEL_XAI_GROK_3',
  'MODEL_XAI_GROK_3_MINI_REASONING',
]);

function canDeclareImagesForSlot(uid) {
  return !IMAGE_UNSAFE_NATIVE_SLOT_IDS.has(uid);
}

// 完整 catalog 兜底: 新形态 modelUid（如 claude-opus-4-8-*、kimi-k2-6、swe-1-6 等）
// Windsurf 客户端的 GetUserStatus 响应里用 API 级 ID 作为 modelUid (field22)，
// 这些新形态不在 ide-models.json（只抓了旧 MODEL_* 枚举）里。
// 加载内置 windsurf-catalog.json 取原始 label 兜底，避免改名被跳过。
let _catalogLabels = null;
function catalogLabels() {
  if (_catalogLabels !== null) return _catalogLabels;
  _catalogLabels = new Map();
  try {
    // 1) 同目录 (sidecar/) → pkg 打包后保留
    let raw;
    try { raw = fs.readFileSync('./windsurf-catalog.json', 'utf8'); } catch { /* ignore */ }
    if (!raw) {
      // 2) 资源目录
      const resDir = process.env.BYOK_RESOURCE_DIR;
      if (resDir) {
        try { raw = fs.readFileSync(path.join(resDir, 'sidecar', 'windsurf-catalog.json'), 'utf8'); } catch { /* ignore */ }
      }
    }
    if (raw) {
      const obj = JSON.parse(raw);
      for (const m of (obj.models || [])) {
        if (m.modelUid && m.label) _catalogLabels.set(m.modelUid, m.label);
      }
    }
  } catch { /* ignore */ }
  return _catalogLabels;
}

// 改名表来源:model-map.json 的槽位。需要把「原始 label → 新名」
// 配对，但 model-map 只有 modelUid+displayName，原始 label 来自 captured ide-models.json
// (优先) 或内置 BUILTIN_LABELS (兜底)。热加载，每次响应读最新配置。
//
// namePrefix（全局前缀）: 当 namePrefix 非空时，所有已劫持模型的显示名前面都会拼接该前缀。
//   有自定义 displayName 的槽位: "{prefix} {displayName}"
//   无自定义 displayName 的槽位: "{prefix} {原始label}"
// namePrefix 为空时，行为与之前一致（只有 displayName 非空才改名）。
function buildRenameTable() {
  const dir = configDir();
  let slots = [];
  let namePrefix = '';
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.json'), 'utf8'));
    slots = Array.isArray(m.slots) ? m.slots : [];
    namePrefix = (m.namePrefix || '').trim();
  } catch { /* 无配置 → 空表，不改名 */ }

  let captured = new Map();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'ide-models.json'), 'utf8'));
    for (const e of (c.models || [])) captured.set(e.modelUid, e.label);
  } catch { /* 无 captured → 退化为只用内置兜底表 */ }

  const pairs = [];
  for (const s of slots) {
    if (s.enabled === false) continue; // 未劫持=保持原名（与 provider-pool 分流判断一致）
    const orig = captured.get(s.modelUid) || BUILTIN_LABELS[s.modelUid];
    if (!orig) continue;
    const customName = s.displayName && s.displayName.trim();
    if (namePrefix) {
      // 有全局前缀时：无论是否有自定义 displayName，都拼接前缀
      const baseName = customName || orig;
      const newName = `${namePrefix} ${baseName}`;
      if (newName !== orig) pairs.push([orig, newName]);
    } else if (customName) {
      // 无全局前缀且自定义名非空：仅改自定义名
      if (orig !== customName) pairs.push([orig, customName]);
    }
    // 无前缀且无自定义名：跳过，显示原名
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
          // modelUid 形态:
          //   旧模型:全大写下划线(MODEL_CLAUDE_4_5_OPUS) 或 MODEL_ 前缀
          //   新模型:API 级 ID(claude-opus-4-6, gpt-5-3-codex-high, gemini-3-1-pro-low)
          //   特征:含连字符或点号的小写串，或全大写下划线
          const uid = strs.find(s =>
            /^[A-Z][A-Z0-9_]{3,}$/.test(s.value) ||    // 旧:MODEL_PRIVATE_2
            /^MODEL_/.test(s.value) ||                   // 旧:MODEL_ 前缀
            /^[a-z][a-z0-9._-]+-[a-z0-9._-]+$/.test(s.value)  // 新:claude-opus-4-6
          );
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

// ─── 模型解锁 + 改名 + 注入（合并版）────────────────────────
// ClientModelConfig protobuf 字段映射（来自 Windsurf extension.js 逆向）：
//   field1  = label (string, wire type 2)
//   field2  = model_or_alias (message, wire type 2)
//   field22 = model_uid (string, wire type 2)
//   field3  = credit_multiplier (float, wire type 5)
//   field13 = pricing_type (enum, wire type 0)
//   field4  = disabled (bool, wire type 0) ← 解锁目标
//   field5  = supports_images (bool, wire type 0)
//   ...
//
// 三种配置合并为一个 Map<modelUid, Config>：
//   rename: 槽位改名（label = namePrefix + displayName 或 原 label）
//   injected: 注入项（label = "(BYOK) {原label} ({provider|未配置})"，解锁 + 设 supportsImages）
//   unlockOnly: 仅解锁 disabled，不改 label（适用于普通 BYOK 槽位 / 兜底）
//
// 解锁策略：默认开启 fallback。原本官方可用的未映射模型标 "(官方)" 并透传；
// 原本 disabled 的未映射模型按 unlockScope 决定是否放出，放出后标 "(未配置)"。
// rename/injected 配置项按 modelUid 精确命中，始终解锁并显示首个目标供应商。
//
// 详情见 spec/08-全模型解锁注入-ImplementationPlan.md

// 构建统一的「改写配置」：{ unlockAll, byUid }。
//   unlockAll: 开启 fallback 改写。默认开启，由 unlockScope 决定原本 disabled 的模型是否放出。
//   byUid: Map<modelUid, { newLabel, wantImages, source }>
//          - source: 'rename' (槽位改名) | 'injected' (注入项) | 'unlock' (仅解锁)
//
// 命名: 之前叫 buildUnlockSet，现在合并了 rename + unlock + inject 三种配置。
// 调用方: 重写后的 unlockModels 接收此结构。
function buildUnlockSet() {
  const dir = configDir();
  const byUid = new Map();
  let unlockAll = true;

  let namePrefix = '';
  let labelTemplate = '';
  let unlockScope = 'all';
  let slots = [];
  let injected = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.json'), 'utf8'));
    namePrefix = (m.namePrefix || '').trim();
    labelTemplate = (m.labelTemplate || '').trim();
    unlockScope = normalizeUnlockScope(m.unlockScope || m.slotDisplayMode);
    slots = Array.isArray(m.slots) ? m.slots : [];
    injected = Array.isArray(m.injected) ? m.injected : [];
  } catch { /* 无配置 → 默认全量 fallback */ }

  // 读取 captured ide-models.json (rename 需要原始 label)
  let captured = new Map();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'ide-models.json'), 'utf8'));
    for (const e of (c.models || [])) captured.set(e.modelUid, e.label);
  } catch { /* 无 captured → 退化为只用内置兜底表 */ }

  // 读取 providers.json (injected 需要 provider 名称)
  const providerNames = new Map();
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
    for (const pv of (p.providers || [])) providerNames.set(pv.id, pv.name);
  } catch { /* 无 providers → 注入项显示"未配置" */ }

  // 1) 槽位改名（劫持项）
  for (const s of slots) {
    if (s.enabled === false) continue;
    if (!s.modelUid) continue;
    // 三级 label 查找: captured (用户抓的) > catalog (新形态 API ID) > BUILTIN_LABELS (旧兜底)
    const orig = captured.get(s.modelUid) || catalogLabels().get(s.modelUid) || BUILTIN_LABELS[s.modelUid] || '';
    const customName = s.displayName && s.displayName.trim();
    const labelText = customName || orig;
    const providerName = (s.targets && s.targets[0] && providerNames.get(s.targets[0].providerId)) || '未配置';
    const apiModel = (s.targets && s.targets[0] && s.targets[0].model) || '';
    const newLabel = labelText ? renderTemplate(labelTemplate, {
      prefix: namePrefix,
      label: labelText,
      provider: providerName,
      apiModel,
    }) : '';
    byUid.set(s.modelUid, {
      newLabel,
      customName,
      providerName,
      apiModel,
      wantImages: s.supportsImages !== false && canDeclareImagesForSlot(s.modelUid),
      source: 'rename',
    });
  }

  // 2) 注入项（解锁灰色模型）
  for (const i of injected) {
    if (!i.modelUid) continue;
    const providerName = (i.providerId && providerNames.get(i.providerId)) || '未配置';
    // 三级查找: captured > catalog > 注入项的 label (兜底)
    const orig = captured.get(i.modelUid) || catalogLabels().get(i.modelUid) || i.label;
    const newLabel = renderTemplate(labelTemplate, {
      prefix: namePrefix,
      label: i.label,
      provider: providerName,
      apiModel: i.model || '',
    });
    if (newLabel === orig) continue;
    byUid.set(i.modelUid, {
      newLabel,
      wantImages: i.supportsImages !== false && canDeclareImagesForSlot(i.modelUid),
      source: 'injected',
    });
  }

  // 3) 不再单独预填 unlock-prefix 项;改由 rewriteForUnlock 在递归到
  //    每个 ClientModelConfig 时直接从原 label 读出 + 加 (BYOK) 前缀,
  //    这样即使 modelUid 不在 captured/catalog 里也能正确处理。

  // 4) 默认 provider: 取 providers 的第一个（按数组顺序），作为「未单独配置」项的后缀兜底
  //    没有 provider → 渲染时由 renderTemplate 决定(模板含 {provider} → 「未设置」)
  let defaultProviderName = '';
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
    const list = (p && Array.isArray(p.providers)) ? p.providers : [];
    if (list.length > 0 && list[0] && list[0].name) {
      defaultProviderName = list[0].name;
    }
  } catch { /* 无 providers → 走 renderTemplate 的「未设置」兜底 */ }

  return { unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope };
}

// 在一个 protobuf 子 message 中查找 field1 (label) 的字符串值。
// 返回字符串或 null。给 unlock-prefix 用: 即使 catalog 没收录, 也能从原响应里直接读出 label。
function findField1Label(buf) {
  let i = 0;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return null;
      i = tagR.next;
      if (wt === 0) { i = decVarint(buf, i).next; }
      else if (wt === 1) { i += 8; }
      else if (wt === 5) { i += 4; }
      else if (wt === 2) {
        const lr = decVarint(buf, i);
        const start = lr.next, end = start + lr.value;
        if (end > buf.length) return null;
        if (fn === 1) {
          // field1 = label
          const s = buf.subarray(start, end).toString('utf8');
          if (s.length > 0) return s;
        }
        i = end;
      } else return null;
    }
  } catch { /* ignore */ }
  return null;
}

// 在一个 protobuf 子 message 中查找 field22 (model_uid) 的字符串值。
// 返回字符串或 null。
function findModelUid(buf) {
  let i = 0;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return null;
      i = tagR.next;
      if (wt === 0) { i = decVarint(buf, i).next; }
      else if (wt === 1) { i += 8; }
      else if (wt === 5) { i += 4; }
      else if (wt === 2) {
        const lr = decVarint(buf, i);
        const start = lr.next, end = start + lr.value;
        if (end > buf.length) return null;
        if (fn === 22) {
          // field22 = model_uid
          const s = buf.subarray(start, end).toString('utf8');
          if (s.length > 0) return s;
        }
        i = end;
      } else return null;
    }
  } catch { /* ignore */ }
  return null;
}

// 在一个 protobuf 子 message 中读取 varint 字段。field 不存在时返回 null。
function findVarintField(buf, fieldNo) {
  let i = 0;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return null;
      i = tagR.next;
      if (wt === 0) {
        const vr = decVarint(buf, i);
        if (fn === fieldNo) return vr.value;
        i = vr.next;
      } else if (wt === 1) { i += 8; }
      else if (wt === 5) { i += 4; }
      else if (wt === 2) {
        const lr = decVarint(buf, i);
        const end = lr.next + lr.value;
        if (end > buf.length) return null;
        i = end;
      } else return null;
    }
  } catch { /* ignore */ }
  return null;
}

// 递归重写 protobuf，将 ClientModelConfig 条目按 byUid 配置改写 + 全部解锁（unlockAll）。
// 返回 { body: Buffer, changed: number } 或 null（无改动）。
function unlockInProto(payload, unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope, runtimeStatus) {
  const counter = { n: 0 };
  const out = rewriteForUnlock(payload, counter, 8, unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope, runtimeStatus);
  if (counter.n === 0) return null;
  return { body: out, changed: counter.n };
}

// 递归遍历 protobuf message，识别 ClientModelConfig 条目并按配置改写。
// 识别逻辑：子 message 包含 field22 (model_uid) 字符串 → 视为 ClientModelConfig 条目。
// 改写逻辑：
//   byUid 中有该 modelUid → 用 byUid 配置（newLabel + wantImages + 解锁）
//   byUid 中无该 modelUid 但 unlockAll=true → 仅解锁 + 自动读原 label 加 (BYOK) 前缀
//     （如果原 label 已经有 (BYOK) 前缀就不重复加,避免 slot 已经处理过的项重复）
//   其他情况 → 跳过
function rewriteForUnlock(buf, counter, depth, unlockAll, byUid, defaultProviderName = '', labelTemplate = '', namePrefix = '', unlockScope = 'all', runtimeStatus = null) {
  const parts = [];
  let i = 0;
  let mutated = false;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return buf;
      const tagBytes = buf.subarray(i, tagR.next);
      i = tagR.next;

      if (wt === 0) {
        // varint 字段 — 在当前层级无法确定是否是 ClientModelConfig
        // 原样保留，改写在子 message 层面处理
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
        if (end > buf.length) return buf;
        let child = buf.subarray(start, end);

        if (depth > 0 && len > 4) {
          // 检查子 message 是否是 ClientModelConfig 条目（含 field22 = model_uid）
          const uid = findModelUid(child);
          if (uid) {
            const cfg = byUid.get(uid);
            if (cfg) {
              // 已有显式配置（rename/injected/unlock-prefix），用 cfg
              const wantImages = cfg.wantImages;
              const fallbackLabel = findField1Label(child) || '';
              const newLabel = configuredLabelFromRuntime(cfg, fallbackLabel, uid, labelTemplate, namePrefix);
              const rewritten = rewriteConfigFields(child, { newLabel, wantImages });
              if (rewritten !== child) {
                child = rewritten;
                counter.n++;
                mutated = true;
              }
            } else if (unlockAll) {
              // 没有任何 byUid 配置但 unlockAll=true → 按解锁范围和原账号权限做 fallback 标记。
              const origLabel = findField1Label(child) || '';
              const wasDisabled = findVarintField(child, 4) === 1;
              if (shouldRewriteFallbackSlot(uid, origLabel, unlockScope, wasDisabled)) {
                const labelText = origLabel || uid;
                const status = wasDisabled ? 'unconfigured' : 'official';
                const newLabel = renderTemplate(labelTemplate, {
                  prefix: '',
                  label: labelText,
                  provider: status === 'unconfigured' ? '未配置' : '官方',
                  apiModel: '',
                });
                if (runtimeStatus) {
                  runtimeStatus.set(uid, { label: labelText, status, source: 'fallback' });
                }
                const rewritten = rewriteConfigFields(child, { newLabel, wantImages: canDeclareImagesForSlot(uid) });
                if (rewritten !== child) {
                  child = rewritten;
                  counter.n++;
                  mutated = true;
                }
              }
            } else if (depth > 0) {
              // 未配置且未劫持 → 递归下钻查找内层条目
              const sub = rewriteForUnlock(child, counter, depth - 1, unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope, runtimeStatus);
              if (sub !== child) { child = sub; mutated = true; }
            }
          } else if (depth > 0) {
            // 不是模型条目 → 递归下钻
            const sub = rewriteForUnlock(child, counter, depth - 1, unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope, runtimeStatus);
            if (sub !== child) { child = sub; mutated = true; }
          }
        }
        parts.push(tagBytes, encVarint(child.length), child);
        i = end;
      } else {
        return buf;
      }
    }
  } catch {
    return buf;
  }
  return mutated ? Buffer.concat(parts) : buf;
}

// 改写一个 ClientModelConfig 条目，解锁 + 对齐图片能力：
//   field4 (disabled)        → 一律删除（proto3 bool 默认 false = 不禁用）
//   field5 (supports_images) → 先删除原值，再按 wantImages 决定是否追加 field5=1
//     wantImages=true  → 追加 field5=1（GLM 等原本不支持图的模型也强制可发图）
//     wantImages=false → 不追加（proto3 默认 false，发图按钮置灰）
// 外层 rewriteForUnlock 会用 encVarint(child.length) 重算长度前缀，故增删字段安全。
function rewriteConfigFields(buf, { newLabel, wantImages }) {
  const parts = [];
  let i = 0;
  let mutated = false;
  try {
    while (i < buf.length) {
      const tagR = decVarint(buf, i);
      const tag = tagR.value;
      const fn = tag >>> 3, wt = tag & 7;
      if (fn === 0) return buf;
      const tagBytes = buf.subarray(i, tagR.next);
      i = tagR.next;

      if (wt === 0) {
        const vr = decVarint(buf, i);
        const valBytes = buf.subarray(tagR.next, vr.next);
        if (fn === 4) {
          // disabled → 删除（不论原值），由 proto3 默认值取 false
          if (vr.value !== 0) mutated = true;
        } else if (fn === 5) {
          // supports_images → 删除原值，稍后按 wantImages 统一追加
          mutated = true;
        } else {
          parts.push(tagBytes, valBytes);
        }
        i = vr.next;
      } else if (wt === 1) {
        parts.push(tagBytes, buf.subarray(i, i + 8)); i += 8;
      } else if (wt === 5) {
        parts.push(tagBytes, buf.subarray(i, i + 4)); i += 4;
      } else if (wt === 2) {
        const lr = decVarint(buf, i);
        const len = lr.value;
        const start = lr.next, end = start + len;
        if (end > buf.length) return buf;
        if (fn === 1 && newLabel) {
          // field1 label → 替换为新 label
          const newBuf = Buffer.from(newLabel, 'utf8');
          parts.push(tagBytes, encVarint(newBuf.length), newBuf);
          mutated = true;
        } else {
          parts.push(tagBytes, encVarint(len), buf.subarray(start, end));
        }
        i = end;
      } else {
        return buf;
      }
    }
  } catch {
    return buf;
  }
  // 追加 supports_images=true（field5, varint 1）。tag = (5<<3)|0 = 0x28。
  if (wantImages) {
    parts.push(Buffer.from([0x28, 0x01]));
    mutated = true;
  }
  return mutated ? Buffer.concat(parts) : buf;
}

// JSON 文本中的模型解锁：将 "disabled":true 改为 "disabled":false。
// unlockAll=true 时对所有模型改写；否则只对 slots 中的模型改写。
// 按 JSON 对象边界精确定位，避免误改相邻条目。
// unlockAll=true 时所有 ClientModelConfig 条目都处理；否则只处理 byUid 中的项。
// 每个条目可同时改 3 件事: label（rename/injected） / disabled（解锁） / supportsImages。
function unlockInJson(text, unlockAll, byUid, defaultProviderName = '', labelTemplate = '', namePrefix = '', unlockScope = 'all', runtimeStatus = null) {
  let changed = 0;
  const uidRe = /"modelUid"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = uidRe.exec(text)) !== null) {
    const uid = m[1];
    const cfg = byUid.get(uid);
    if (!cfg && !unlockAll) continue;
    // 从 modelUid 位置向前找最近的 '{'，向后找匹配的 '}'，确定该条目的 JSON 对象边界
    const objStart = findObjectStart(text, m.index);
    if (objStart === -1) continue;
    const objEnd = findObjectEnd(text, objStart);
    if (objEnd === -1) continue;
    const obj = text.slice(objStart, objEnd + 1);
    const lblM = obj.match(/"label"\s*:\s*"([^"]*)"/);
    const origLabel = lblM ? lblM[1] : '';
    const wasDisabled = /"disabled"\s*:\s*true/.test(obj);
    if (!cfg && unlockAll && !shouldRewriteFallbackSlot(uid, origLabel, unlockScope, wasDisabled)) continue;

    // 取配置: 有 cfg 用 cfg；否则 unlockAll 默认开启图片，但排除已验证不传图的原生槽位。
    const wantImages = cfg ? cfg.wantImages : canDeclareImagesForSlot(uid);
    let newLabel = cfg ? configuredLabelFromRuntime(cfg, origLabel, uid, labelTemplate, namePrefix) : null;
    if (!cfg && unlockAll) {
      const labelText = origLabel || uid;
      const status = wasDisabled ? 'unconfigured' : 'official';
      newLabel = renderTemplate(labelTemplate, {
        prefix: '',
        label: labelText,
        provider: status === 'unconfigured' ? '未配置' : '官方',
        apiModel: '',
      });
      if (runtimeStatus) {
        runtimeStatus.set(uid, { label: labelText, status, source: 'fallback' });
      }
    }

    // 1) label 改写（rename/injected 项才需要）
    let newObj = obj;
    if (newLabel) {
      // 匹配 "label":"..." 替换
      const labelMatch = newObj.match(/"label"\s*:\s*"([^"]*)"/);
      if (labelMatch) {
        // 用 JSON 转义防止 label 含引号
        const escaped = newLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        newObj = newObj.replace(/"label"\s*:\s*"[^"]*"/, `"label":"${escaped}"`);
      }
    }
    // 2) disabled:true → disabled:false（解锁）
    newObj = newObj.replace(/"disabled"\s*:\s*true/g, '"disabled":false');
    // 3) supportsImages 对齐：有该字段则改值；没有则在条目开头插入
    const imgVal = wantImages ? 'true' : 'false';
    if (/"supportsImages"\s*:\s*(true|false)/.test(newObj)) {
      newObj = newObj.replace(/"supportsImages"\s*:\s*(true|false)/g, `"supportsImages":${imgVal}`);
    } else {
      // 紧跟开头的 '{' 插入字段（JSON 对象字段无序，安全）
      newObj = newObj.replace(/^\{/, `{"supportsImages":${imgVal},`);
    }
    if (newObj !== obj) {
      text = text.slice(0, objStart) + newObj + text.slice(objEnd + 1);
      changed++;
      // 更新 uidRe 的 lastIndex，因为 text 长度可能变了
      uidRe.lastIndex = objStart + newObj.length;
    }
  }
  return { text, changed };
}

// 从 pos 位置向前找最近的不在字符串内的 '{'。
// 反向扫描时需要先判断当前是否在字符串内：从 pos 向前数引号，奇数个则在串内。
function findObjectStart(text, pos) {
  // 先判断 pos 位置是否在字符串内
  let inStr = false;
  for (let k = 0; k <= pos; k++) {
    if (text[k] === '"' && (k === 0 || text[k - 1] !== '\\')) inStr = !inStr;
  }
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    const c = text[i];
    // 跟踪字符串状态（反向）
    if (c === '"' && (i === 0 || text[i - 1] !== '\\')) inStr = !inStr;
    if (inStr) continue;
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

// 从 objStart 位置找匹配的 '}'（跳过嵌套对象和字符串）
function findObjectEnd(text, objStart) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = objStart; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 模型解锁 + 改名 + 注入 主入口：输入 GetUserStatus 完整响应 body，返回改写后的 body。
// 无改动/解析失败返回 null（调用方保持原 body）。
// 合并三种配置（详见 buildUnlockSet）:
//   - 槽位改名（rename）
//   - 注入项（injected, 加 (BYOK) 前缀）
//   - 全部解锁（unlockAll, 删 disabled 字段）
// 替代之前的 renameModels（label 改名）+ unlockModels（仅解锁）两个调用，一次性合并完成。
export function unlockModels(resBody) {
  if (!resBody || resBody.length < 2) return null;

  const { unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope } = buildUnlockSet();
  if (!unlockAll && byUid.size === 0) return null; // 劫持未开启且无配置，不改

  const b0 = resBody[0];
  let kind, payload;

  if (b0 === 0x7b) {
    kind = 'plain';
    payload = resBody;
  } else if (b0 === 0x1f && resBody[1] === 0x8b) {
    const d = tryGunzip(resBody);
    if (!d) return null;
    kind = 'gzip';
    payload = d;
  } else if ((b0 === 0 || b0 === 1) && resBody.length >= 5) {
    const msgLen = resBody.readUInt32BE(1);
    if (msgLen !== resBody.length - 5) return null;
    let p = resBody.subarray(5);
    if (b0 === 1) { const d = tryGunzip(p); if (!d) return null; p = d; }
    kind = 'connect';
    payload = p;
  } else {
    return null;
  }

  const isJson = payload[0] === 0x7b;
  let newPayload, changed;
  const runtimeStatus = new Map();

  if (isJson) {
    const text = payload.toString('utf8');
    if (text.indexOf('"modelUid"') === -1) return null;
    const r = unlockInJson(text, unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope, runtimeStatus);
    if (r.changed === 0) return null;
    newPayload = Buffer.from(r.text, 'utf8');
    changed = r.changed;
  } else {
    const r = unlockInProto(payload, unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope, runtimeStatus);
    if (!r) return null;
    newPayload = r.body;
    changed = r.changed;
  }

  RUNTIME_MODEL_SLOT_STATUS.clear();
  for (const [uid, status] of runtimeStatus) {
    RUNTIME_MODEL_SLOT_STATUS.set(uid, status);
  }

  if (kind === 'plain') {
    return { body: newPayload, changed, recompressed: false };
  }
  if (kind === 'gzip') {
    return { body: gzipSync(newPayload), changed, recompressed: true };
  }
  const envelope = Buffer.alloc(5 + newPayload.length);
  envelope[0] = 0;
  envelope.writeUInt32BE(newPayload.length, 1);
  newPayload.copy(envelope, 5);
  return { body: envelope, changed, recompressed: false, wasConnect: true };
}
