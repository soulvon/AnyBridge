// plugin-loader 部署链路：adapter 回传的密钥必须进入 configValues，
// 否则 Rust 侧登记的本地供应商与网关实际使用的钥匙不是同一把（拉取模型 401）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(root, 'tmp', 'plugin-loader-test');
const pluginsDir = path.join(testRoot, 'plugins');
const pluginDir = path.join(pluginsDir, 'mockgateway');
const installPath = path.join(testRoot, 'install');
const previousPluginsDir = process.env.ANYBRIDGE_PLUGINS_DIR;

let runDeploy;

describe('plugin-loader runDeploy', () => {
  before(async () => {
    process.env.ANYBRIDGE_PLUGINS_DIR = pluginsDir;
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(installPath, { recursive: true });

    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      apiVersion: 1,
      id: 'mockgateway',
      name: 'Mock',
      description: '',
      version: '1.0.0',
      runtime: { type: 'binary' },
      healthCheck: { type: 'http' },
      configSchema: [{ key: 'apiKey', label: '密钥', type: 'password', generate: 'base64-32' }],
      capabilities: [],
      panels: [],
      deploy: { strategies: ['adapter'], adapter: { doc: 'deploy.md' } },
    }));
    await fs.writeFile(
      path.join(pluginDir, 'adapter.js'),
      "export default { async generateConfig(ctx, configValues, installPath) { return { configPath: ctx.path.join(installPath, '.env'), apiKey: 'from-adapter' }; } };\n"
    );
    await fs.writeFile(
      path.join(pluginDir, 'deploy.md'),
      '# Deploy\n\n## Strategy: Adapter\n\n### Steps\n\n#### 1. 由 adapter 接管\n\n无需执行 shell 命令。\n'
    );

    ({ runDeploy } = await import('./plugin-loader.js'));
  });

  after(async () => {
    if (previousPluginsDir === undefined) delete process.env.ANYBRIDGE_PLUGINS_DIR;
    else process.env.ANYBRIDGE_PLUGINS_DIR = previousPluginsDir;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('把 generateConfig 回传的密钥写回 configValues 与部署记录', async () => {
    const out = await runDeploy(
      { pluginId: 'mockgateway', strategy: 'adapter', installPath, configValues: { port: 2048 } },
      () => {}
    );
    assert.equal(out.ok, true, `部署失败：${JSON.stringify(out)}`);
    assert.equal(out.result.configValues.apiKey, 'from-adapter');
    const persisted = JSON.parse(
      await fs.readFile(path.join(installPath, '.anybridge-plugin-config.json'), 'utf-8')
    );
    assert.equal(persisted.apiKey, 'from-adapter');
  });
});
