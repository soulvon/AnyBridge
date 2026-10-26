// usage-ledger.js — 每请求一行的轻量明细账本（1.2）。
//
// 文件：<configDir>/usage/usage-YYYY-MM-DD.jsonl
// 用途：排障与统计的原始事实，重启不丢；stats.json 仍然只存天级聚合。
// 隐私边界：只写白名单字段，请求/响应正文永不入账（与 mitm-logs 的 body 日志分离）。
// 保留期：默认 90 天（BYOK_USAGE_RETENTION_DAYS 覆盖），按 mtime 清理，按日节流。

import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './lib/config-dir.js';

const USAGE_DIR = 'usage';
const DEFAULT_RETENTION_DAYS = 90;
let lastCleanupDay = '';

// 账本字段白名单：新增字段必须显式加到这里，杜绝把 body/header 误写进账本。
const LEDGER_FIELDS = [
  'requestId', 'client', 'route',
  'requestedModel', 'servedModel', 'provider', 'providerId',
  'startedAt', 'finishedAt', 'latencyMs',
  'status', 'errorKind', 'errorMessage',
  'usage', 'retries', 'attempts',
];

function usageDir() {
  return path.join(configDir(), USAGE_DIR);
}

function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function ledgerPath(day = dayKey()) {
  return path.join(usageDir(), `usage-${day}.jsonl`);
}

function retentionDays() {
  const n = parseInt(process.env.BYOK_USAGE_RETENTION_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

function cleanupIfNeeded() {
  const day = dayKey();
  if (day === lastCleanupDay) return;
  lastCleanupDay = day;
  const cutoff = Date.now() - retentionDays() * 86400000;
  let entries;
  try {
    entries = fs.readdirSync(usageDir());
  } catch {
    return; // 目录不存在：没有可清理的文件
  }
  for (const file of entries) {
    if (!/^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
    const full = path.join(usageDir(), file);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {}
  }
}

/** 按白名单裁剪记录，未知字段丢弃（显式审计而不是静默透传）。 */
export function pickLedgerFields(summary) {
  const out = {};
  for (const key of LEDGER_FIELDS) {
    if (summary[key] !== undefined) out[key] = summary[key];
  }
  return out;
}

/**
 * 追加一条请求明细。写失败只打日志，不影响代理主流程。
 * @param {object} summary request-tracker 的 summary()
 * @returns {boolean} 是否写入成功
 */
export function appendRecord(summary) {
  if (!summary || typeof summary !== 'object') {
    throw new Error('[usage-ledger] appendRecord requires a summary object');
  }
  const day = dayKey(summary.finishedAt || Date.now());
  const line = JSON.stringify(pickLedgerFields(summary));
  try {
    fs.mkdirSync(usageDir(), { recursive: true });
    cleanupIfNeeded();
    fs.appendFileSync(ledgerPath(day), line + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error(`[usage-ledger] write failed: ${e.message}`);
    return false;
  }
}

/** 读取某天账本（对账/接口用），行解析失败直接抛错而不是跳过。 */
export function readDay(day = dayKey()) {
  const file = ledgerPath(day);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

/** 汇总某天账本：requests/errors/tokens（供 check-stats 对账）。 */
export function summarizeDay(day = dayKey()) {
  const rows = readDay(day);
  const out = { requests: rows.length, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of rows) {
    if (row.status === 'failed' || row.status === 'rejected') out.errors += 1;
    out.input += Number(row.usage?.input) || 0;
    out.output += Number(row.usage?.output) || 0;
    out.cacheRead += Number(row.usage?.cacheRead) || 0;
    out.cacheWrite += Number(row.usage?.cacheWrite) || 0;
  }
  return out;
}

export const __ledgerTest = { LEDGER_FIELDS, ledgerPath, usageDir, retentionDays };
