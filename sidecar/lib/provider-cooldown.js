// provider-cooldown.js — 失败目标冷却（熔断）
//
// 目标：某个上游目标确认不可用后，后续请求不再白白打它一次再失败。
//
// 设计要点：
//   1. 粒度 = providerId|model。供应商下某个模型挂了不该连坐其他模型。
//   2. 错误类型决定基础冷却时长，而不是一刀切：
//      - 鉴权/权限/模型不存在：一次失败即按 authSeconds 冷却（默认 600s）
//      - 瞬时错误（5xx / 超时 / 网络）：按 transientSeconds 起（默认 60s），
//        反复冷却每轮 ×2，封顶 maxSeconds（默认 600s）
//      - 429 限流、400 类请求级错误、客户端主动断开：不冷却
//   3. 冷却到期后自然放行（半开）；成功即清除记录，失败则轮次 +1。
//   4. 全部目标都在冷却时仍按解冻时间从早到晚返回全量，请求不被阻断。
//
// 状态只存内存：sidecar 重启即清空，配置变更时由调用方 clearAll()。

const DEFAULTS = Object.freeze({
  enabled: true,
  transientSeconds: 60,
  maxSeconds: 600,
  authSeconds: 600,
});

// 鉴权/权限/目标不存在：短时间内不会自愈
const AUTH_STATUS = new Set([401, 402, 403, 404]);
// 请求自身的问题（超长上下文、参数不合法）或限流：不该惩罚节点
const SKIP_STATUS = new Set([400, 409, 413, 415, 422, 425, 429]);
const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529]);
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_NETWORK', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);
const AUTH_TEXT = /model[_ ]?not[_ ]?found|unknown[_ ]?model|model.*(not available|does not exist)|invalid[_ ]?api[_ ]?key|unauthorized|forbidden|permission[_ ]?denied|无权限|未开通|不存在/i;
const TRANSIENT_TEXT = /timeout|timed out|socket hang up|econn|epipe|eai_again|network|dns|reset by peer|idle|hard/i;

const state = new Map(); // key -> { until, kind, round, reason, providerName, model, hits }

export function cooldownPolicyFromEnhancement(enhancement = {}) {
  const max = Number(enhancement.cooldownMaxSeconds);
  return {
    enabled: enhancement.cooldownEnabled !== false,
    transientSeconds: Number.isFinite(Number(enhancement.cooldownTransientSeconds))
      ? Number(enhancement.cooldownTransientSeconds) : DEFAULTS.transientSeconds,
    maxSeconds: Number.isFinite(max) ? max : DEFAULTS.maxSeconds,
    authSeconds: Number.isFinite(Number(enhancement.cooldownAuthSeconds))
      ? Number(enhancement.cooldownAuthSeconds) : DEFAULTS.authSeconds,
  };
}

export function targetKey(target) {
  const providerId = String(target?.providerId || target?.provider_id || '').trim();
  const model = String(target?.model || '').trim();
  return `${providerId}|${model}`;
}

/** 失败分类：auth（长期不可用）/ transient（瞬时）/ skip（不冷却）。 */
export function classifyFailure(failure = {}) {
  const status = Number(failure.statusCode || 0);
  if (Number.isFinite(status) && status > 0) {
    if (AUTH_STATUS.has(status)) return 'auth';
    if (SKIP_STATUS.has(status)) return 'skip';
    if (TRANSIENT_STATUS.has(status)) return 'transient';
    if (status >= 500) return 'transient';
  }
  const code = String(failure.code || '').toUpperCase();
  if (TRANSIENT_CODES.has(code)) return 'transient';
  const text = String(failure.reason || '') + ' ' + String(failure.body || '');
  if (TRANSIENT_TEXT.test(text)) return 'transient';
  if (AUTH_TEXT.test(text)) return 'auth';
  return 'skip';
}

function nextDurationMs(kind, round, policy) {
  if (kind === 'auth') return Math.max(0, policy.authSeconds) * 1000;
  const base = Math.max(0, policy.transientSeconds);
  if (base <= 0) return 0;
  return Math.min(policy.maxSeconds, base * Math.pow(2, Math.max(0, round))) * 1000;
}

/**
 * 记录一次目标失败。返回冷却记录（未冷却返回 null）。
 * @param {object} failure { statusCode, code, reason, body, providerName, model }
 */
export function markFailure(key, failure = {}, policy = DEFAULTS) {
  if (!policy.enabled) return null;
  const kind = classifyFailure(failure);
  if (kind === 'skip') return null;
  const prev = state.get(key);
  const round = kind === 'auth' ? 0 : (prev?.round || 0);
  const durationMs = nextDurationMs(kind, round, policy);
  if (durationMs <= 0) return null;
  const record = {
    until: Date.now() + durationMs,
    durationMs,
    kind,
    round: round + 1,
    reason: String(failure.reason || ''),
    statusCode: Number(failure.statusCode || 0) || null,
    providerName: String(failure.providerName || ''),
    model: String(failure.model || ''),
    hits: (prev?.hits || 0) + 1,
  };
  state.set(key, record);
  console.warn(`  🧊 目标冷却 ${Math.round(durationMs / 1000)}s: ${failure.providerName || key}${failure.model ? `/${failure.model}` : ''} (${kind}${record.statusCode ? ` HTTP ${record.statusCode}` : ''}${failure.reason ? ` ${failure.reason}` : ''})`);
  return record;
}

/** 目标成功：清除冷却记录（含半开试探成功）。 */
export function markSuccess(key) {
  if (state.has(key)) state.delete(key);
}

/**
 * 过滤掉冷却中的目标。
 * @returns {{ targets: any[], cooling: Array<{target, remainingMs, record}>, allCooling: boolean }}
 */
export function filterTargets(targets, policy = DEFAULTS) {
  const cooling = [];
  if (!policy.enabled || !Array.isArray(targets) || targets.length < 2) {
    return { targets, cooling, allCooling: false };
  }
  const now = Date.now();
  const alive = [];
  for (const target of targets) {
    const rec = state.get(targetKey(target));
    if (rec && rec.until > now) {
      cooling.push({ target, record: rec, remainingMs: rec.until - now });
    } else {
      alive.push(target);
    }
  }
  if (alive.length > 0) return { targets: alive, cooling, allCooling: false };
  // 全部目标都在冷却：按解冻时间从早到晚仍全部返回，宁可慢也不让请求直接失败。
  const ordered = [...targets].sort((a, b) => {
    const ra = state.get(targetKey(a));
    const rb = state.get(targetKey(b));
    return (ra?.until || 0) - (rb?.until || 0);
  });
  return { targets: ordered, cooling, allCooling: true };
}

export function clearAll() {
  state.clear();
}
