// rename-models.js — 改写 GetUserStatus 响应（label 改名 + 模型解锁 + 注入项）入口。

import { gzipSync } from './connect.js';
import {
  RUNTIME_MODEL_SLOT_STATUS,
  buildRenameTable,
  buildUnlockSet,
  catalogEntries,
  catalogEntryForUid,
  getRuntimeModelSlotStatus,
} from './lib/rename/template-and-catalog.js';
import { renameInJson, unlockInJson } from './lib/rename/json-and-specs.js';
import { extractModelList, renameInProto, unlockInProto, unwrapModelPayload } from './lib/rename/proto-rewrite.js';

export { getRuntimeModelSlotStatus, catalogEntryForUid, catalogEntries, extractModelList };

function rewrapUserStatusPayload(kind, newPayload, changed) {
  if (kind === 'plain' || kind === 'proto') return { body: newPayload, changed, recompressed: false };
  if (kind === 'gzip') return { body: gzipSync(newPayload), changed, recompressed: true };
  const envelope = Buffer.alloc(5 + newPayload.length);
  envelope[0] = 0;
  envelope.writeUInt32BE(newPayload.length, 1);
  newPayload.copy(envelope, 5);
  return { body: envelope, changed, recompressed: false, wasConnect: true };
}

export function renameModels(resBody) {
  const pairs = buildRenameTable();
  if (pairs.length === 0) return null;
  const unwrapped = unwrapModelPayload(resBody);
  if (!unwrapped) return null;

  const { kind, payload } = unwrapped;
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
  return rewrapUserStatusPayload(kind, newPayload, changed);
}

export function unlockModels(resBody) {
  const cfg = buildUnlockSet();
  if (!cfg.unlockAll && cfg.byUid.size === 0) return null;
  const unwrapped = unwrapModelPayload(resBody);
  if (!unwrapped) return null;

  const extra = {
    showSlotUid: cfg.showSlotUid,
    showThinkingEffort: cfg.showThinkingEffort,
    showContextWindow: cfg.showContextWindow,
  };
  const { kind, payload } = unwrapped;
  const isJson = payload[0] === 0x7b;
  let newPayload, changed;
  if (isJson) {
    const text = payload.toString('utf8');
    if (text.indexOf('"modelUid"') === -1) return null;
    const r = unlockInJson(
      text, cfg.unlockAll, cfg.byUid, cfg.defaultProviderName, cfg.labelTemplate,
      cfg.namePrefix, cfg.unlockScope, cfg.slotVisibilityMode, cfg.slotVisibility,
      RUNTIME_MODEL_SLOT_STATUS, extra,
    );
    if (r.changed === 0) return null;
    newPayload = Buffer.from(r.text, 'utf8');
    changed = r.changed;
  } else {
    const r = unlockInProto(
      payload, cfg.unlockAll, cfg.byUid, cfg.defaultProviderName, cfg.labelTemplate,
      cfg.namePrefix, cfg.unlockScope, cfg.slotVisibilityMode, cfg.slotVisibility,
      RUNTIME_MODEL_SLOT_STATUS, extra,
    );
    if (!r) return null;
    newPayload = r.body;
    changed = r.changed;
  }
  return rewrapUserStatusPayload(kind, newPayload, changed);
}
