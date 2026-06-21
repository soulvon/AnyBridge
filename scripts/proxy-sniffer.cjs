/**
 * AnyRouter 抓包代理
 * 用法: node scripts/proxy-sniffer.cjs
 * 
 * 然后配置 Codex/Claude Code 的 base URL 为 http://localhost:9999
 * 所有请求/响应都会打印到控制台
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TARGET_HOST = 'anyrouter.top';
const TARGET_PORT = 443;
const LISTEN_PORT = 9999;

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, `sniffer-${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.log`);

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(msg) {
  console.log(msg);
  logStream.write(msg + '\n');
}

let requestCounter = 0;

function formatHeaders(headers) {
  return Object.entries(headers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
}

function truncateBody(body, maxLen = 2000) {
  if (!body) return '(empty)';
  const str = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  if (maxLen === 0) return str; // 0 = 完整输出不截断
  if (str.length > maxLen) {
    return str.substring(0, maxLen) + `... [truncated, total ${str.length} chars]`;
  }
  return str;
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      resolve(raw);
    });
  });
}

const server = http.createServer(async (clientReq, clientRes) => {
  const reqId = ++requestCounter;
  const timestamp = new Date().toISOString();

  // 读取客户端请求体
  const clientBodyRaw = await readBody(clientReq);

  // ========== 打印请求 ==========
  log(`\n${'='.repeat(80)}`);
  log(`[REQ #${reqId}] ${timestamp}`);
  log(`${clientReq.method} ${clientReq.url}`);
  log(`--- Request Headers ---`);
  log(formatHeaders(clientReq.headers));
  log(`--- Request Body ---`);
  log(truncateBody(clientBodyRaw, 0)); // 0 = 不截断，完整写入日志

  // 构建转发请求的选项
  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: TARGET_HOST, // 覆盖 host 头
    },
    rejectUnauthorized: false, // 允许自签证书（这里不需要，但保留）
  };

  // 删除 hop-by-hop 头
  delete options.headers['connection'];
  delete options.headers['proxy-connection'];
  delete options.headers['transfer-encoding'];

  // 转发请求到 AnyRouter
  const proxyReq = https.request(options, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const bodyStr = rawBody.toString('utf-8');

      // ========== 打印响应 ==========
      log(`\n[RES #${reqId}] ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
      log(`--- Response Headers ---`);
      log(formatHeaders(proxyRes.headers));
      log(`--- Response Body ---`);
      log(truncateBody(bodyStr, 0));
      log(`${'='.repeat(80)}\n`);

      // 设置响应头并返回
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      clientRes.end(rawBody);
    });
  });

  proxyReq.on('error', (err) => {
    log(`\n[ERR #${reqId}] Proxy error: ${err.message}`);
    clientRes.writeHead(502);
    clientRes.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
  });

  // 发送请求体
  if (clientBodyRaw) {
    proxyReq.write(clientBodyRaw);
  }
  proxyReq.end();
});

server.listen(LISTEN_PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     AnyRouter 抓包代理已启动                            ║
║     监听: http://localhost:${LISTEN_PORT}                          ║
║     转发目标: https://${TARGET_HOST}                     ║
║     日志文件: ${LOG_FILE}
║                                                        ║
║  配置方法:                                             ║
║    Codex 设置:  API Base URL → http://localhost:${LISTEN_PORT} ║
║    Claude Code: 类似改 base URL                        ║
║                                                        ║
║    Ctrl+C 停止                                          ║
╚══════════════════════════════════════════════════════════╝
`);
});
