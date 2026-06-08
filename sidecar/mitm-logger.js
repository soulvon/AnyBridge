// mitm-logger.js — MITM 请求/响应日志，持久化到文件
// 默认关闭请求体落盘；排障时设置 BYOK_MITM_LOG=true 开启，开启后仍会截断大 body。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ide-byok');
  if (process.platform === 'linux') return path.join(os.homedir(), '.config', 'ide-byok');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'ide-byok');
}

const LOG_DIR = path.join(configDir(), 'mitm-logs');
const MITM_LOG_ENABLED = /^(true|1|on)$/i.test(String(process.env.BYOK_MITM_LOG || 'false'));
const MITM_FULL_LOG = /^(true|1|on)$/i.test(String(process.env.BYOK_MITM_FULL_LOG || 'false'));
const MITM_MAX_BODY_BYTES = parseInt(process.env.BYOK_MITM_MAX_BODY_BYTES || '8192', 10);

// 仅在显式开启时创建日志目录，避免默认运行留下敏感调试痕迹。
if (MITM_LOG_ENABLED) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

// 按日期滚动日志文件
function logFile() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `mitm-${d}.jsonl`);
}

// 脱敏：把 Authorization / x-api-key 的值替换为 sk-***REDACTED***
function redactHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    const k = key.toLowerCase();
    if (k === 'authorization' || k === 'x-api-key') {
      const val = String(out[key]);
      if (val.length > 8) {
        out[key] = val.slice(0, 4) + '***' + val.slice(-4);
      } else {
        out[key] = '***REDACTED***';
      }
    }
  }
  return out;
}

function byteLen(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}

function summarizeBody(body) {
  if (MITM_FULL_LOG || body == null) return body;
  const max = Number.isFinite(MITM_MAX_BODY_BYTES) && MITM_MAX_BODY_BYTES > 0 ? MITM_MAX_BODY_BYTES : 8192;
  if (Buffer.isBuffer(body)) {
    if (body.length <= max) return body.toString('utf8');
    return `[body omitted: ${body.length} bytes]`;
  }
  if (typeof body === 'string') {
    const len = Buffer.byteLength(body);
    if (len <= max) return body;
    return `${body.slice(0, max)}...[truncated ${len - max} bytes, total ${len}]`;
  }
  const len = byteLen(body);
  if (len <= max) return body;
  return `[body omitted: ${len} bytes]`;
}

function slim(entry) {
  const request = entry.request ? {
    ...entry.request,
    headers: redactHeaders(entry.request.headers || {}),
    body: summarizeBody(entry.request.body),
  } : undefined;
  const response = entry.response ? {
    ...entry.response,
    headers: redactHeaders(entry.response.headers || {}),
    body: summarizeBody(entry.response.body),
  } : undefined;
  return { ...entry, request, response };
}

/**
 * 记录一条 MITM 日志
 * @param {object} entry
 * @param {string} entry.direction - 'upstream' | 'downstream'
 * @param {string} entry.providerName - 供应商名称
 * @param {string} entry.model - 使用的模型 ID
 * @param {string} entry.format - 'openai' | 'anthropic'
 * @param {object} entry.request - { method, url, headers, body }
 * @param {object} [entry.response] - { statusCode, statusMessage, headers, body }
 * @param {string} [entry.error] - 错误信息
 */
export function mitmLog(entry) {
  if (!MITM_LOG_ENABLED) return;
  const record = {
    ts: new Date().toISOString(),
    ...slim(entry),
  };

  const line = JSON.stringify(record) + '\n';
  fs.appendFile(logFile(), line, 'utf8', (e) => {
    if (e) console.error(`[mitm] 写日志失败: ${e.message}`);
  });
}

/**
 * 读取最近的 MITM 日志
 * @param {number} count - 读取最近 N 条
 * @returns {object[]}
 */
export function readRecentMitmLogs(count = 50) {
  try {
    const content = fs.readFileSync(logFile(), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-count).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export { LOG_DIR };
