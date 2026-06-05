// mitm-logger.js — 全量 MITM 请求/响应日志，持久化到文件
// 每次上游请求生成一条 JSONL 记录，包含完整的请求 URL/headers/body 和响应 status/headers/body

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  return path.join(os.homedir(), 'AppData', 'Roaming', 'ide-byok');
}

const LOG_DIR = path.join(configDir(), 'mitm-logs');

// 确保日志目录存在
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

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
  const record = {
    ts: new Date().toISOString(),
    ...entry,
    request: {
      ...entry.request,
      headers: redactHeaders(entry.request?.headers || {}),
    },
  };

  const line = JSON.stringify(record) + '\n';
  try {
    fs.appendFileSync(logFile(), line, 'utf8');
  } catch (e) {
    // 日志写入失败不阻断主流程
    console.error(`[mitm] 写日志失败: ${e.message}`);
  }
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
