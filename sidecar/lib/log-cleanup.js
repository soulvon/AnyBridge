// lib/log-cleanup.js — 用户目录按天滚动日志的保留期清理。
//
// proxy-logs / mitm-logs / rpc-audit / vision-logs 四个目录均按
// <prefix>-YYYY-MM-DD.jsonl 滚动，此前只增不删，长期使用（尤其开启
// 请求日志或 BYOK_MITM_LOG 排障）会在用户目录堆积大量历史日志文件。
//
// 策略：默认保留 7 天（BYOK_LOG_RETENTION_DAYS 覆盖），每个自然日只在
// 首次写入时扫描一轮（lastRunDay 节流），写入点调用本函数的开销为一次
// 字符串比较。按文件 mtime 判断过期，不解析文件名日期，避免时区/异常
// 文件名误删。

import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config-dir.js';

const DEFAULT_RETENTION_DAYS = 7;
const LOG_DIRS = ['proxy-logs', 'mitm-logs', 'rpc-audit', 'vision-logs'];

let lastRunDay = '';

function retentionDays() {
  const n = parseInt(process.env.BYOK_LOG_RETENTION_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

/**
 * 清理各日志目录中超过保留期的滚动日志文件。
 * @param {boolean} [force] 跳过按日节流，强制扫描一轮（供测试/手动触发）。
 */
export function cleanupExpiredLogs(force = false) {
  const day = new Date().toISOString().slice(0, 10);
  if (!force && day === lastRunDay) return;
  lastRunDay = day;
  const cutoff = Date.now() - retentionDays() * 86400000;
  for (const name of LOG_DIRS) {
    const dir = path.join(configDir(), name);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // 目录不存在或不可读：无日志可清
    }
    for (const file of entries) {
      if (!/-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
      const full = path.join(dir, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  }
}
