// sidecar/lib/antigravity/official-forwarder.js — Antigravity 官方 API 转发、硬超时控制与双轮竞速辅助

import https from 'node:https';
import { SHARED_HTTPS_AGENT, httpsAgentFor } from '../../system-proxy.js';

export const OFFICIAL_ANTIGRAVITY_HOSTS = [
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
];
export const OFFICIAL_ANTIGRAVITY_HOST = OFFICIAL_ANTIGRAVITY_HOSTS[0];

// 官方出站单次尝试硬超时：必须覆盖 DNS 解析 / 代理 CONNECT / TLS / 响应全阶段。
// https.request 的 timeout 选项无法约束连接建立期，黑洞网络下会无限挂起并拖死 hybrid 握手。
// 流式响应开始下发后硬超时会被取消，因此这里只影响"连接 + 等待响应头"阶段。
export const OFFICIAL_ATTEMPT_TIMEOUT_MS = 15000;

// 握手转发第二轮竞速前的退避：覆盖 DNS 重解析与代理切换后的连接恢复窗口
const HANDSHAKE_RETRY_DELAY_MS = 700;

export function handshakeRetryDelay() {
  return new Promise(resolve => setTimeout(resolve, HANDSHAKE_RETRY_DELAY_MS));
}

export function normalizeOfficialRequestPayload(body) {
  if (body === undefined || body === null) return Buffer.from('{}', 'utf8');
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

export function officialHeaders(reqHeaders, payload, host) {
  const headers = { ...reqHeaders };
  delete headers.host;
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['content-length'];
  // 不透传压缩协商：Node 手动 https 请求不会自动解压，官方一旦按 gzip/br
  // 返回压缩体，JSON.parse 就会失败，混合模式的官方目录会被整个丢弃。
  // 显式要求明文响应。
  delete headers['accept-encoding'];
  delete headers['Accept-Encoding'];
  headers['accept-encoding'] = 'identity';
  headers.host = host || OFFICIAL_ANTIGRAVITY_HOST;
  if (payload) headers['content-length'] = String(payload.length);
  return headers;
}

/**
 * 官方出站请求的硬超时控制。
 *
 * https.request 的 timeout 选项只覆盖 socket 空闲阶段，DNS 解析、代理 CONNECT
 * 隧道建立均不受其约束；这里用 AbortController 在全生命周期强制中断。
 */
export function officialRequestWithHardTimeout(host, options, payload, onResponse, timeoutMs, externalSignal = null) {
  return new Promise((resolve) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const onExtAbort = () => abort.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      externalSignal.addEventListener('abort', onExtAbort, { once: true });
    }
    const clearHardTimer = () => clearTimeout(timer);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExtAbort);
      resolve(value);
    };

    const upstream = https.request({
      agent: httpsAgentFor(SHARED_HTTPS_AGENT),
      hostname: host,
      port: 443,
      signal: abort.signal,
      ...options,
    }, (upstreamRes) => {
      onResponse(upstreamRes, finish, clearHardTimer);
    });
    upstream.on('error', () => finish(null));
    upstream.on('timeout', () => {
      upstream.destroy();
      finish(null);
    });
    upstream.end(payload || undefined);
  });
}

export function officialRequestOnce(host, req, payload, pathname, search, timeoutMs, externalSignal = null) {
  return officialRequestWithHardTimeout(
    host,
    {
      path: pathname + search,
      method: req.method,
      headers: officialHeaders(req.headers, payload, host),
      rejectUnauthorized: true,
      timeout: timeoutMs,
    },
    payload,
    (upstreamRes, finish) => {
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => finish({
        statusCode: upstreamRes.statusCode || 502,
        headers: upstreamRes.headers,
        body: Buffer.concat(chunks),
      }));
      upstreamRes.on('error', () => finish(null));
    },
    timeoutMs,
    externalSignal,
  );
}

export function parseOfficialModelsAttemptResult(results) {
  const ok = (results || []).find(r => r && r.statusCode >= 200 && r.statusCode < 300 && r.body);
  if (!ok) return null;
  try {
    const parsed = JSON.parse(ok.body.toString('utf8'));
    if (parsed && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
      return parsed;
    }
  } catch {}
  return null;
}

/**
 * 将请求透传至 Google 官方服务器，若网络不通或鉴权失败快速优雅回调 onFailed。
 */
export async function forwardToOfficialAntigravity(req, res, { body, customPath, onFailed } = {}) {
  const hosts = OFFICIAL_ANTIGRAVITY_HOSTS;
  const url = new URL(req.url, 'http://localhost');
  let pathname = customPath || url.pathname;
  if (pathname.startsWith('/antigravity/')) pathname = pathname.replace(/^\/antigravity/, '');
  else if (pathname === '/antigravity') pathname = '/';
  const fullPath = pathname + url.search;

  let payload = body;
  if (payload !== undefined && payload !== null && !Buffer.isBuffer(payload)) {
    payload = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  }

  for (let round = 0; round < 2; round++) {
    if (round > 0) {
      if (res.headersSent) return;
      await handshakeRetryDelay();
    }
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      const isLast = i === hosts.length - 1;
      try {
        const handled = await officialRequestWithHardTimeout(
          host,
          {
            path: fullPath,
            method: req.method,
            headers: officialHeaders(req.headers, payload, host),
            rejectUnauthorized: true,
            timeout: OFFICIAL_ATTEMPT_TIMEOUT_MS,
          },
          payload,
          (fwdRes, finish, clearHardTimer) => {
            const hasMoreHostsOrRetry = round === 0 || !isLast || typeof onFailed === 'function';
            const status = fwdRes.statusCode || 0;
            if (((status === 401 || status === 403) && typeof onFailed === 'function')
                || ((status === 429 || status === 500 || status === 502 || status === 503) && hasMoreHostsOrRetry)) {
              fwdRes.resume();
              finish(false);
              return;
            }
            if (typeof clearHardTimer === 'function') clearHardTimer();
            const onClientClose = () => {
              if (!res.writableEnded) {
                try { fwdRes.destroy(); } catch {}
              }
            };
            if (typeof res.once === 'function') res.once('close', onClientClose);
            const resHeaders = { ...fwdRes.headers };
            resHeaders['access-control-allow-origin'] = '*';
            resHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
            resHeaders['access-control-allow-headers'] = '*';

            res.writeHead(fwdRes.statusCode, resHeaders);
            fwdRes.pipe(res);
            fwdRes.on('end', () => {
              if (typeof res.off === 'function') res.off('close', onClientClose);
              finish(true);
            });
            fwdRes.on('error', () => {
              if (typeof res.off === 'function') res.off('close', onClientClose);
              if (!res.writableEnded) res.end();
              finish(true);
            });
          },
          OFFICIAL_ATTEMPT_TIMEOUT_MS,
        );

        if (handled) return;
      } catch {
        if (isLast) break;
      }
    }
  }

  if (typeof onFailed === 'function') {
    onFailed();
  } else if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 502, message: '官方服务器连接失败' } }));
  }
}
