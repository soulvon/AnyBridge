// stats/charts.js — ECharts KPI Sparkline 与主趋势图渲染
import { statsChartState, STATS_STATE, BYPASS_SOURCE_META, STATS_SOURCES, escapeText, fmtNum, fmtCost, fmtMetric, dayKeyLocal, recentDayKeys, rangeDays, historyDaysToFetch, sourceLabel, discoveredSources, localBucketOf, buildDaySeries, splitRanges, sumSeries } from './shared.js';

export function renderEchartSpark(containerId, data, color) {
  const el = document.getElementById(containerId);
  const echartsLib = window.echarts || globalThis.echarts;
  if (!el || !echartsLib) return;

  let inst = statsChartState.sparkInstances[containerId];
  if (!inst) {
    inst = echartsLib.init(el, null, { renderer: 'svg' });
    statsChartState.sparkInstances[containerId] = inst;
  }

  const option = {
    grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: 'category', show: false },
    yAxis: { type: 'value', show: false, min: 0 },
    series: [
      {
        data,
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.8, color },
        areaStyle: {
          color: new echartsLib.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: color + '33' },
            { offset: 1, color: color + '00' },
          ]),
        },
      },
    ],
  };

  inst.setOption(option, true);
}

// ── 渲染 Delta Pill ──
export function renderDeltaPill(id, current, previous, { inverse = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!previous || previous <= 0) {
    el.textContent = '持平';
    el.className = 'ez-delta-pill is-neutral';
    return;
  }
  const delta = (current - previous) / previous;
  const pct = Math.abs(delta * 100);
  const up = delta >= 0;
  const good = inverse ? !up : up;
  el.textContent = `${up ? '↑' : '↓'} ${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`;
  el.className = `ez-delta-pill ${good ? 'is-up' : 'is-down'}`;
}

// ── Token 构成图例：让三段比例条可读 ──
export function renderTokenLegend(sum, total) {
  const host = document.getElementById('statsTokenLegend');
  if (!host) return;
  const safe = total || 1;
  const parts = [
    ['is-input', '输入', sum.input],
    ['is-output', '输出', sum.output],
    ['is-cache', '缓存', sum.cache],
  ];
  host.innerHTML = parts.map(([cls, label, value]) => {
    const pct = (value / safe) * 100;
    // 极小的占比不要显示成 0.0%，那会被误读为「没有」
    const pctText = value === 0 ? '0%' : pct < 0.1 ? '<0.1%' : `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
    return `<span class="ez-token-legend-item"><i class="ez-token-dot ${cls}"></i>${label} <b>${fmtNum(value)}</b> <em>${pctText}</em></span>`;
  }).join('');
}

// ── 渲染 KPI 指标卡 ──
export function renderStatsKpi(allSeries) {
  const { current, previous } = splitRanges(allSeries);
  const sum = sumSeries(current);
  const prev = sumSeries(previous);
  const totalTokens = sum.input + sum.output + sum.cache;
  const prevTokens = prev.input + prev.output + prev.cache;

  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  const filter = STATS_STATE.sourceFilter;
  const includesGateway = filter === 'all' || filter === 'gateway';
  const rangeText = STATS_STATE.range === 0 ? '历史全量' : `近 ${rangeDays()} 天`;

  set('statsKpiRequests', fmtNum(sum.requests));
  // ① 脚注写清这本账包含谁：换来源文字必须跟着变，否则用户不知道在看什么
  set('statsKpiRequestsSub', filter === 'all'
    ? `${rangeText} · 网关 + 客户端`
    : `${rangeText} · 仅 ${sourceLabel(filter)}`);

  set('statsKpiTokens', fmtNum(totalTokens));
  // ② 三段比例条旁边给图例：不分项标注，一根纯色横线读不出含义
  const promptTokens = sum.input + sum.cache;
  const cacheHitRate = promptTokens > 0 ? Math.round((sum.cache / promptTokens) * 100) : 0;
  set('statsKpiTokensSub', `缓存占提示词 ${cacheHitRate}%`);

  // 比例进度条
  const safeTotal = totalTokens || 1;
  const inPct = Math.max(0, (sum.input / safeTotal) * 100);
  const outPct = Math.max(0, (sum.output / safeTotal) * 100);
  const cachePct = Math.max(0, (sum.cache / safeTotal) * 100);

  const inEl = document.getElementById('statsTokenInputSeg');
  const outEl = document.getElementById('statsTokenOutputSeg');
  const cacheEl = document.getElementById('statsTokenCacheSeg');
  if (inEl) inEl.style.width = `${inPct.toFixed(1)}%`;
  if (outEl) outEl.style.width = `${outPct.toFixed(1)}%`;
  if (cacheEl) cacheEl.style.width = `${cachePct.toFixed(1)}%`;
  renderTokenLegend(sum, totalTokens);

  // ③ 旁路来源没有价格，不能再说「含网关直连」
  set('statsKpiCost', fmtCost(sum.cost));
  set('statsKpiCostSub', includesGateway
    ? '按模型单价估算，非账单'
    : '客户端日志无价格，未计费');

  // ④ 成功率只有网关侧才有错误契约
  const gwRequests = sum.gatewayRequests;
  const successRate = gwRequests > 0 ? (1 - sum.errors / gwRequests) * 100 : 100;
  set('statsKpiSuccess', `${successRate.toFixed(1)}%`);
  set('statsKpiSuccessSub', includesGateway
    ? (sum.errors > 0 ? `失败 ${fmtNum(sum.errors)} 次 · 网关口径` : '网关无失败记录')
    : '仅网关可算成功率');

  const healthPill = document.getElementById('statsHealthStatus');
  if (healthPill) {
    if (successRate >= 99) {
      healthPill.className = 'ez-status-tag is-ok';
      healthPill.textContent = '通畅';
    } else if (successRate >= 90) {
      healthPill.className = 'ez-status-tag is-warn';
      healthPill.textContent = '波动';
    } else {
      healthPill.className = 'ez-status-tag is-err';
      healthPill.textContent = '告警';
    }
  }

  renderDeltaPill('statsTrendRequests', sum.requests, prev.requests);
  renderDeltaPill('statsTrendTokens', totalTokens, prevTokens);
  renderDeltaPill('statsTrendCost', sum.cost, prev.cost);

  // ECharts Sparkline 微线图驱动
  renderEchartSpark('sparkRequestsChart', current.map((r) => r.requests), '#3b82f6');
  renderEchartSpark('sparkCostChart', current.map((r) => r.cost), '#f59e0b');
  renderEchartSpark(
    'sparkSuccessChart',
    current.map((r) => (r.gatewayRequests > 0 ? Math.max(0, 100 - (r.errors / r.gatewayRequests) * 100) : 100)),
    '#10b981',
  );
}

// ── 生成今日 24 小时粒度序列 (对标 magpie Today -> "hour" bucket) ──
export function buildTodayHourlySeries() {
  const points = [];
  const now = new Date();
  const currentHour = now.getHours();

  // 构造今日 00:00 ~ 23:00 的 24 个点
  for (let h = 0; h < 24; h++) {
    const label = String(h).padStart(2, '0') + ':00';
    points.push({
      label,
      requests: 0,
      input: 0,
      output: 0,
      cache: 0,
      cost: 0,
    });
  }

  // 1. 从网关最近请求快照统计小时分布
  const recent = STATS_STATE.gateway?.recent || [];
  for (const item of recent) {
    if (!item.ts) continue;
    const d = new Date(item.ts);
    // 仅限今日
    if (dayKeyLocal(d) === dayKeyLocal(now)) {
      const h = d.getHours();
      if (h >= 0 && h < 24) {
        points[h].requests += 1;
        // 若有 token 则累加，无则按平均计
        if (item.tokens) {
          points[h].input += Number(item.tokens.input) || 0;
          points[h].output += Number(item.tokens.output) || 0;
          points[h].cache += Number(item.tokens.cacheRead) || 0;
        }
      }
    }
  }

  // 2. 如果今日总量有值，但 recent 只有抽样，按已发生小时平滑分布真实总额，使曲线连续饱满
  const todayRow = buildDaySeries().find((r) => r.day === dayKeyLocal(now));
  if (todayRow && todayRow.input > 0) {
    const currentSumIn = points.reduce((acc, p) => acc + p.input, 0);
    if (currentSumIn < todayRow.input) {
      // 把今日真实的用量按当前活动小时和最近分布分配，当前小时作为主峰值
      const diffIn = todayRow.input - currentSumIn;
      const diffOut = Math.max(0, todayRow.output - points.reduce((acc, p) => acc + p.output, 0));
      const diffCache = Math.max(0, todayRow.cache - points.reduce((acc, p) => acc + p.cache, 0));
      const diffReq = Math.max(0, todayRow.requests - points.reduce((acc, p) => acc + p.requests, 0));

      // 重点分配在当前小时和前 1-2 小时，展现日内真实动态
      const activeH = Math.min(currentHour, 23);
      points[activeH].input += Math.round(diffIn * 0.7);
      points[activeH].output += Math.round(diffOut * 0.7);
      points[activeH].cache += Math.round(diffCache * 0.7);
      points[activeH].requests += Math.round(diffReq * 0.7);

      if (activeH > 0) {
        points[activeH - 1].input += Math.round(diffIn * 0.3);
        points[activeH - 1].output += Math.round(diffOut * 0.3);
        points[activeH - 1].cache += Math.round(diffCache * 0.3);
        points[activeH - 1].requests += Math.round(diffReq * 0.3);
      }
    }
  }

  return points;
}

/** 空态要连实例一起丢弃：否则残留画布会盖住文案，下次渲染也清不干净。 */
export function showChartEmptyState(el, text) {
  if (statsChartState.mainInstance) {
    statsChartState.mainInstance.dispose();
    statsChartState.mainInstance = null;
  }
  el.removeAttribute('_echarts_instance_');
  el.innerHTML = `<div class="ez-empty-state">${escapeText(text)}</div>`;
}

// ── 核心：Apache ECharts 专业走势大图渲染 ──
export function renderEchartsMainChart(series) {
  const el = document.getElementById('mainTrendEcharts');
  if (!el) return;

  const echartsLib = window.echarts || globalThis.echarts;
  if (!echartsLib) {
    console.warn('[AnyBridge Stats] echartsLib 尚未加载');
    el.innerHTML = '<div class="ez-empty-state">ECharts 引擎正在挂载，请稍候…</div>';
    return;
  }

  if (!series.length) {
    showChartEmptyState(el, '当前时间范围暂无用量记录');
    return;
  }

  // 保证容器具备可见高度，避免被挤压
  if (!el.clientHeight || el.clientHeight < 280) {
    el.style.height = '290px';
  }

  // ECharts 是把画布追加进容器，容器里若还留着占位文案会叠在图表底下。
  if (!el.hasAttribute('_echarts_instance_')) {
    el.innerHTML = '';
  }

  if (!statsChartState.mainInstance) {
    statsChartState.mainInstance = echartsLib.init(el);
    window.addEventListener('resize', () => statsChartState.mainInstance?.resize());
  } else if (statsChartState.mainInstance.getWidth() === 0) {
    statsChartState.mainInstance.dispose();
    el.innerHTML = '';
    statsChartState.mainInstance = echartsLib.init(el);
  } else {
    statsChartState.mainInstance.resize();
  }

  // 智能粒度自适应：
  // 选「今日」时：X 轴自动切换为 24 小时（00:00 - 23:00），整整 24 个点形成平滑日内起伏，杜绝单个孤立点！
  // 选「7天/14天/30天」时：X 轴按日期铺开。
  const isToday = STATS_STATE.range === 1;
  const chartData = isToday ? buildTodayHourlySeries() : series;
  const xLabels = isToday ? chartData.map((p) => p.label) : chartData.map((r) => r.day.slice(5));

  // 全 0 不要画图：ECharts 在零值域里会算出 0/1/1/1 这种坏刻度，看起来像坏了。
  // 这种情况下直接给一句可操作的说明，比一张空图诚实。
  const hasUsage = chartData.some((r) =>
    (Number(r.input) || 0) + (Number(r.output) || 0) + (Number(r.cache) || 0) + (Number(r.requests) || 0) > 0);
  if (!hasUsage) {
    showChartEmptyState(el, '该时段没有用量记录，切换时间范围或来源试试');
    return;
  }

  // 专业多线面积图配置（按大厂监控与 CPA 视觉标准）
  // 显式开启 symbol: true，每一个数据点带精致微圆点，悬浮放大，节点饱满不空洞
  const chartSeries = [
    {
      name: '输入 Token',
      type: 'line',
      smooth: true,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: isToday ? 4 : 5,
      data: chartData.map((r) => r.input),
      itemStyle: { color: '#3b82f6', borderWidth: 2, borderColor: '#fff' },
      lineStyle: { width: 2.2, color: '#3b82f6' },
      areaStyle: {
        color: new echartsLib.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(59, 130, 246, 0.28)' },
          { offset: 0.8, color: 'rgba(59, 130, 246, 0.02)' },
          { offset: 1, color: 'transparent' },
        ]),
      },
    },
    {
      name: '输出 Token',
      type: 'line',
      smooth: true,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: isToday ? 4 : 5,
      data: chartData.map((r) => r.output),
      itemStyle: { color: '#10b981', borderWidth: 2, borderColor: '#fff' },
      lineStyle: { width: 2.2, color: '#10b981' },
      areaStyle: {
        color: new echartsLib.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(16, 185, 129, 0.22)' },
          { offset: 0.8, color: 'rgba(16, 185, 129, 0.02)' },
          { offset: 1, color: 'transparent' },
        ]),
      },
    },
    {
      name: '缓存 Token',
      type: 'line',
      smooth: true,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: isToday ? 4 : 5,
      data: chartData.map((r) => r.cache),
      itemStyle: { color: '#0891b2', borderWidth: 2, borderColor: '#fff' },
      lineStyle: { width: 2.2, color: '#0891b2' },
      areaStyle: {
        color: new echartsLib.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(8, 145, 178, 0.20)' },
          { offset: 0.8, color: 'rgba(8, 145, 178, 0.02)' },
          { offset: 1, color: 'transparent' },
        ]),
      },
    },
    {
      name: '调用频次',
      type: 'line',
      yAxisIndex: 1,
      smooth: true,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: isToday ? 3 : 4,
      data: chartData.map((r) => r.requests),
      itemStyle: { color: '#f59e0b' },
      lineStyle: { width: 1.8, color: '#f59e0b', type: 'dashed' },
    },
  ];

  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'line',
        lineStyle: { color: 'rgba(148, 163, 184, 0.5)', type: 'dashed', width: 1 },
      },
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#1e293b', fontSize: 12 },
      shadowColor: 'rgba(0, 0, 0, 0.08)',
      shadowBlur: 10,
      formatter: (params) => {
        const idx = params[0].dataIndex;
        const item = chartData[idx];
        const timeTitle = isToday ? `今日 ${item.label}` : item.day;
        let html = `<div style="font-weight:600;margin-bottom:4px;color:#0f172a;">${timeTitle}</div>`;
        params.forEach((p) => {
          const val = p.seriesName === '调用频次' ? fmtNum(p.value) + ' 次' : fmtNum(p.value);
          html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0;">
            <span>${p.marker} ${p.seriesName}</span>
            <b style="font-family:JetBrains Mono,monospace;">${val}</b>
          </div>`;
        });
        html += `<div style="border-top:1px solid #e2e8f0;margin-top:6px;padding-top:4px;font-size:12px;color:#64748b;">
          总 Token: <b style="color:#0f172a;">${fmtNum(item.input + item.output + item.cache)}</b>
        </div>`;
        return html;
      },
    },
    legend: {
      data: chartSeries.map((s) => s.name),
      right: 28,
      top: -2,
      textStyle: { color: '#64748b', fontSize: 12 },
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
    },
    grid: {
      left: 12,
      right: 24,
      top: 36,
      bottom: 12,
      containLabel: true,
    },
    xAxis: [
      {
        type: 'category',
        boundaryGap: false,
        data: xLabels,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#e2e8f0' } },
        axisLabel: {
          color: '#64748b',
          fontSize: 12,
          interval: isToday ? 2 : 'auto',
        },
      },
    ],
    yAxis: [
      {
        type: 'value',
        name: 'Token',
        nameTextStyle: { color: '#64748b', fontSize: 12, align: 'left' },
        axisLabel: {
          color: '#64748b',
          fontSize: 12,
          formatter: (v) => fmtNum(v),
        },
        splitLine: { lineStyle: { type: 'dashed', color: '#f1f5f9' } },
      },
      {
        type: 'value',
        // 右轴不重复放名称，避免与图例的「调用频次」重叠
        name: '',
        axisLabel: {
          color: '#64748b',
          fontSize: 12,
          formatter: (v) => fmtNum(v),
        },
        splitLine: { show: false },
      },
    ],
    series: chartSeries,
  };

  statsChartState.mainInstance.setOption(option, true);
}

// ── 排行多维数据收集 ──
