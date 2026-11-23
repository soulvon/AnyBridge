import fs from 'node:fs';
import { normalizeOfficialRequestPayload } from './official-forwarder.js';

const AG_HANDSHAKE_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function resolveAntigravityQuotaPolicy(providersJson = {}) {
  const rawWindow = Number(providersJson?.antigravityContextWindow);
  const defaultContextWindow = Number.isFinite(rawWindow) && rawWindow >= 16384
    ? Math.trunc(rawWindow)
    : 262144;
  const mockCreditsEnabled = providersJson?.antigravityMockCredits !== false;
  return { defaultContextWindow, mockCreditsEnabled };
}

export function mockAntigravityUserQuotaSummary() {
  return {
    userQuotaSummary: {
      quotas: [
        { modelId: 'gemini-2.5-pro', remainingQuota: 1000, resetTime: '2099-01-01T00:00:00Z', status: 'ACTIVE' },
        { modelId: 'gemini-2.5-flash', remainingQuota: 1000, resetTime: '2099-01-01T00:00:00Z', status: 'ACTIVE' },
        { modelId: 'gemini-3-pro', remainingQuota: 1000, resetTime: '2099-01-01T00:00:00Z', status: 'ACTIVE' },
        { modelId: 'claude-3-7-sonnet', remainingQuota: 1000, resetTime: '2099-01-01T00:00:00Z', status: 'ACTIVE' },
      ],
    },
  };
}

export function ensureAntigravityTier(response) {
  try {
    if (!response || typeof response !== 'object') return response;
    const fix = (obj, key) => {
      const t = obj?.[key];
      if (!t || typeof t !== 'object') return;
      delete t.tier;
    };
    fix(response, 'currentTier');
    fix(response, 'userTier');
    return response;
  } catch {
    return response;
  }
}

export function raceOfficialSuccess(entries) {
  return new Promise((resolve) => {
    const list = (entries || []).map((entry) => (
      entry && typeof entry.then === 'function' ? { promise: entry, abort: null } : entry
    ));
    let pending = list.length;
    let settled = false;
    if (pending === 0) { resolve(null); return; }
    const abortLosers = (winnerIdx) => {
      list.forEach((item, idx) => {
        if (idx !== winnerIdx && typeof item?.abort === 'function') {
          try { item.abort(); } catch {}
        }
      });
    };
    list.forEach((entry, idx) => {
      entry.promise.then((r) => {
        pending -= 1;
        if (settled) return;
        if (r && r.statusCode >= 200 && r.statusCode < 300 && r.body && r.body.length > 0) {
          settled = true;
          abortLosers(idx);
          resolve(r);
        } else if (pending === 0) {
          resolve(null);
        }
      }).catch(() => {
        pending -= 1;
        if (!settled && pending === 0) resolve(null);
      });
    });
  });
}

export function logAntigravityHandshake(configDir, line, body) {
  try {
    const dir = configDir();
    const file = `${dir}/ag-handshake.log`;
    let entry = `${new Date().toISOString()} ${line}\n`;
    if (body) {
      const text = body.toString('utf8').slice(0, 2000);
      entry += text + (body.length > 2000 ? '\n…[截断]' : '') + '\n---\n';
    }
    try {
      if (fs.statSync(file).size > AG_HANDSHAKE_LOG_MAX_BYTES) fs.truncateSync(file, 0);
    } catch {}
    fs.appendFileSync(file, entry);
  } catch {}
  console.error(`[antigravity] ${line}`);
}

export async function fetchOfficialAntigravityRawImpl({
  req,
  body,
  pathname,
  officialHosts,
  officialRequestOnce,
  handshakeRetryDelay,
  configDir,
}) {
  const url = new URL(req.url, 'http://localhost');
  const payload = normalizeOfficialRequestPayload(body);
  const started = Date.now();
  const attempt = () => raceOfficialSuccess(
    officialHosts.map((host) => {
      const controller = new AbortController();
      return {
        promise: officialRequestOnce(host, req, payload, pathname, url.search, 6000, controller.signal),
        abort: () => controller.abort(),
      };
    }),
  );
  let ok = await attempt();
  if (!ok) {
    await handshakeRetryDelay();
    ok = await attempt();
  }
  if (!ok) {
    logAntigravityHandshake(configDir, `${pathname} → 全部 host 失败/超时 (${Date.now() - started}ms)`);
    return null;
  }
  const h = ok.headers || {};
  const contentType = String(h['content-type'] || h['Content-Type'] || '');
  logAntigravityHandshake(
    configDir,
    `${pathname} → ${ok.statusCode} ${contentType} (${ok.body.length}B, ${Date.now() - started}ms)`,
    ok.body,
  );
  return { statusCode: ok.statusCode, contentType, body: ok.body };
}

export async function fetchOfficialAntigravityJsonImpl({
  req,
  body,
  pathname,
  officialHosts,
  officialRequestOnce,
  handshakeRetryDelay,
}) {
  const url = new URL(req.url, 'http://localhost');
  const payload = normalizeOfficialRequestPayload(body);
  const attempt = () => raceOfficialSuccess(
    officialHosts.map((host) => {
      const controller = new AbortController();
      return {
        promise: officialRequestOnce(host, req, payload, pathname, url.search, 15000, controller.signal),
        abort: () => controller.abort(),
      };
    }),
  );
  let ok = await attempt();
  if (!ok) {
    await handshakeRetryDelay();
    ok = await attempt();
  }
  if (!ok) return null;
  try {
    const parsed = JSON.parse(ok.body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function mockAntigravityUserInfo() {
  return {
    name: 'AnyBridge User',
    email: 'user@anybridge.local',
    profilePictureUrl: '',
    userTier: {
      id: 'free-tier',
      name: 'Antigravity',
      isDefault: false,
    },
    userSettings: {
      telemetryEnabled: false,
      userDataCollectionForceDisabled: true,
    },
  };
}

export function mockAntigravityAdminControls() {
  return {
    adminControlsApplicable: false,
    featureControls: {
      multiagentControls: {
        boostCommandDisabled: false,
        teamworkPreviewCommandDisabled: false,
      },
    },
  };
}

export function ensureAntigravityAdminControls(response) {
  try {
    if (!response || typeof response !== 'object') return response;
    if (!response.featureControls || typeof response.featureControls !== 'object') {
      response.featureControls = {};
    }
    if (!response.featureControls.multiagentControls || typeof response.featureControls.multiagentControls !== 'object') {
      response.featureControls.multiagentControls = {};
    }
    response.featureControls.multiagentControls.boostCommandDisabled = false;
    response.featureControls.multiagentControls.teamworkPreviewCommandDisabled = false;
    return response;
  } catch {
    return response;
  }
}

export function mockAntigravityUserSettings() {
  return {
    userSettings: {
      telemetryEnabled: false,
      userDataCollectionForceDisabled: true,
    },
  };
}

export function isAntigravityBypassMetricsPath(pathname) {
  const p = String(pathname || '').toLowerCase();
  return p.includes('recordcodeassistmetrics')
    || p.includes('recordtrajectoryanalytics')
    || p.includes('recordclientevent')
    || p.includes('recordsmartchoicesfeedback')
    || p.includes('uploadperformanceprofile')
    || p.includes('checkurlantivirus')
    || p.includes('checkurldenylist');
}

