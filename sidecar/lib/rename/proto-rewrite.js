// lib/rename/proto-rewrite.js — GetUserStatus Protobuf 读取、改写与注入

import { tryGunzip } from '../../connect.js';
import { canDeclareImagesForSlot, normalizeModelUid } from './template-and-catalog.js';
import { existingRewriteSpec, hiddenByVisibility, markRuntime, missingModelSpecs, modelMetadataForUid, visibleByOverride } from './json-and-specs.js';

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

/// 将 GetUserStatus / GetCliModelConfigs 响应体解包为 `{ kind, payload }`：
/// 支持明文 JSON（plain）、整包 gzip、Connect 5 字节信封（connect）与裸 protobuf（proto）。
export function unwrapModelPayload(resBody) {
  if (!resBody || resBody.length < 2) return null;
  const b0 = resBody[0];
  if (b0 === 0x7b) return { kind: 'plain', payload: resBody };
  if (b0 === 0x1f && resBody[1] === 0x8b) {
    const d = tryGunzip(resBody);
    return d ? { kind: 'gzip', payload: d } : null;
  }
  if (b0 === 0 || b0 === 1) {
    if (resBody.length < 5) return null;
    const msgLen = resBody.readUInt32BE(1);
    if (msgLen !== resBody.length - 5) return null;
    let p = resBody.subarray(5);
    if (b0 === 1) {
      const d = tryGunzip(p);
      if (!d) return null;
      p = d;
    }
    return { kind: 'connect', payload: p };
  }
  // 裸 protobuf（application/proto，tag 首字节 >= 0x08）
  return { kind: 'proto', payload: resBody };
}

// 输入 GetUserStatus / GetCliModelConfigs 完整响应 body,返回 [{modelUid, label}] 或 null。
export function extractModelList(resBody) {
  const unwrapped = unwrapModelPayload(resBody);
  if (!unwrapped) return null;
  const { kind, payload } = unwrapped;
  if (kind === 'plain' || payload[0] === 0x7b) {
    // JSON:直接正则提取 {"label":"..","modelUid":".."}
    const text = payload.toString('utf8');
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
  }
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
export function renameInProto(payload, pairs) {
  const counter = { n: 0 };
  const out = rewriteMessage(payload, counter, 8, toBytes(pairs));
  if (counter.n === 0) return null;
  return { body: out, changed: counter.n };
}

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

function writeStringFieldLocal(fieldNo, value) {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encVarint((fieldNo << 3) | 2), encVarint(data.length), data]);
}

function writeVarintFieldLocal(fieldNo, value) {
  return Buffer.concat([encVarint((fieldNo << 3) | 0), encVarint(value)]);
}

function rewriteModelInfoFields(buf, meta) {
  const parts = [];
  let i = 0;
  const apiId = meta?.apiId || '';
  const useSweApiId = /^swe-/i.test(apiId);
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
        parts.push(tagBytes, buf.subarray(tagR.next, vr.next));
        i = vr.next;
      } else if (wt === 1) {
        parts.push(tagBytes, buf.subarray(i, i + 8)); i += 8;
      } else if (wt === 5) {
        parts.push(tagBytes, buf.subarray(i, i + 4)); i += 4;
      } else if (wt === 2) {
        const lr = decVarint(buf, i);
        const start = lr.next, end = start + lr.value;
        if (end > buf.length) return buf;
        // ModelInfo 里 field17 是内部 modelUid，field20/23 是真实 API ID。
        // 克隆模板时必须重写或清掉这些字段，否则客户端会把合成槽位折叠成模板模型。
        if (fn !== 17 && fn !== 20 && fn !== 23) {
          parts.push(tagBytes, encVarint(lr.value), buf.subarray(start, end));
        }
        i = end;
      } else {
        return buf;
      }
    }
  } catch {
    return buf;
  }

  if (meta?.uid) parts.push(writeStringFieldLocal(17, meta.uid));
  if (apiId) parts.push(writeStringFieldLocal(useSweApiId ? 20 : 23, apiId));
  return Buffer.concat(parts);
}

// 递归重写 protobuf，将 ClientModelConfig 条目按 byUid 配置改写 + 全部解锁（unlockAll）。
// 返回 { body: Buffer, changed: number } 或 null（无改动）。
export function unlockInProto(payload, unlockAll, byUid, defaultProviderName, labelTemplate, namePrefix, unlockScope, slotVisibilityMode, slotVisibility, runtimeStatus, extra = {}) {
  const counter = { n: 0 };
  const ctx = {
    unlockAll,
    byUid,
    defaultProviderName,
    labelTemplate,
    namePrefix,
    unlockScope,
    slotVisibilityMode,
    slotVisibility,
    runtimeStatus,
    showSlotUid: extra.showSlotUid === true,
    showThinkingEffort: extra.showThinkingEffort === true,
    showContextWindow: extra.showContextWindow === true,
  };
  const state = { injected: false };
  const out = rewriteForUnlock(payload, counter, 8, ctx, state);
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
function rewriteForUnlock(buf, counter, depth, ctx, state) {
  const parts = [];
  let i = 0;
  let mutated = false;
  const directModelUids = new Set();
  let templateTagBytes = null;
  let templateChild = null;
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
            directModelUids.add(uid);
            if (!templateTagBytes) templateTagBytes = tagBytes;
            if (!templateChild) templateChild = child;

            const cfg = ctx.byUid.get(uid) || ctx.byUid.get(normalizeModelUid(uid));
            const wasDisabled = findVarintField(child, 4) === 1;
            const origLabel = findField1Label(child) || '';
            const spec = existingRewriteSpec(uid, origLabel, wasDisabled, cfg, ctx);
            if (spec.passthrough) {
              parts.push(tagBytes, encVarint(child.length), child);
              i = end;
              continue;
            }
            if (!spec.keep) {
              counter.n++;
              mutated = true;
              i = end;
              continue;
            }

            const rewritten = rewriteConfigFields(child, {
              modelUid: spec.status === 'configured' ? spec.uid : undefined,
              apiIdOverride: spec.apiIdOverride || '',
              newLabel: spec.newLabel,
              wantImages: spec.wantImages,
              contextWindow: spec.contextWindow || null,
              disabled: spec.disabled,
            });
            if (rewritten !== child) {
              child = rewritten;
              counter.n++;
              mutated = true;
            }
          } else if (depth > 0) {
            // 不是模型条目 → 递归下钻
            const sub = rewriteForUnlock(child, counter, depth - 1, ctx, state);
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

  if (!state.injected && templateTagBytes && templateChild) {
    const specs = missingModelSpecs(new Set(directModelUids), ctx);
    if (specs.length) {
      for (const spec of specs) {
        const synthetic = rewriteConfigFields(templateChild, {
          modelUid: spec.uid,
          apiIdOverride: spec.apiIdOverride || '',
          newLabel: spec.newLabel,
          wantImages: spec.wantImages,
          contextWindow: spec.contextWindow || null,
          disabled: spec.disabled,
        });
        parts.push(templateTagBytes, encVarint(synthetic.length), synthetic);
        counter.n++;
      }
      state.injected = true;
      mutated = true;
    }
  }

  return mutated ? Buffer.concat(parts) : buf;
}

// 改写一个 ClientModelConfig 条目，按策略设置 disabled + 对齐图片能力：
//   field22(model_uid)       → 合成缺失条目时替换成目标 modelUid
//   field4 (disabled)        → disabled=false 时删除；disabled=true 时追加 field4=1
//   field5 (supports_images) → wantImages 为布尔值时才重写；否则保持原值
//     wantImages=true  → 追加 field5=1（GLM 等原本不支持图的模型也强制可发图）
//     wantImages=false → 不追加（proto3 默认 false，发图按钮置灰）
//   field18(context_window)   → slot 覆盖优先，否则用 catalog；避免合成条目沿用模板窗口
//   field23(model_info)       → 同步内部 modelUid/API ID，避免客户端按模板模型折叠
// 外层 rewriteForUnlock 会用 encVarint(child.length) 重算长度前缀，故增删字段安全。
function rewriteConfigFields(buf, { modelUid, apiIdOverride, newLabel, wantImages, contextWindow, disabled }) {
  const parts = [];
  let i = 0;
  let mutated = false;
  const manageDisabled = typeof disabled === 'boolean';
  const manageImages = typeof wantImages === 'boolean';
  const manageModelUid = typeof modelUid === 'string' && modelUid.length > 0;
  const manageLabel = typeof newLabel === 'string' && newLabel.length > 0;
  const overrideWindow = Number(contextWindow);
  const hasContextOverride = Number.isFinite(overrideWindow) && overrideWindow > 0;
  // 已有 modelUid 时可合并 catalog；仅 slot 覆盖时也允许改 field18
  const meta = manageModelUid
    ? modelMetadataForUid(modelUid, hasContextOverride ? overrideWindow : null)
    : (hasContextOverride ? { uid: '', apiId: null, contextWindow: Math.trunc(overrideWindow) } : null);
  if (meta && apiIdOverride) meta.apiId = apiIdOverride;
  const manageContextWindow = !!(meta && Number.isFinite(Number(meta.contextWindow)) && Number(meta.contextWindow) > 0);
  let sawModelInfo = false;
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
        if (fn === 4 && manageDisabled) {
          // disabled 由函数末尾统一追加；false 使用 proto3 默认值。
          mutated = true;
        } else if (fn === 5 && manageImages) {
          // supports_images 由函数末尾统一追加；false 使用 proto3 默认值。
          mutated = true;
        } else if (fn === 18 && manageContextWindow) {
          // context_window 由函数末尾按 catalog 统一追加。
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
        if (fn === 1 && manageLabel) {
          // field1 label → 替换为新 label
          const newBuf = Buffer.from(newLabel, 'utf8');
          parts.push(tagBytes, encVarint(newBuf.length), newBuf);
          mutated = true;
        } else if (fn === 22 && manageModelUid) {
          // field22 model_uid → 合成缺失模型条目时替换。
          const newBuf = Buffer.from(modelUid, 'utf8');
          parts.push(tagBytes, encVarint(newBuf.length), newBuf);
          mutated = true;
        } else if (fn === 23 && manageModelUid) {
          const info = rewriteModelInfoFields(buf.subarray(start, end), meta);
          parts.push(tagBytes, encVarint(info.length), info);
          sawModelInfo = true;
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
  // 追加 disabled=true（field4, varint 1）。tag = (4<<3)|0 = 0x20。
  if (manageDisabled && disabled) {
    parts.push(Buffer.from([0x20, 0x01]));
    mutated = true;
  }
  // 追加 supports_images=true（field5, varint 1）。tag = (5<<3)|0 = 0x28。
  if (manageImages && wantImages) {
    parts.push(Buffer.from([0x28, 0x01]));
    mutated = true;
  }
  if (manageContextWindow) {
    parts.push(writeVarintFieldLocal(18, Number(meta.contextWindow)));
    mutated = true;
  }
  if (manageModelUid && !sawModelInfo) {
    const info = rewriteModelInfoFields(Buffer.alloc(0), meta);
    parts.push(Buffer.concat([encVarint((23 << 3) | 2), encVarint(info.length), info]));
    mutated = true;
  }
  return mutated ? Buffer.concat(parts) : buf;
}

// JSON 文本中的模型槽位改写：按策略设置 disabled、label、supportsImages。
// unlockAll=true 时按 slotVisibilityMode 处理未映射项；否则只处理 byUid 中的项。
// 按 JSON 对象边界精确定位，避免误改相邻条目。
// unlockAll=true 时所有 ClientModelConfig 条目都处理；否则只处理 byUid 中的项。
