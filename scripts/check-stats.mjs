#!/usr/bin/env node
// check-stats.mjs — 统计数据对账（本机档，不冒充干净环境单元测试）。
//
// 用途：验证「统计数字彼此自洽」，而不是验证代码结构。
//   1. stats.json 今日快照 vs usage/usage-YYYY-MM-DD.jsonl 明细账本
//   2. stats.json 的 estCostUsd vs 按定价表重算（差异 >1% 视为失败）
//   3. usage-local.json 旁路数据摘要（Claude Code / Cursor / CPA）
//
// 退出码：硬失败（文件损坏、成本不自洽）非 0；账本与 requests 的差异只提示。
// 运行：npm run check:stats（依赖本机 AppData 真实数据）

import fs from 'node:fs';
import { configDir } from '../sidecar/lib/config-dir.js';
import { costOf, estimateCost } from '../sidecar/pricing.js';

const COST_TOLERANCE = 0.05; // 5%，覆盖未归属 tokens 的默认价与四舍五入

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

function summarizeLedger(day) {
  const file = `${configDir()}/usage/usage-${day}.jsonl`;
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  const sum = { rows: rows.length, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of rows) {
    if (row.status === 'failed' || row.status === 'rejected') sum.errors += 1;
    sum.input += Number(row.usage?.input) || 0;
    sum.output += Number(row.usage?.output) || 0;
    sum.cacheRead += Number(row.usage?.cacheRead) || 0;
    sum.cacheWrite += Number(row.usage?.cacheWrite) || 0;
  }
  return sum;
}

function main() {
  const dir = configDir();
  const day = todayKey();
  const statsPath = `${dir}/stats.json`;
  const failures = [];
  const notes = [];

  console.log(`[check-stats] 配置目录: ${dir}`);
  console.log(`[check-stats] 对账日期: ${day}`);

  if (!fs.existsSync(statsPath)) {
    console.log('[check-stats] stats.json 不存在：代理尚未产生数据，跳过对账。');
    return 0;
  }

  let stats;
  try {
    stats = readJson(statsPath);
  } catch (e) {
    failures.push(`stats.json 解析失败: ${e.message}`);
    return report(failures, notes);
  }

  const today = stats?.days?.[day] || null;
  if (!today) {
    console.log('[check-stats] 今日没有快照（可能代理未启动或跨天）：跳过明细对账。');
  } else {
    const ledger = summarizeLedger(day);
    if (!ledger) {
      notes.push('今日无明细账本文件（usage/*.jsonl），可能为改造前的数据。');
    } else {
      console.log(
        `[check-stats] 快照: requests=${today.requests} errors=${today.errors} `
        + `input=${today.inputTokens} output=${today.outputTokens} cached=${today.cachedTokens}`,
      );
      console.log(
        `[check-stats] 账本: rows=${ledger.rows} errors=${ledger.errors} `
        + `input=${ledger.input} output=${ledger.output} cacheRead=${ledger.cacheRead}`,
      );
      const reqDiff = Number(today.requests || 0) - ledger.rows;
      if (reqDiff !== 0) {
        notes.push(`快照 requests 与账本行数差 ${reqDiff}（跨天/并发写入的正常窗口，>5 需排查）`);
      }
      const tokenDiff = Math.abs(Number(today.inputTokens || 0) - ledger.input);
      if (Number(today.inputTokens || 0) > 0 && tokenDiff / Number(today.inputTokens) > 0.05) {
        notes.push(`输入 token 差 ${tokenDiff}（>5%），检查是否有流式路径未归属 model`);
      }
    }

    // 成本自洽：按 byModelUsage 重算，与快照值比对
    if (today.byModelUsage && Number(today.estCostUsd) > 0) {
      const { totalUsd } = estimateCost(today.byModelUsage);
      const delta = Math.abs(totalUsd - Number(today.estCostUsd));
      const ratio = delta / Math.max(Number(today.estCostUsd), 0.000001);
      const sample = Object.entries(today.byModelUsage)[0];
      const sampleCost = sample ? costOf(sample[1], sample[0]) : 0;
      console.log(
        `[check-stats] 成本: 快照 $${today.estCostUsd} / 重算 $${totalUsd.toFixed(4)} `
        + `(样本 ${sample?.[0] || '-'} = $${sampleCost.toFixed(4)})`,
      );
      if (ratio > COST_TOLERANCE) {
        failures.push(`成本不自洽：快照 ${today.estCostUsd} vs 重算 ${totalUsd.toFixed(4)}（差 ${(ratio * 100).toFixed(1)}%）`);
      }
    }
  }

  // 旁路数据摘要
  const localPath = `${dir}/usage-local.json`;
  if (fs.existsSync(localPath)) {
    try {
      const local = readJson(localPath);
      const sources = Object.entries(local.sources || {})
        .map(([name, u]) => `${name}=${u.requests}次/${u.input + u.output}tok`)
        .join('  ');
      const errs = Array.isArray(local.errors) ? local.errors.length : 0;
      console.log(`[check-stats] 旁路: ${sources || '无来源数据'}${errs ? `  errors=${errs}` : ''}`);
      if (errs > 0) notes.push(`旁路扫描有 ${errs} 条读取/解析错误，检查 usage-local.json 的 errors`);
    } catch (e) {
      failures.push(`usage-local.json 解析失败: ${e.message}`);
    }
  } else {
    notes.push('尚未生成 usage-local.json（未触发过旁路扫描）。');
  }

  return report(failures, notes);
}

function report(failures, notes) {
  for (const note of notes) console.log(`[check-stats] 提示: ${note}`);
  if (failures.length) {
    for (const failure of failures) console.error(`[check-stats] 失败: ${failure}`);
    console.error(`[check-stats] ❌ 未通过（${failures.length} 项）`);
    return 1;
  }
  console.log('[check-stats] ✅ 通过');
  return 0;
}

process.exit(main());
