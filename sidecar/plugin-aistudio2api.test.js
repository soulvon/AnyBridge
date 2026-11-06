// aistudio2api 插件契约测试：按 plugin-loader.js 的加载方式用 mock ctx 执行 adapter.js。
// 覆盖 manifest 关键字段、.env 保形生成、密钥回传、面板数据与卸载备份。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'src-tauri', 'resources', 'plugins', 'aistudio2api');
const smokeHome = path.join(root, 'tmp', 'plugin-aistudio2api-home');
const installPath = path.join(root, 'tmp', 'plugin-aistudio2api-install');
const expectedBin = process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api';

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function storedConfigDir() {
  const base = process.platform === 'darwin'
    ? path.join(smokeHome, 'Library', 'Application Support')
    : smokeHome;
  return path.join(base, 'AnyBridge', 'plugins', 'aistudio2api');
}

async function loadAdapter(file) {
  // 与 sidecar/plugin-loader.js 的 loadAdapterFromDisk 一致：new Function 求值
  const code = (await fs.readFile(file, 'utf-8')).trim().replace(/^\s*export\s+default\s+/m, 'return ');
  return new Function(code)();
}

const fetched = [];
const executed = [];
const ctx = {
  fs,
  path,
  pluginDir,
  commandExists: async () => true,
  log: () => {},
  generateHex: (n = 32) => 'a'.repeat(n),
  generateBase64: (n = 32) => 'b'.repeat(n),
  generatePassword: (n = 20) => 'c'.repeat(n),
  exec: async (cmd) => { executed.push(cmd); return { stdout: '', stderr: '' }; },
  fetch: async (url) => {
    fetched.push(url);
    return {
      ok: true,
      json: async () => url.includes('/api/status')
        ? { state: 'RUNNING', running: true, version: 'v0.3.1' }
        : { data: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-3-pro' }] },
    };
  },
};

let adapter;
let manifest;

describe('aistudio2api 插件', () => {
  before(async () => {
    for (const key of Object.keys(originalEnv)) process.env[key] = smokeHome;
    await fs.rm(smokeHome, { recursive: true, force: true });
    await fs.rm(installPath, { recursive: true, force: true });
    await fs.mkdir(installPath, { recursive: true });
    await fs.mkdir(storedConfigDir(), { recursive: true });

    manifest = JSON.parse(await fs.readFile(path.join(pluginDir, 'plugin.json'), 'utf-8'));
    adapter = await loadAdapter(path.join(pluginDir, 'adapter.js'));

    await fs.writeFile(path.join(installPath, expectedBin), 'fake-binary', 'utf-8');
    await fs.writeFile(path.join(installPath, '.env'), '# 用户保留项\nWAA_BACKEND=camoufox\nLISTEN_ADDR=127.0.0.1:9999\n', 'utf-8');
    await fs.writeFile(path.join(installPath, '.aistudio2api-version'), 'v0.3.1\n', 'utf-8');
    await fs.writeFile(
      path.join(storedConfigDir(), 'config.json'),
      JSON.stringify({ port: 2048, apiKey: 'smoke-key', installPath }),
      'utf-8'
    );
  });

  after(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(smokeHome, { recursive: true, force: true });
    await fs.rm(installPath, { recursive: true, force: true });
  });

  it('manifest 对齐上游部署事实与 CPA 基准接线', () => {
    assert.equal(manifest.apiVersion, 1);
    assert.equal(manifest.id, 'aistudio2api');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.runtime.type, 'binary');
    assert.equal(manifest.runtime.binary, 'aistudio2api{ext}');
    assert.equal(manifest.healthCheck.type, 'http');
    assert.match(manifest.healthCheck.url, /\{port\}/);
    assert.equal(manifest.healthCheck.expectStatus, 200);
    assert.deepEqual(manifest.deploy.strategies, ['adapter']);
    assert.equal(manifest.deploy.asset.repo, 'Mag1cFall/AIStudio2API');
    assert.match(manifest.deploy.asset.name, /\{tag\}/, '含版本号的资产名必须用 {tag}');
    assert.equal(manifest.deploy.asset.stripComponents, 1, '真实 release 包有一层顶层目录');
    assert.equal(manifest.deploy.adapter.doc, 'deploy.md');
    assert.equal(manifest.upgrade.type, 'github-release');
  });

  it('端口与密钥配置不会落进通用兜底', () => {
    const portField = manifest.configSchema.find((f) => f.key === 'port');
    const keyField = manifest.configSchema.find((f) => f.key === 'apiKey');
    assert.equal(portField.default, 2048);
    assert.equal(keyField.generate, 'base64-32', '首次安装必须生成密钥，否则供应商不会登记');
    const gateway = manifest.panels.find((p) => p.id === 'gateway');
    assert.equal(gateway.requiresAuth, false, 'switchVersion 由 Rust 拦截，args[1] 必须是版本');
    assert.equal(gateway.loadFrom, 'getGatewayStatus');
    assert.deepEqual(gateway.actions.map((a) => a.method).sort(), ['openConsole', 'switchVersion']);
    assert.ok(Array.isArray(manifest.credentials) && manifest.credentials.length >= 2);
  });

  it('部署文档与适配器方法齐全，不出现第二条下载路径', async () => {
    const src = await fs.readFile(path.join(pluginDir, 'adapter.js'), 'utf-8');
    for (const method of [
      'checkEnvironment', 'generateConfig', 'prepareStart', 'prepareStop',
      'upgrade', 'prepareUninstall', 'getGatewayStatus', 'openConsole',
    ]) {
      assert.ok(src.includes(`async ${method}(`), `缺少方法 ${method}`);
    }
    assert.ok(!src.includes('async switchVersion('));
    assert.ok(src.includes("process.platform === 'win32'"));
    const deployMd = await fs.readFile(path.join(pluginDir, 'deploy.md'), 'utf-8');
    assert.ok(/^## Strategy: Adapter$/m.test(deployMd));
    assert.ok(!deployMd.includes('```'), 'adapter 策略不能带 shell 步骤');
    const svg = await fs.readFile(path.join(pluginDir, 'icon.svg'), 'utf-8');
    assert.ok(svg.includes('<svg') && svg.includes('</svg>'));
  });

  it('generateConfig 只改托管键并回传真实密钥', async () => {
    const config = await adapter.generateConfig(ctx, { port: 2048, apiKey: 'smoke-key' }, installPath);
    assert.equal(config.apiKey, 'smoke-key');
    assert.equal(config.configPath, path.join(installPath, '.env'));
    const env = await fs.readFile(config.configPath, 'utf-8');
    for (const line of [
      'LISTEN_ADDR=127.0.0.1:2048',
      'PREVIEW_LISTEN_ADDR=127.0.0.1:2049',
      'PROXY_API_KEY=smoke-key',
      'AUTO_START=true',
      'AISTUDIO_AUTH_STATES=auths',
    ]) {
      assert.ok(env.includes(line), `.env 缺少 ${line}`);
    }
    assert.ok(env.includes('# 用户保留项'), '注释必须保留');
    assert.ok(env.includes('WAA_BACKEND=camoufox'), '用户改过的配置项必须保留');
    assert.equal(env.split('\n').filter((l) => l.startsWith('LISTEN_ADDR=')).length, 1, '托管键不能重复');
  });

  it('缺密钥时显式报错而不是写出免鉴权配置', async () => {
    await assert.rejects(
      () => adapter.generateConfig(ctx, { port: 2048 }, installPath),
      /缺少 API 密钥/
    );
  });

  it('启动参数关闭界面并按平台定位二进制', async () => {
    assert.equal((await adapter.checkEnvironment(ctx, 'adapter')).ready, true);
    const start = await adapter.prepareStart(ctx, installPath, { port: 2048 });
    assert.equal(path.basename(start.command), expectedBin);
    assert.deepEqual(start.args, ['-open-ui=false']);
    assert.equal(start.cwd, installPath);
    assert.equal(await adapter.prepareStop(ctx, installPath, {}), null);
  });

  it('更新收尾只核对版本，不碰配置与账户', async () => {
    const result = await adapter.upgrade(ctx, installPath, {}, () => {});
    assert.equal(result.ok, true);
    assert.match(result.message, /v0\.3\.1/);
  });

  it('面板数据区分管理进程与生成服务状态', async () => {
    const status = await adapter.getGatewayStatus(ctx, 2048);
    assert.equal(status.service, 'AIStudio2API');
    assert.equal(status.state, '运行中');
    assert.equal(status.apiBase, 'http://127.0.0.1:2048/v1');
    assert.equal(status.version, 'v0.3.1');
    assert.equal(status.models, 2);
    assert.equal(status.apiKey, 'smoke-key');
    assert.ok(fetched.some((u) => u.endsWith('/api/status')));
    assert.ok(fetched.some((u) => u.endsWith('/v1/models')));
  });

  it('控制台动作打开上游根路径', async () => {
    const result = await adapter.openConsole(ctx, 2048);
    assert.equal(result.url, 'http://127.0.0.1:2048/');
    assert.ok(executed.length > 0);
  });

  it('卸载前把账户凭证备份到用户目录', async () => {
    await fs.mkdir(path.join(installPath, 'auths'), { recursive: true });
    await fs.writeFile(path.join(installPath, 'auths', 'account.json'), '{}', 'utf-8');
    const result = await adapter.prepareUninstall(ctx, installPath, {});
    assert.ok(result.backupPath.startsWith(smokeHome));
    assert.ok(result.backupPath.includes('aistudio2api-backup-'));
    await fs.access(path.join(result.backupPath, 'auths', 'account.json'));
  });
});
