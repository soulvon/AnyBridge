import crypto from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import {
  hashModelList,
  rewriteConfigSignature,
  writeCapturedModelList,
} from './certs-and-traffic.js';
import {
  STREAMING_METHODS,
  getRpcMethod,
  sanitizeProxyRequestHeaders,
  sanitizeProxyResponseHeaders,
  stripRoutePrefix,
} from './proto-helpers.js';

const CODEIUM_CONNECT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.BYOK_CODEIUM_CONNECT_TIMEOUT_MS || '15000', 10) || 15000);
const CODEIUM_IDLE_TIMEOUT_MS = Math.max(5000, parseInt(process.env.BYOK_CODEIUM_IDLE_TIMEOUT_MS || '120000', 10) || 120000);

export function createCodeiumProxy({
  configDir,
  mitmUpstreamHost,
  getUpstreamHost,
  httpsAgentFor,
  PROXY_HTTPS_AGENT,
  rpcAuditLog,
  mitmLog,
  tryGunzip,
  rewriteRegisterUser,
  noteTakeoverRequest,
  noteTakeoverCapture,
  diagLog,
  extractModelList,
  unlockModels,
  cacheState,
}) {
  return function proxyToCodeium(req, res, body, id, opts = {}) {
    const method = getRpcMethod(req.url);
    const socketUpstream = req.socket && mitmUpstreamHost.get(req.socket);
    const upstream = opts.upstream || socketUpstream || getUpstreamHost(req.url);
    const upstreamPath = stripRoutePrefix(req.url);
    const isStreaming = STREAMING_METHODS.has(method);
    const source = opts.source || 'http';

    rpcAuditLog({
      id,
      phase: 'request',
      source,
      route: 'codeium',
      method,
      url: req.url,
      upstream,
      upstreamPath,
      requestBytes: body ? body.length : 0,
    });

    const fwdHeaders = sanitizeProxyRequestHeaders(req.headers, body);
    fwdHeaders.host = upstream;

    const connectCtrl = new AbortController();
    let connectTimedOut = false;
    let connectTimer = setTimeout(() => {
      connectTimedOut = true;
      connectCtrl.abort();
    }, CODEIUM_CONNECT_TIMEOUT_MS);
    const clearConnectTimer = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };

    let activeProxyRes = null;
    let clientClosed = false;
    let idleTimer = null;
    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const resetIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        const timeoutErr = Object.assign(new Error(`Codeium upstream idle timeout (${CODEIUM_IDLE_TIMEOUT_MS}ms)`), { code: 'ETIMEDOUT' });
        try { activeProxyRes?.destroy(timeoutErr); } catch {}
        try { proxyReq.destroy(timeoutErr); } catch {}
      }, CODEIUM_IDLE_TIMEOUT_MS);
    };

    const cleanupAllTimers = () => {
      clearConnectTimer();
      clearIdleTimer();
      if (typeof res.off === 'function') res.off('close', onClientClose);
    };

    const onClientClose = () => {
      if (!res.writableEnded) {
        clientClosed = true;
        cleanupAllTimers();
        try { activeProxyRes?.destroy(); } catch {}
        try { proxyReq.destroy(); } catch {}
      }
    };
    if (typeof res.once === 'function') res.once('close', onClientClose);

    const proxyReq = https.request({
      agent: httpsAgentFor(PROXY_HTTPS_AGENT),
      hostname: upstream,
      port: 443,
      path: upstreamPath,
      method: req.method,
      headers: fwdHeaders,
      signal: connectCtrl.signal,
    }, (proxyRes) => {
      clearConnectTimer();
      activeProxyRes = proxyRes;
      resetIdleTimer();
      if (isStreaming) {
        console.log(`  [#${id}] ← ${proxyRes.statusCode} (streaming ${method})`);
        let responseBytes = 0;
        proxyRes.on('data', c => {
          responseBytes += c.length;
          resetIdleTimer();
        });
        if (method === 'GetChatMessage') {
          mitmLog({ direction: 'upstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` } });
        }
        res.writeHead(proxyRes.statusCode, sanitizeProxyResponseHeaders(proxyRes.headers));
        proxyRes.pipe(res);
        proxyRes.on('error', () => {
          cleanupAllTimers();
          if (!res.writableEnded) res.end();
        });
        proxyRes.on('end', () => {
          cleanupAllTimers();
          rpcAuditLog({
            id,
            phase: 'response',
            source,
            route: 'codeium',
            method,
            url: req.url,
            upstream,
            upstreamPath,
            statusCode: proxyRes.statusCode,
            responseBytes,
          });
          if (method === 'GetChatMessage') {
            mitmLog({ direction: 'downstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` }, response: { statusCode: proxyRes.statusCode } });
          }
        });
        return;
      }

      const chunks = [];
      proxyRes.on('data', c => {
        chunks.push(c);
        resetIdleTimer();
      });
      proxyRes.on('end', () => {
        cleanupAllTimers();
        if (clientClosed || res.writableEnded) return;
        let resBody = Buffer.concat(chunks);
        console.log(`  [#${id}] ← ${proxyRes.statusCode} (${resBody.length}b)`);
        rpcAuditLog({
          id,
          phase: 'response',
          source,
          route: 'codeium',
          method,
          url: req.url,
          upstream,
          upstreamPath,
          statusCode: proxyRes.statusCode,
          responseBytes: resBody.length,
        });
        if (method === 'GetChatMessage') {
          mitmLog({ direction: 'upstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` } });
          mitmLog({ direction: 'downstream', providerName: 'Codeium(透传)', model: '(未拦截)', format: 'connect-grpc', request: { method, url: `https://${upstream}${upstreamPath}` }, response: { statusCode: proxyRes.statusCode, body: resBody.length <= 4096 ? resBody.toString('utf8') : `[${resBody.length}b]` } });
        }

        if (!opts.skipRewrite && method === 'RegisterUser' && proxyRes.statusCode === 200 && resBody.length > 5) {
          try {
            const flags = resBody[0];
            const msgLen = resBody.readUInt32BE(1);
            if (msgLen === resBody.length - 5 && flags <= 1) {
              let payload = resBody.subarray(5);
              if (flags === 1) {
                const d = tryGunzip(payload);
                if (d) payload = d;
              }
              const rewritten = rewriteRegisterUser(payload);
              const envelope = Buffer.alloc(5 + rewritten.length);
              envelope[0] = 0;
              envelope.writeUInt32BE(rewritten.length, 1);
              rewritten.copy(envelope, 5);
              resBody = envelope;
              console.log(`  [#${id}] 🔄 RegisterUser rewritten`);
            }
          } catch (e) {
            console.error(`  [#${id}] RegisterUser rewrite error: ${e.message}`);
          }
        }

        let stripEncoding = false;
        let cliRewriteDiagnostic = null;
        const shouldRewriteModels = proxyRes.statusCode === 200
          && (method === 'GetUserStatus' || method === 'GetCliModelConfigs');
        if (shouldRewriteModels) {
          noteTakeoverRequest(upstream);
          diagLog.log(
            `takeover heartbeat: target=${upstream === 'server.codeium.com' ? 'devin' : 'windsurf'} method=${method} status=${proxyRes.statusCode}`,
          );
          const shouldCapture = method === 'GetUserStatus' && (Date.now() - cacheState.lastModelListCapturedAt) > 30000;
          if (shouldCapture) {
            try {
              const list = extractModelList(resBody);
              if (list && list.length) {
                const dir = process.env.BYOK_CONFIG_DIR;
                if (dir) {
                  const file = path.join(dir, 'ide-models.json');
                  const sig = hashModelList(list);
                  if (sig !== cacheState.lastModelListSig) {
                    cacheState.lastModelListSig = sig;
                    writeCapturedModelList(file, list);
                    noteTakeoverCapture(upstream);
                    const target = upstream === 'server.codeium.com' ? 'Devin' : 'Windsurf';
                    console.log(`  [#${id}] 📋 已捕获 ${target} 模型 ${list.length} 个 → ide-models.json`);
                  }
                }
              }
              cacheState.lastModelListCapturedAt = Date.now();
            } catch (e) {
              console.error(`  [#${id}] capture models error: ${e.message}`);
            }
          }
          try {
            const inputSig = `${method}|${crypto.createHash('sha1').update(resBody).digest('hex').slice(0, 16)}|${rewriteConfigSignature(configDir)}`;
            const responseBytes = resBody.length;
            const contentType = String(proxyRes.headers['content-type'] || '-');
            const contentEncoding = String(proxyRes.headers['content-encoding'] || '-');
            const connectEncoding = String(proxyRes.headers['connect-content-encoding'] || '-');
            const isGzip = resBody[0] === 0x1f && resBody[1] === 0x8b;
            const frameLength = resBody.length >= 5 ? resBody.readUInt32BE(1) : -1;
            const isConnectFrame = (resBody[0] === 0 || resBody[0] === 1) && frameLength === resBody.length - 5;
            const inputFormat = isGzip ? 'gzip' : (isConnectFrame ? `Connect帧(flags=${resBody[0]})` : '裸protobuf/其他');
            const cacheHit = inputSig === cacheState.lastUnlockInputSig && !!cacheState.lastUnlockResult;
            let rewriteResult;
            if (cacheHit) {
              rewriteResult = cacheState.lastUnlockResult;
              resBody = rewriteResult.body;
              if (rewriteResult.wasConnect) stripEncoding = true;
            } else {
              rewriteResult = unlockModels(resBody);
              if (rewriteResult) {
                resBody = rewriteResult.body;
                if (rewriteResult.wasConnect) stripEncoding = true;
                cacheState.lastUnlockResult = rewriteResult;
                cacheState.lastUnlockInputSig = inputSig;
              }
            }
            if (method === 'GetCliModelConfigs') {
              cliRewriteDiagnostic = {
                responseBytes,
                inputFormat,
                contentType,
                contentEncoding,
                connectEncoding,
                cacheHit,
                changed: rewriteResult ? rewriteResult.changed : 0,
                outputBytes: resBody.length,
              };
            } else if (rewriteResult && Date.now() - cacheState.lastModelRewriteLogAt > 5000) {
              console.log(`  [#${id}] 🔄 ${method}：已改写 ${rewriteResult.changed} 个模型（重命名、解锁、注入）`);
              cacheState.lastModelRewriteLogAt = Date.now();
            }
          } catch (e) {
            console.error(`  [#${id}] 模型列表改写失败：${e.message}`);
          }
        }

        const resHeaders = sanitizeProxyResponseHeaders(proxyRes.headers, {
          stripEncoding,
          contentLength: resBody.length,
        });
        if (cliRewriteDiagnostic) {
          const d = cliRewriteDiagnostic;
          const outcome = d.changed > 0 ? `已改写 ${d.changed} 个模型` : '未改写';
          const outputEncoding = resHeaders['content-encoding'] || '-';
          console.log(`  [#${id}] 🔄 GetCliModelConfigs：${outcome}，缓存命中=${d.cacheHit ? '是' : '否'}，格式=${d.inputFormat}，上游=${d.responseBytes}字节/输出=${d.outputBytes}字节，类型=${d.contentType}，编码=${d.contentEncoding}，Connect编码=${d.connectEncoding}，返回编码=${outputEncoding}`);
        }
        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(resBody);
      });
      proxyRes.on('error', (err) => {
        cleanupAllTimers();
        if (clientClosed) return;
        console.error(`  [#${id}] ← error: ${err.message}`);
        rpcAuditLog({
          id,
          phase: 'error',
          source,
          route: 'codeium',
          method,
          url: req.url,
          upstream,
          upstreamPath,
          error: err.message,
        });
        if (!res.headersSent) res.writeHead(err.code === 'ETIMEDOUT' ? 504 : 502);
        if (!res.writableEnded) res.end();
      });
    });
    proxyReq.on('error', (err) => {
      cleanupAllTimers();
      if (clientClosed) return;
      const errMsg = connectTimedOut
        ? `Codeium upstream connect/TTFB timeout (${CODEIUM_CONNECT_TIMEOUT_MS}ms)`
        : (err?.message || 'upstream request failed');
      console.error(`  [#${id}] ✗ upstream: ${errMsg}`);
      rpcAuditLog({
        id,
        phase: 'error',
        source,
        route: 'codeium',
        method,
        url: req.url,
        upstream,
        upstreamPath,
        requestBytes: body ? body.length : 0,
        error: errMsg,
      });
      const status = (connectTimedOut || err?.code === 'ETIMEDOUT') ? 504 : 502;
      if (!res.headersSent) res.writeHead(status);
      if (!res.writableEnded) res.end(`Upstream error: ${errMsg}`);
    });
    proxyReq.end(body);
  };
}
