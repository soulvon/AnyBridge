// inference-proxy.js — HTTP/2 inference proxy for Windsurf (port 13001)
//
// Intercepts GetChatMessage (inline AI edit) → Anthropic API
// Forwards GetStreamingCompletions (autocomplete) → real Codeium
// Forwards everything else → real Codeium
//
// Usage: node src/inference-proxy.js
//   Runs behind nginx (grpc_pass) for TLS termination in remote deployments.
//   For local use, Windsurf patches point --inference_api_server_url here.

import http2 from 'node:http2';
import https from 'node:https';
import { handleGetChatMessage } from './handlers/chat.js';
import { listenWithReclaim } from './port-utils.js';

const PORT = parseInt(process.env.INFERENCE_PORT || '7451', 10);
const UPSTREAM = 'inference.codeium.com';

// Only intercept GetChatMessage (inline AI edit).
// GetStreamingCompletions (autocomplete) is forwarded to Codeium.
const INTERCEPT_PATHS = new Set([
  '/exa.api_server_pb.ApiServerService/GetChatMessage',
]);

let reqCount = 0;

function now() {
  return new Date().toISOString().slice(11, 23);
}

// ─── Forward to real Codeium inference ────────────────────

function forwardToCodeium(body, stream, headers, path, id) {
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':') || k === 'host') continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders['host'] = UPSTREAM;
  fwdHeaders['content-length'] = body.length;

  const fwdReq = https.request({
    hostname: UPSTREAM,
    port: 443,
    path,
    method: 'POST',
    headers: fwdHeaders,
  }, (fwdRes) => {
    const resHeaders = { ':status': fwdRes.statusCode };
    for (const [k, v] of Object.entries(fwdRes.headers)) {
      if (k === 'transfer-encoding' || k === 'connection') continue;
      resHeaders[k] = v;
    }
    stream.respond(resHeaders);
    // 背压：stream.write 返回 false 时暂停上游读取，drain 后恢复，避免大响应内存堆积。
    fwdRes.on('data', (chunk) => {
      if (stream.destroyed) { fwdRes.destroy(); return; }
      const ok = stream.write(chunk);
      if (!ok) {
        fwdRes.pause();
        stream.once('drain', () => fwdRes.resume());
      }
    });
    fwdRes.on('end', () => {
      if (!stream.destroyed) stream.end();
      console.log(`  [#${id}] ✅ forwarded`);
    });
    fwdRes.on('error', (err) => {
      console.error(`  [#${id}] ❌ fwd error: ${err.message}`);
      if (!stream.destroyed) stream.end();
    });
  });

  fwdReq.on('error', (err) => {
    console.error(`  [#${id}] ❌ upstream error: ${err.message}`);
    if (!stream.destroyed) {
      stream.respond({ ':status': 502 });
      stream.end();
    }
  });

  // 上游超时防挂起：60s 无响应则断开并回 504。
  fwdReq.setTimeout(60000, () => {
    fwdReq.destroy(new Error('upstream timeout'));
  });

  fwdReq.end(body);
}

// ─── Adapt HTTP/2 stream to HTTP/1.1 req/res for chat handler ──

function adaptStreamForChatHandler(body, stream, headers) {
  // The chat handler expects Node.js http.IncomingMessage / http.ServerResponse
  // but we have an HTTP/2 stream. Build minimal adapters.
  const fakeReq = {
    headers: { ...headers },
    url: headers[':path'] || '/',
    method: headers[':method'] || 'POST',
  };

  let headersSent = false;
  const fakeRes = {
    headersSent: false,
    writableEnded: false,
    writeHead(status, hdrs = {}) {
      if (headersSent) return;
      headersSent = true;
      this.headersSent = true;
      const h2headers = { ':status': status, ...hdrs };
      try { stream.respond(h2headers); } catch {}
    },
    write(chunk) {
      if (!headersSent) this.writeHead(200);
      if (!stream.destroyed) {
        try { stream.write(chunk); } catch {}
      }
    },
    end(data) {
      if (!headersSent) this.writeHead(200);
      this.writableEnded = true;
      if (!stream.destroyed) {
        try { stream.end(data); } catch {}
      }
    },
    on(event, handler) {
      // Map res.on('close') → stream.on('close')
      if (event === 'close') {
        stream.on('close', handler);
      }
    },
  };

  handleGetChatMessage(fakeReq, fakeRes, body);
}

// ─── HTTP/2 server ───────────────────────────────────────

const server = http2.createServer();

server.on('stream', (stream, headers) => {
  const id = ++reqCount;
  const method = headers[':method'] || 'GET';
  const path = headers[':path'] || '/';
  const contentType = headers['content-type'] || '';
  const rpcMethod = path.split('/').pop();

  if (method !== 'POST' || !contentType.includes('connect+proto')) {
    stream.respond({ ':status': 404 });
    stream.end();
    return;
  }

  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));

  stream.on('end', () => {
    const body = Buffer.concat(chunks);
    console.log(`[${now()}] #${id} ${rpcMethod} (${body.length}b)`);

    if (INTERCEPT_PATHS.has(path)) {
      console.log(`  ⚡ → Anthropic API (inline AI edit)`);
      try {
        adaptStreamForChatHandler(body, stream, headers);
      } catch (err) {
        console.error(`  ❌ Handler error: ${err.message}`);
        if (!stream.destroyed) {
          stream.respond({ ':status': 500, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ code: 'internal', message: err.message }));
        }
      }
    } else {
      console.log(`  → ${UPSTREAM}${path}`);
      forwardToCodeium(body, stream, headers, path, id);
    }
  });

  stream.on('error', (err) => {
    if (err.code === 'ERR_HTTP2_STREAM_ERROR') return;
    console.error(`[${now()}] #${id} stream error: ${err.message}`);
  });
});

listenWithReclaim(server, PORT, () => {
  console.log(`\n⚡ Windsurf INFERENCE PROXY on http://localhost:${PORT}`);
  console.log(`\n   GetChatMessage         → Anthropic API (inline AI edit)`);
  console.log(`   GetStreamingCompletions → ${UPSTREAM} (autocomplete)`);
  console.log(`   Everything else         → ${UPSTREAM}\n`);
}, 'inference');
