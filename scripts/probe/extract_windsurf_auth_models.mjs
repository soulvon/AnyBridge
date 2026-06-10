import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFields, fieldToString } from '../../sidecar/proto.js';

const SQLITE_CANDIDATES = [
  process.env.SQLITE3,
  process.env.SQLITE3_PATH,
  'sqlite3',
  'D:\\DevelopTools\\platform-tools\\sqlite3.exe',
].filter(Boolean);

function findSqlite() {
  for (const candidate of SQLITE_CANDIDATES) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error('sqlite3 executable not found; set SQLITE3_PATH to sqlite3.exe');
}

function appDataDir() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return path.join(os.homedir(), '.config');
}

function stateDbPath(target) {
  return path.join(appDataDir(), target, 'User', 'globalStorage', 'state.vscdb');
}

function readStateValue(sqlite, dbPath, key) {
  if (!fs.existsSync(dbPath)) return null;
  const sql = `SELECT value FROM ItemTable WHERE key=${JSON.stringify(key)};`;
  try {
    return execFileSync(sqlite, [dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
  } catch (err) {
    throw new Error(`failed to read ${key} from ${dbPath}: ${err.message}`);
  }
}

function printableString(field) {
  if (!field || field.wireType !== 2) return '';
  const s = fieldToString(field);
  if (!s || s.length > 120) return '';
  if (/[\x00-\x08\x0e-\x1f]/.test(s)) return '';
  return s;
}

function first(fields, fieldNo, wireType) {
  return fields.find((f) => f.field === fieldNo && (wireType === undefined || f.wireType === wireType));
}

function all(fields, fieldNo, wireType) {
  return fields.filter((f) => f.field === fieldNo && (wireType === undefined || f.wireType === wireType));
}

function intField(fields, fieldNo) {
  const f = first(fields, fieldNo);
  if (!f) return null;
  if (f.wireType === 0) return f.value;
  if (f.wireType === 5 && Buffer.isBuffer(f.value) && f.value.length === 4) return f.value.readUInt32LE(0);
  return null;
}

function boolField(fields, fieldNo) {
  const n = intField(fields, fieldNo);
  return n === null ? null : n !== 0;
}

function parseModelInfo(field) {
  if (!field || field.wireType !== 2) return {};
  const fields = parseFields(field.value);
  return {
    tokenizer: printableString(first(fields, 5, 2)) || null,
    modelUid: printableString(first(fields, 17, 2)) || null,
    serverUrl: printableString(first(fields, 18, 2)) || null,
    sweApiId: printableString(first(fields, 20, 2)) || null,
    apiId: printableString(first(fields, 23, 2)) || null,
  };
}

function parseModelEnum(fields) {
  const modelOrAlias = first(fields, 2, 2);
  if (!modelOrAlias) return null;
  const sub = parseFields(modelOrAlias.value);
  const enumField = first(sub, 1, 0);
  return enumField ? enumField.value : null;
}

function parseModelConfig(buf) {
  const fields = parseFields(buf);
  const label = printableString(first(fields, 1, 2));
  const modelUid = printableString(first(fields, 22, 2));
  if (!label || !modelUid) return null;

  const info = parseModelInfo(first(fields, 23, 2));
  const directApiId = !modelUid.startsWith('MODEL_') ? modelUid : null;
  const apiId = info.apiId || info.sweApiId || directApiId;
  return {
    label,
    modelUid,
    apiId,
    modelEnum: parseModelEnum(fields),
    disabled: boolField(fields, 4),
    contextWindow: intField(fields, 18),
    provider: intField(fields, 10),
    supportsImages: boolField(fields, 5),
    tokenizer: info.tokenizer,
  };
}

function walkMessages(buf, depth, sink) {
  if (depth < 0 || !Buffer.isBuffer(buf) || buf.length < 4) return;
  const model = parseModelConfig(buf);
  if (model) sink.set(model.modelUid, model);

  const fields = parseFields(buf);
  for (const f of fields) {
    if (f.wireType === 2 && f.value.length > 4) {
      walkMessages(f.value, depth - 1, sink);
    }
  }
}

function extractFromUserStatusProto(base64) {
  const buf = Buffer.from(base64, 'base64');
  const found = new Map();

  const top = parseFields(buf);
  const field33 = all(top, 33, 2);
  for (const group of field33) {
    const groupFields = parseFields(group.value);
    for (const entry of all(groupFields, 1, 2)) {
      walkMessages(entry.value, 4, found);
    }
  }

  if (found.size === 0) walkMessages(buf, 10, found);
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function extractTarget(target) {
  const sqlite = findSqlite();
  const db = stateDbPath(target);
  const raw = readStateValue(sqlite, db, 'windsurfAuthStatus');
  if (!raw) return { target, db, error: 'windsurfAuthStatus not found', models: [] };

  const auth = JSON.parse(raw);
  const sourceKey = auth.userStatusProtoBinaryBase64
    ? 'userStatusProtoBinaryBase64'
    : auth.userStatusProtoBinaryBase64Backup
      ? 'userStatusProtoBinaryBase64Backup'
      : '';
  if (!sourceKey) return { target, db, error: 'userStatusProtoBinaryBase64 not found', models: [] };

  const models = extractFromUserStatusProto(auth[sourceKey]);
  return { target, db, sourceKey, models };
}

const targets = process.argv.slice(2);
const selectedTargets = targets.length ? targets : ['Windsurf', 'Devin'];
const needle = process.env.MODEL_FILTER || '';
const re = needle ? new RegExp(needle, 'i') : null;

for (const target of selectedTargets) {
  const result = extractTarget(target);
  console.log(`=== ${target} ===`);
  if (result.error) {
    console.log(`ERROR ${result.error}`);
    continue;
  }
  const models = re
    ? result.models.filter((m) => re.test(`${m.label} ${m.modelUid} ${m.apiId || ''}`))
    : result.models;
  console.log(`source=${result.sourceKey} total=${result.models.length} shown=${models.length}`);
  for (const m of models) {
    console.log(`${m.modelUid}\t${m.label}\tapiId=${m.apiId || ''}\tctx=${m.contextWindow ?? ''}\timg=${m.supportsImages ?? ''}`);
  }
}
