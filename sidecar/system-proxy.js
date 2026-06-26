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

export function getSystemProxyUrl() {
  const explicitProxy = process.env.ANYBRIDGE_UPSTREAM_PROXY || process.env.BYOK_UPSTREAM_PROXY;
  if (explicitProxy) return parseProxyServer(explicitProxy);

  if (process.platform !== 'win32') {
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy;
    return envProxy ? parseProxyServer(envProxy) : '';
  }
  const enabled = readWindowsInternetSetting('ProxyEnable');
  if (enabled !== '1' && !/^0x?1$/i.test(enabled)) return '';
  return parseProxyServer(readWindowsInternetSetting('ProxyServer'));
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
  if (!proxyUrl) {
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

