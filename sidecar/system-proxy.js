import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

function parseProxyServer(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const parts = value.split(';').map(s => s.trim()).filter(Boolean);
  const picked = parts.find(p => p.toLowerCase().startsWith('https='))
    || parts.find(p => p.toLowerCase().startsWith('http='))
    || parts[0];
  const proxy = picked.includes('=') ? picked.split('=').slice(1).join('=').trim() : picked;
  if (!proxy) return '';
  return /^https?:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
}

function readWindowsInternetSetting(name) {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      name,
    ], { encoding: 'utf8', windowsHide: true, timeout: 1500 });
    const line = output.split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith(name));
    if (!line) return '';
    const parts = line.split(/\s+/);
    return parts.slice(2).join(' ').trim();
  } catch {
    return '';
  }
}

function readMacSystemProxy() {
  if (process.platform !== 'darwin') return '';
  try {
    const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
    if (/HTTPSEnable\s*:\s*1/.test(output)) {
      const hostMatch = output.match(/HTTPSProxy\s*:\s*([^\s]+)/);
      const portMatch = output.match(/HTTPSPort\s*:\s*([0-9]+)/);
      if (hostMatch && portMatch) {
        return `http://${hostMatch[1]}:${portMatch[1]}`;
      }
    }
    if (/HTTPEnable\s*:\s*1/.test(output)) {
      const hostMatch = output.match(/HTTPProxy\s*:\s*([^\s]+)/);
      const portMatch = output.match(/HTTPPort\s*:\s*([0-9]+)/);
      if (hostMatch && portMatch) {
        return `http://${hostMatch[1]}:${portMatch[1]}`;
      }
    }
    return '';
  } catch {
    return '';
  }
}

export function getSystemProxyUrl() {
  const explicitProxy = process.env.ANYBRIDGE_UPSTREAM_PROXY || process.env.BYOK_UPSTREAM_PROXY;
  if (explicitProxy) return parseProxyServer(explicitProxy);

  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) return parseProxyServer(envProxy);

  if (process.platform === 'darwin') {
    return parseProxyServer(readMacSystemProxy());
  }

  if (process.platform === 'win32') {
    const enabled = readWindowsInternetSetting('ProxyEnable');
    if (enabled !== '1' && !/^0x?1$/i.test(enabled)) return '';
    return parseProxyServer(readWindowsInternetSetting('ProxyServer'));
  }

  return '';
}

class HttpsOverHttpProxyAgent extends https.Agent {
  constructor(proxyUrl, options = {}) {
    super(options);
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    const targetHost = options.hostname || options.host;
    const targetPort = options.port || 443;
    const proxyPort = Number(this.proxy.port || 8080);
    const proxyHosts = proxyConnectHosts(this.proxy.hostname);
    let done = false;

    const finish = (err, socket) => {
      if (done) return;
      done = true;
      callback(err, socket);
    };

    const connectProxy = (attempt = 0) => {
      const proxyHost = proxyHosts[attempt];
      const proxySocket = net.connect({
        host: proxyHost,
        port: proxyPort,
      });

      proxySocket.setTimeout(options.timeout || 30_000);
      proxySocket.once('connect', () => {
        proxySocket.write([
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
          `Host: ${targetHost}:${targetPort}`,
          'Proxy-Connection: Keep-Alive',
          'Connection: Keep-Alive',
          '',
          '',
        ].join('\r\n'));
      });

      let header = Buffer.alloc(0);
      proxySocket.on('data', function onData(chunk) {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf('\r\n\r\n');
        if (end < 0) return;
        proxySocket.off('data', onData);
        const statusLine = header.slice(0, end).toString('latin1').split('\r\n')[0] || '';
        if (!/^HTTP\/\d(?:\.\d)? 2\d\d\b/.test(statusLine)) {
          proxySocket.destroy();
          finish(new Error(`proxy CONNECT failed: ${statusLine || 'no response'}`));
          return;
        }
        proxySocket.setTimeout(0);
        const tlsSocket = tls.connect({
          socket: proxySocket,
          servername: options.servername || targetHost,
          ALPNProtocols: options.ALPNProtocols,
        }, () => finish(null, tlsSocket));
        tlsSocket.once('error', err => finish(err));
      });

      proxySocket.once('timeout', () => {
        proxySocket.destroy();
        finish(new Error('proxy CONNECT timeout'));
      });
      proxySocket.once('error', err => {
        proxySocket.destroy();
        if (!done && err?.code === 'ECONNREFUSED' && attempt + 1 < proxyHosts.length) {
          console.warn(`[proxy] upstream proxy ${proxyHost}:${proxyPort} refused; retrying ${proxyHosts[attempt + 1]}:${proxyPort}`);
          connectProxy(attempt + 1);
          return;
        }
        finish(err);
      });
    };

    connectProxy();
  }
}

function proxyConnectHosts(hostname) {
  const host = String(hostname || '').trim();
  const lower = host.toLowerCase();
  if (lower === '127.0.0.1' || lower === 'localhost') return [host, '::1'];
  if (lower === '::1' || lower === '[::1]') return [host, '127.0.0.1'];
  return [host];
}

const PROXY_CACHE_MS = Number(process.env.ANYBRIDGE_SYSTEM_PROXY_CACHE_MS || 1000);
let SYSTEM_HTTPS_AGENT = null;
let SYSTEM_HTTPS_AGENT_URL = '';
let PROXY_CACHE_VALUE = '';
let PROXY_CACHE_EXPIRES_AT = 0;

// ─── 代理端口健康探测 ─────────────────────────────────────────────
// 系统代理注册表项（ProxyEnable/ProxyServer）会在代理软件退出后残留，
// 指向一个已无进程监听的死端口（2026-10-30 实测：FlClash 退出后 7897 残留，
// 本模块每秒重读到的仍是死代理，上游请求全部 proxyconnect ECONNREFUSED）。
// 重读解决不了这种场景，必须探测端口连通性：死端口降级直连，恢复后自动切回。
const PROXY_HEALTH_INTERVAL_MS = Number(process.env.ANYBRIDGE_PROXY_HEALTH_INTERVAL_MS || 5000);
const PROXY_HEALTH_TIMEOUT_MS = Number(process.env.ANYBRIDGE_PROXY_HEALTH_TIMEOUT_MS || 1500);
let PROXY_HEALTHY = true;   // 首次探测完成前假定可用，保持既有行为
let PROXY_HEALTH_LAST_URL = '';
let PROXY_HEALTH_LAST_AT = 0;
let PROXY_HEALTH_LOG_AT = 0;

export function _setProxyHealthForTest(ok) {
  PROXY_HEALTHY = ok;
}

function probeProxyHealth() {
  const proxyUrl = cachedSystemProxyUrl();
  if (!proxyUrl) {
    PROXY_HEALTHY = true;
    PROXY_HEALTH_LAST_URL = '';
    return;
  }
  const now = Date.now();
  if (proxyUrl === PROXY_HEALTH_LAST_URL && now - PROXY_HEALTH_LAST_AT < PROXY_HEALTH_INTERVAL_MS) {
    return; // 同一地址节流
  }
  PROXY_HEALTH_LAST_URL = proxyUrl;
  PROXY_HEALTH_LAST_AT = now;
  let host;
  let port;
  try {
    const url = new URL(proxyUrl);
    host = url.hostname.replace(/^\[|\]$/g, '');
    port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    PROXY_HEALTHY = true; // 无法解析的地址交由既有逻辑处理
    return;
  }
  const socket = net.connect({ host, port });
  const settle = (ok) => {
    socket.destroy();
    if (PROXY_HEALTHY === ok) return;
    PROXY_HEALTHY = ok;
    const at = Date.now();
    if (at - PROXY_HEALTH_LOG_AT > 30_000) {
      PROXY_HEALTH_LOG_AT = at;
      console.log(ok
        ? `[proxy] system proxy back online: ${redactProxyUrl(proxyUrl)}`
        : `[proxy] system proxy unreachable (${host}:${port}), falling back to direct upstream`);
    }
  };
  socket.setTimeout(PROXY_HEALTH_TIMEOUT_MS, () => settle(false));
  socket.once('connect', () => settle(true));
  socket.once('error', () => settle(false));
}

probeProxyHealth();
const PROXY_HEALTH_TIMER = setInterval(probeProxyHealth, Math.max(1000, PROXY_HEALTH_INTERVAL_MS));
if (PROXY_HEALTH_TIMER && typeof PROXY_HEALTH_TIMER.unref === 'function') PROXY_HEALTH_TIMER.unref();

function redactProxyUrl(proxyUrl) {
  if (!proxyUrl) return '';
  try {
    const url = new URL(proxyUrl);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

function cachedSystemProxyUrl() {
  const now = Date.now();
  if (PROXY_CACHE_MS > 0 && now < PROXY_CACHE_EXPIRES_AT) return PROXY_CACHE_VALUE;
  PROXY_CACHE_VALUE = getSystemProxyUrl();
  PROXY_CACHE_EXPIRES_AT = PROXY_CACHE_MS > 0 ? now + PROXY_CACHE_MS : 0;
  return PROXY_CACHE_VALUE;
}

function clearSystemProxyAgent() {
  if (SYSTEM_HTTPS_AGENT) {
    try { SYSTEM_HTTPS_AGENT.destroy(); } catch {}
  }
  SYSTEM_HTTPS_AGENT = null;
  SYSTEM_HTTPS_AGENT_URL = '';
}

export function httpsAgentFor(directAgent = undefined) {
  const proxyUrl = cachedSystemProxyUrl();
  if (!proxyUrl || !PROXY_HEALTHY) {
    // 死端口场景：注册表仍指向系统代理但端口无进程监听，
    // 必须降级直连，否则上游请求全部 proxyconnect ECONNREFUSED（坑点 #508 同款）。
    clearSystemProxyAgent();
    return directAgent;
  }
  if (!SYSTEM_HTTPS_AGENT || SYSTEM_HTTPS_AGENT_URL !== proxyUrl) {
    clearSystemProxyAgent();
    SYSTEM_HTTPS_AGENT_URL = proxyUrl;
    console.log(`[proxy] upstream system proxy enabled: ${redactProxyUrl(proxyUrl)}`);
    SYSTEM_HTTPS_AGENT = new HttpsOverHttpProxyAgent(proxyUrl, {
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: Number(process.env.BYOK_MAX_SOCKETS || 64),
      maxFreeSockets: Number(process.env.BYOK_MAX_FREE_SOCKETS || 16),
    });
  }
  return SYSTEM_HTTPS_AGENT;
}

