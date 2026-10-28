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

// 首屏必须是骨架屏，不能先甩一句「暂无排行数据」——那是把加载态说成空态。
assert.match(html, /ez-skel-chart/, '首屏必须渲染图表骨架');
assert.match(html, /ez-skel-rank/, '首屏必须渲染排行骨架');
assert.doesNotMatch(html, /暂无排行数据/, '首屏不得显示「暂无排行数据」当加载态');

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
  // 故意带上 cursor，验证「所有扫到的来源都能被选中」，而不是只有写死的那几个
  sources: {
    cpa: { requests: 900, input: 900_000, output: 90_000, cacheRead: 400_000, cacheWrite: 0 },
    'claude-code': { requests: 42, input: 42_000, output: 4_200, cacheRead: 0, cacheWrite: 0 },
    cursor: { requests: 7, input: 7_000, output: 700, cacheRead: 0, cacheWrite: 0 },
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

// 采集开关的服务端状态：测试里用内存对象代替 byok-config.json
const settingsState = { disabledSources: [], availableSources: ['claude-code', 'cursor', 'cpa'] };
let lastSetPayload = null;

function makeInvoke({ local }) {
  return async (command, args) => {
    if (command === 'get_stats') return snapshot;
    if (command === 'get_stats_history') return { days };
    if (command === 'get_local_usage') return local;
    if (command === 'scan_local_usage') return local;
    if (command === 'get_stats_settings') return settingsState;
    if (command === 'set_stats_settings') {
      lastSetPayload = args;
      settingsState.disabledSources = args.disabledSources;
      return settingsState;
    }
    throw new Error(`未预期的命令: ${command}`);
  };
}

globalThis.invoke = window.invoke = makeInvoke({ local: localUsage });

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

// 骨架屏必须在数据到达后彻底消失，且加载态标记要摘掉
assert.equal(doc.querySelectorAll('#page-stats .ez-skel-bone').length, 0, '数据到达后骨架必须全部清除');
assert.equal(
  doc.getElementById('page-stats').classList.contains('stats-loading'),
  false,
  '渲染完成后必须摘掉 stats-loading 标记',
);

// ── 来源筛选器必须由「实际扫到的来源」动态生成 ──
const filterValues = () => [...doc.querySelectorAll('#page-stats [data-stats-source-filter]')]
  .map((b) => b.getAttribute('data-stats-source-filter'));

const initialFilters = filterValues();
assert.deepEqual(initialFilters, ['all', 'gateway', 'claude-code', 'cursor', 'cpa'], '来源筛选必须覆盖全部已扫到的来源（含 Cursor）');

// 选 Cursor 后，图表数据必须真的切到 cursorDays（选中即生效）
const cursorBtn = doc.querySelector('#page-stats [data-stats-source-filter="cursor"]');
cursorBtn.click();
await new Promise((resolve) => setTimeout(resolve, 80));
assert.ok(cursorBtn.classList.contains('active'), '点击后 Cursor 必须成为选中态');
const cursorKpi = doc.getElementById('statsKpiTokens').textContent;
assert.ok(cursorKpi && cursorKpi !== '—', `选中 Cursor 后 KPI 必须出数（当前 ${cursorKpi}）`);

// KPI 脚注必须跟着来源走，不能是写死的一句话
assert.match(
  doc.getElementById('statsKpiRequestsSub').textContent,
  /仅 Cursor/,
  '请求数脚注必须写明当前来源',
);
assert.match(
  doc.getElementById('statsKpiCostSub').textContent,
  /未计费/,
  '非网关来源不得声称「含网关直连」',
);
assert.match(
  doc.getElementById('statsKpiSuccessSub').textContent,
  /仅网关可算成功率/,
  '非网关视图必须说明成功率口径',
);

// Token 比例条必须配图例，否则单色横线读不出含义
assert.equal(
  doc.querySelectorAll('#statsTokenLegend .ez-token-legend-item').length,
  3,
  'Token 构成必须有输入/输出/缓存三条图例',
);

// ── 采集设置：能列出真实存在的来源，并且开关真的落盘 ──
doc.getElementById('statsSettingsBtn').click();
const settingsBody = doc.getElementById('statsSettingsBody');
assert.equal(
  settingsBody.querySelectorAll('.ez-setting-row').length,
  3,
  '采集设置必须列出本机存在的 3 个旁路来源',
);
const cpaToggle = settingsBody.querySelector('[data-stats-source-toggle="cpa"]');
assert.equal(cpaToggle.getAttribute('aria-checked'), 'true', '默认应处于开启采集状态');
assert.ok(cpaToggle.classList.contains('on'), '开启态需带 on 样式');

cpaToggle.click();
await new Promise((resolve) => setTimeout(resolve, 120));
assert.deepEqual(lastSetPayload?.disabledSources, ['cpa'], '关闭 CPA 采集必须写入 disabledSources');
assert.equal(
  doc.querySelector('#page-stats [data-stats-source-toggle="cpa"]').getAttribute('aria-checked'),
  'false',
  '重渲染后开关必须反映已关闭',
);

// ── 热插拔场景：CPA 未安装（sources 无 cpa、无账号、无日期桶） ──
const withoutCpa = {
  ...localUsage,
  sources: {
    'claude-code': localUsage.sources['claude-code'],
    cursor: localUsage.sources.cursor,
  },
  cpaDays: {},
  cpaAccounts: [],
};
globalThis.invoke = window.invoke = makeInvoke({ local: withoutCpa });

await loadStats();
await new Promise((resolve) => setTimeout(resolve, 150));

assert.equal(
  doc.querySelector('#page-stats [data-stats-source-filter="cpa"]'),
  null,
  'CPA 未安装时不该出现 CPA 筛选按钮（热插拔）',
);
assert.ok(filterValues().includes('cursor'), 'CPA 卸载后其余来源必须照常可选');
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

console.log('统计页渲染链：全部断言通过（含来源动态筛选与热插拔场景）');
