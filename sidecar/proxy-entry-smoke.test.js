import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SIDECAR_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.join(SIDECAR_DIR, 'proxy-entry.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function httpJson(port, method, reqPath, key, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) });
          } catch (err) {
            reject(new Error(`invalid JSON from ${reqPath} (${res.statusCode}): ${buf.slice(0, 200)} (${err.message})`));
          }
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('proxy-entry boots cleanly in isolated env without TDZ or module-resolution errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-proxy-smoke-'));
  const apiPort = await getFreePort();
  const infPort = await getFreePort();
  const agHttpsPort = await getFreePort();
  fs.writeFileSync(
    path.join(dir, 'byok-config.json'),
    JSON.stringify({ values: { LOCAL_PROXY_KEY: 'smoke-test-key' } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'providers.json'),
    JSON.stringify({ antigravityMode: 'pure', providers: [], antigravityConfigs: [] }),
    'utf8',
  );

  const child = spawn(process.execPath, [ENTRY_PATH], {
    cwd: SIDECAR_DIR,
    env: {
      ...process.env,
      BYOK_CONFIG_DIR: dir,
      API_PORT: String(apiPort),
      INFERENCE_PORT: String(infPort),
      ANTIGRAVITY_HTTPS_PORT: String(agHttpsPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  try {
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) break;
      try {
        const res = await httpJson(apiPort, 'GET', '/health', 'smoke-test-key');
        if (res.status === 200 && res.json?.status === true) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(healthy, `proxy-entry failed to answer /health (exit=${child.exitCode}). Logs:\n${logs}`);

    const models = await httpJson(apiPort, 'GET', '/v1/models', 'smoke-test-key');
    assert.equal(models.status, 200);
    assert.equal(models.json.object, 'list');

    const agModels = await httpJson(apiPort, 'POST', '/v1internal:fetchAvailableModels', 'smoke-test-key', {});
    assert.equal(agModels.status, 200);
    assert.ok(agModels.json && typeof agModels.json.models === 'object');

    const stats = await httpJson(apiPort, 'GET', '/__byok/stats', 'smoke-test-key');
    assert.equal(stats.status, 200);
    assert.ok(Number(stats.json?.windsurfCatalogCount) > 200, `windsurfCatalogCount 应加载到全部目录，实际=${stats.json?.windsurfCatalogCount}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

