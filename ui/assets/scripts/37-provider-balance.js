/**
 * 供应商余额展示
 *
 * 交互：卡片上手动查询，不自动轮询——几十个供应商全量定时查询会打爆面板接口。
 * 语义（对齐 cc-switch 的双通道错误约定）：
 * - 瞬时失败（网络/超时）：保留上一次成功值，只在旁边标一个「已过期」的时间；
 * - 确定性失败（鉴权/404/格式非法）：立即清空旧值并显示原因，避免旧数字被当成现况。
 */
import { escAttr } from './ui/dom.js';

/**
 * 功能开关：当前不对外展示。
 * 后端命令（query_provider_balance）、解析逻辑与单测全部保留，
 * 需要重新上线时把这里改成 true 即可，无需改其它文件。
 */
globalThis.PROVIDER_BALANCE_UI_ENABLED = false;

const STORAGE_KEY = 'anybridge.providerBalance';
const KEEP_LAST_GOOD_MS = 10 * 60 * 1000;
const BALANCE_TIMEOUT_MS = 20000;

function readBalanceCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeBalanceCache() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(globalThis.providerBalanceMap || {}));
  } catch (_) {
    // 存不下（隐私模式/配额满）不影响本次会话展示，不打断用户
  }
}

globalThis.providerBalanceMap = readBalanceCache();
globalThis.providerBalanceInFlight = new Set();

function balanceUnitText(unit) {
  const raw = String(unit || '').trim();
  if (!raw) return '';
  if (raw === '%') return '%';
  if (raw === 'USD') return '$';
  if (raw === 'CNY' || raw === 'RMB') return '¥';
  return ` ${raw}`;
}

function formatBalanceAmount(value, unit) {
  if (value === null || value === undefined) return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const digits = Math.abs(num) >= 100 ? 0 : 2;
  const prefix = balanceUnitText(unit);
  if (prefix === '%') return `${num.toFixed(digits)}%`;
  if (prefix === '$' || prefix === '¥') return `${prefix}${num.toFixed(digits)}`;
  return `${num.toFixed(digits)}${prefix}`;
}

function balanceSummaryText(result) {
  if (!result) return '';
  if (result.unlimited) return '额度不限';
  const remaining = formatBalanceAmount(result.remaining, result.unit);
  const total = formatBalanceAmount(result.total, result.unit);
  if (remaining && total) return `${remaining} / ${total}`;
  if (remaining) return remaining;
  if (total) return `总额 ${total}`;
  const used = formatBalanceAmount(result.used, result.unit);
  if (used) return `已用 ${used}`;
  return '';
}

function balanceAgeText(at) {
  if (!at) return '';
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const REFRESH_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>`;

/** 卡片里的一行余额区。内置供应商（本地代理 / CPA）没有余额概念，不展示。 */
globalThis.providerBalanceRowHtml = function (provider) {
  if (!provider || !provider.id) return '';
  const state = (globalThis.providerBalanceMap || {})[provider.id];

  if (!state) {
    return `<div class="provider-balance-row">
      <button type="button" class="provider-balance-query" data-action="refreshProviderBalance" data-arg="${escAttr(provider.id)}">查询余额</button>
    </div>`;
  }

  if (state.loading) {
    return `<div class="provider-balance-row is-loading">
      <span class="provider-balance-spinner" aria-hidden="true"></span>
      <span class="provider-balance-text">正在查询余额</span>
    </div>`;
  }

  const result = state.result || null;
  const refreshBtn = `<button type="button" class="provider-balance-refresh" data-action="refreshProviderBalance" data-arg="${escAttr(provider.id)}" title="刷新余额" aria-label="刷新余额">${REFRESH_ICON}</button>`;

  if (result && result.ok) {
    const summary = balanceSummaryText(result) || '已查询';
    const stale = state.transient ? ` · 上次 ${balanceAgeText(state.at)}` : '';
    const title = [
      `通道 ${result.mode || '未知'}`,
      result.latencyMs ? `耗时 ${result.latencyMs}ms` : '',
      result.expiresAt ? `有效期至 ${new Date(result.expiresAt * 1000).toLocaleDateString()}` : '',
      result.message || '',
    ].filter(Boolean).join(' · ');
    return `<div class="provider-balance-row is-ok" title="${escAttr(title)}">
      <span class="provider-balance-text">额度 ${escAttr(summary)}</span>
      <span class="provider-balance-age">${escAttr(stale)}</span>
      ${refreshBtn}
    </div>`;
  }

  // 不支持：中性提示，不要用错误红，避免用户以为是故障
  if (result && result.mode === 'unsupported') {
    return `<div class="provider-balance-row is-unsupported" title="${escAttr(result.message || '')}">
      <span class="provider-balance-text">未提供余额接口</span>
      ${refreshBtn}
    </div>`;
  }

  const reason = (result && result.message) || state.error || '查询失败';
  return `<div class="provider-balance-row is-error" title="${escAttr(reason)}">
    <span class="provider-balance-text">余额查询失败</span>
    ${refreshBtn}
  </div>`;
};

globalThis.refreshProviderBalance = async function (providerId) {
  if (!providerId || !invoke) return;
  if (globalThis.providerBalanceInFlight.has(providerId)) return;

  const provider = (providerStore.providers || []).find((item) => item.id === providerId);
  if (!provider) return;

  const previous = (globalThis.providerBalanceMap || {})[providerId];
  globalThis.providerBalanceInFlight.add(providerId);
  globalThis.providerBalanceMap[providerId] = {
    ...(previous || {}),
    loading: true,
  };
  renderProviders();

  try {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('查询超时')), BALANCE_TIMEOUT_MS);
    });
    const result = await Promise.race([
      // 参数名必须与 Rust 函数签名一致（snake_case），Tauri 不做自动转换
      invoke('query_provider_balance', {
        host: provider.apiHost || '',
        api_key: provider.apiKey || '',
        mode_hint: null,
      }),
      timeout,
    ]);

    const ok = !!(result && result.ok);
    if (ok) {
      globalThis.providerBalanceMap[providerId] = { loading: false, result, at: Date.now(), transient: false };
    } else if (result && result.transient) {
      // 瞬时失败：有上次成功值就继续显示，并标注时间
      const keep = previous && previous.result && previous.result.ok
        && Date.now() - (previous.at || 0) < KEEP_LAST_GOOD_MS;
      globalThis.providerBalanceMap[providerId] = keep
        ? { loading: false, result: previous.result, at: previous.at, transient: true }
        : { loading: false, result, at: Date.now(), transient: true };
    } else {
      globalThis.providerBalanceMap[providerId] = { loading: false, result, at: Date.now(), transient: false };
    }
  } catch (err) {
    // 调用本身失败（命令缺失/超时）：同样按瞬时处理，不抹掉旧值
    const keep = previous && previous.result && previous.result.ok
      && Date.now() - (previous.at || 0) < KEEP_LAST_GOOD_MS;
    globalThis.providerBalanceMap[providerId] = {
      loading: false,
      result: keep ? previous.result : { ok: false, mode: '', message: String(err && err.message ? err.message : err) },
      at: keep ? previous.at : Date.now(),
      transient: true,
    };
  } finally {
    globalThis.providerBalanceInFlight.delete(providerId);
    writeBalanceCache();
    renderProviders();
  }
};

/** 供应商被删除或重建后清掉残留余额，避免张冠李戴。 */
globalThis.pruneProviderBalanceCache = function (aliveIds) {
  const alive = new Set(aliveIds || []);
  let changed = false;
  Object.keys(globalThis.providerBalanceMap || {}).forEach((id) => {
    if (!alive.has(id)) {
      delete globalThis.providerBalanceMap[id];
      changed = true;
    }
  });
  if (changed) writeBalanceCache();
};
