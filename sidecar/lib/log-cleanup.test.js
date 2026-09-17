import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupExpiredLogs } from './log-cleanup.js';

let tmpRoot;
let originalEnv;

function mkLog(dir, file, ageDays) {
  const full = path.join(tmpRoot, dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
  const past = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(full, past, past);
}

describe('cleanupExpiredLogs', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-logs-'));
    originalEnv = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = tmpRoot;
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = originalEnv;
    delete process.env.BYOK_LOG_RETENTION_DAYS;
  });

  it('删除超过保留期的滚动日志，保留新文件', () => {
    mkLog('proxy-logs', 'proxy-2020-01-01.jsonl', 30);
    mkLog('mitm-logs', 'mitm-2020-01-01.jsonl', 30);
    mkLog('rpc-audit', 'rpc-2020-01-01.jsonl', 30);
    mkLog('vision-logs', 'vision-2020-01-01.jsonl', 30);
    mkLog('proxy-logs', 'proxy-2099-01-01.jsonl', 0);
    cleanupExpiredLogs(true);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'proxy-logs/proxy-2020-01-01.jsonl')), false);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'mitm-logs/mitm-2020-01-01.jsonl')), false);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'rpc-audit/rpc-2020-01-01.jsonl')), false);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'vision-logs/vision-2020-01-01.jsonl')), false);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'proxy-logs/proxy-2099-01-01.jsonl')), true);
  });

  it('不动非日期命名的文件', () => {
    mkLog('proxy-logs', 'proxy-old.jsonl', 30);
    mkLog('proxy-logs', 'other.txt', 30);
    cleanupExpiredLogs(true);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'proxy-logs/proxy-old.jsonl')), true);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'proxy-logs/other.txt')), true);
  });

  it('保留天数可用 BYOK_LOG_RETENTION_DAYS 覆盖', () => {
    process.env.BYOK_LOG_RETENTION_DAYS = '1';
    mkLog('proxy-logs', 'proxy-2020-01-01.jsonl', 2);
    cleanupExpiredLogs(true);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'proxy-logs/proxy-2020-01-01.jsonl')), false);
  });
});
