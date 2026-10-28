// 统计页渲染链回归测试。
//
// 为什么要有它：统计页曾出现「KPI 有数字、图表空白、排行与数据源停在占位文案」。
// 根因是 renderStatsAll 串行调用时，ECharts 的 yAxis formatter 引用了被删掉的
// fmtMetric，setOption 内抛 ReferenceError 让整条链从中间中断——所有面板都停在
// 初始 HTML，看上去像「没数据」。肉眼看页面只能看到结果，看不到中断点。
//
// 这里用 jsdom + 最小 ECharts 桩把真实模块跑一遍，断言每个面板都真正产出了内容，
// 且没有任何面板进入错误态。桩会在 setOption 时主动执行 formatter，从而把这类
// 「闭包内引用未定义函数」的错误暴露在测试里，而不是等用户截图发现。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'ui/assets/scripts/67-stats.js'), 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

const setOptionCalls = [];

window.echarts = {
  version: 'stub',
  init(el) {
    // 真实 ECharts 会在容器上打实例标记；不打的话测不出「占位文案未清理」
    el.setAttribute('_echarts_instance_', 'stub');
    return {
      setOption(option) {
        // 主动执行坐标轴 formatter：真实引擎也会在 setOption 期间跑它
        const axes = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis];
        for (const axis of axes) {
          const format = axis?.axisLabel?.formatter;
          if (typeof format === 'function') format(1_234_567);
        }
        setOptionCalls.push(option);
      },
      resize() {},
      dispose() {},
      getWidth() {
        return 800;
      },
    };
  },
  graphic: {
    LinearGradient: function LinearGradient() {
      return { __gradient: true };
    },
  },
};

const days = [
  {
    day: '2026-10-26',
    requests: 120,
    errors: 2,
    inputTokens: 100_000,
    outputTokens: 20_000,
    cachedTokens: 50_000,
    estCostUsd: 0.42,
    byModelUsage: { 'claude-sonnet-4': { input: 100_000, output: 20_000, cacheRead: 50_000, cacheWrite: 0 } },
  },
  {
    day: '2026-10-27',
    requests: 80,
    errors: 0,
    inputTokens: 60_000,
    outputTokens: 15_000,
    cachedTokens: 30_000,
    estCostUsd: 0.28,
    byModelUsage: { 'gemini-3.8-flash-high': { input: 60_000, output: 15_000, cacheRead: 30_000, cacheWrite: 0 } },
  },
];

const localUsage = {
  version: 1,
  scannedAt: Date.now(),
  days: {},
  cursorDays: {},
  cpaDays: {
    '2026-10-27': {
      'gemini-3.8-flash-high': { requests: 900, input: 900_000, output: 90_000, cache_read: 400_000, cache_write: 0 },
    },
  },
  cpaAccounts: [
    { account: 'alpha@example.com', provider: 'claude', requests: 500, failed: 3, input: 500_000, output: 50_000, cacheRead: 200_000, cacheWrite: 0 },
    { account: 'beta@example.com', provider: 'gemini', requests: 400, failed: 0, input: 400_000, output: 40_000, cacheRead: 200_000, cacheWrite: 0 },
  ],
  sources: {
    cpa: { requests: 900, input: 900_000, output: 90_000, cacheRead: 400_000, cacheWrite: 0 },
    'claude-code': { requests: 42, input: 42_000, output: 4_200, cacheRead: 0, cacheWrite: 0 },
  },
  files: {},
  errors: [],
};

const snapshot = {
  requests: 200,
  errors: 2,
  inputTokens: 160_000,
  outputTokens: 35_000,
  cachedTokens: 80_000,
  cacheCreationInputTokens: 0,
  estCostUsd: 0.7,
  byModelUsage: {},
  byModel: {},
  recent: [
    {
      ts: Date.now(),
      type: 'request',
      provider: 'CPA',
      requestedModel: 'gemini-3-8-flash-high',
      resolvedModel: 'gemini-3.8-flash-high',
    },
  ],
};

globalThis.invoke = window.invoke = async (command) => {
  if (command === 'get_stats') return snapshot;
  if (command === 'get_stats_history') return { days };
  if (command === 'get_local_usage') return localUsage;
  if (command === 'scan_local_usage') return localUsage;
  throw new Error(`未预期的命令: ${command}`);
};

// 被测模块在顶层就访问 document 与 window，导入前必须把 jsdom 的全局铺好
globalThis.window = window;
globalThis.document = window.document;

const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const loadStats = globalThis.loadStats || mod.loadStats;
assert.equal(typeof loadStats, 'function', '统计数据入口必须导出，否则页面永远停在占位状态');

await loadStats();
await new Promise((resolve) => setTimeout(resolve, 150));

const doc = window.document;
const chartHost = doc.getElementById('mainTrendEcharts');
const rankHost = doc.getElementById('statsRankTable');
const sourcesHost = doc.getElementById('statsSourcesDeck');
const recentBody = doc.getElementById('statsRecentTbody');

assert.ok(setOptionCalls.length > 0, '主图表必须真正调用 setOption（否则 ECharts 从未渲染）');
assert.doesNotMatch(chartHost.innerHTML, /正在初始化|渲染失败/, '主图表的占位文案必须被清掉');
assert.ok(rankHost.querySelectorAll('.ez-rank-item').length > 0, '排行榜必须渲染出条目');
assert.doesNotMatch(rankHost.innerHTML, /暂无排行数据/, '排行榜不得停留在空占位');
assert.ok(sourcesHost.querySelectorAll('.ez-channel-card').length > 0, '数据源卡片必须渲染');
assert.doesNotMatch(sourcesHost.innerHTML, /正在检查通道数据/, '数据源不得停留在「正在检查」假加载态');
assert.match(recentBody.innerHTML, /gemini-3-8-flash-high/, '最近请求必须展示「请求模型 → 实际模型」');
assert.doesNotMatch(doc.body.innerHTML, /渲染失败/, '任何面板都不应进入错误态');

// ── 热插拔场景：CPA 未安装（sources 无 cpa、无账号）时，入口必须自动隐藏 ──
const cpaFilterBtn = doc.querySelector('#page-stats [data-stats-source-filter="cpa"]');
const accountRankBtn = doc.querySelector('#page-stats [data-stats-rank="account"]');
assert.equal(cpaFilterBtn.hidden, false, '有 CPA 数据时来源筛选必须可见');

const withoutCpa = {
  ...localUsage,
  sources: { 'claude-code': localUsage.sources['claude-code'] },
  cpaDays: {},
  cpaAccounts: [],
};
globalThis.invoke = window.invoke = async (command) => {
  if (command === 'get_stats') return snapshot;
  if (command === 'get_stats_history') return { days };
  if (command === 'get_local_usage') return withoutCpa;
  if (command === 'scan_local_usage') return withoutCpa;
  throw new Error(`未预期的命令: ${command}`);
};

await loadStats();
await new Promise((resolve) => setTimeout(resolve, 150));

assert.equal(
  doc.querySelector('#page-stats [data-stats-source-filter="cpa"]').hidden,
  true,
  'CPA 未安装时来源筛选必须自动隐藏（热插拔）',
);
assert.equal(
  doc.querySelector('#page-stats [data-stats-rank="account"]').hidden,
  true,
  'CPA 未安装时「CPA 账号」排行 tab 必须自动隐藏（热插拔）',
);
assert.match(
  doc.getElementById('statsSourcesDeck').innerHTML,
  /Claude Code/,
  '仍存在的数据源卡片必须正常渲染',
);

console.log('统计页渲染链：全部断言通过（含热插拔场景）');
