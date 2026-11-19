import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getCodexProxyRoutes, getModelMapConfig, getProviders, getProxyRoutes, invalidate } from './config-cache.js';
import { readProvidersJson } from './lib/local-proxy/routes.js';
import { rememberProviderToolSchemaCompat, resolveTarget, updateModelCapabilities } from './provider-pool.js';

describe('config-cache model-map enhancement', () => {
  it('preserves selfHeal switches from model-map.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-config-cache-'));
    const previousConfigDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = dir;
    invalidate('all');

    try {
      fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
        enhancement: {
          selfHeal: {
            enabled: false,
            budget: false,
          },
        },
      }), 'utf8');

      const config = getModelMapConfig();
      assert.deepEqual(config.enhancement.selfHeal, {
        enabled: false,
        signature: true,
        budget: false,
        media: true,
      });
      assert.equal(config.enhancement.visionMaxTokens, 2048);
      assert.equal(config.enhancement.visionContextMode, 'current');
      assert.equal(config.enhancement.visionMultiImageMode, 'single');
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes third-party vision enhancement settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-config-cache-'));
    const previousConfigDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = dir;
    invalidate('all');

    try {
      fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
        enhancement: {
          visionMaxTokens: 4096,
          visionContextMode: 'summary',
          visionContextMaxChars: 12000,
          visionMultiImageMode: 'chunk',
          visionBatchSize: 4,
        },
      }), 'utf8');

      const config = getModelMapConfig();
      assert.equal(config.enhancement.visionMaxTokens, 4096);
      assert.equal(config.enhancement.visionContextMode, 'summary');
      assert.equal(config.enhancement.visionContextMaxChars, 12000);
      assert.equal(config.enhancement.visionMultiImageMode, 'chunk');
      assert.equal(config.enhancement.visionBatchSize, 4);
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves advanced proxy enhancement switches and rename rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-config-cache-'));
    const previousConfigDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = dir;
    invalidate('all');

    try {
      fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
        enhancement: {
          systemPromptPrefix: 'prefix',
          systemPromptPrefixEnabled: true,
          customHeaders: [{ key: 'x-test', value: '1' }],
          customHeadersEnabled: true,
          responseHeaders: [{ key: 'x-response', value: '2' }],
          paramOverrides: { top_p: 0.7 },
          paramOverridesEnabled: true,
          toolFilterMode: 'allow',
          toolFilterList: ['read_file'],
          forceToolChoice: 'auto',
          toolFilterEnabled: true,
          rateLimitRpm: 12,
          rateLimitEnabled: true,
          requestLogging: true,
          unlockModels: false,
          webSearchEnabled: true,
          webSearchMaxResults: 7,
          webSearchMaxRounds: 2,
        },
        searchModels: {
          searchSources: [{
            id: 'src-1',
            name: 'DuckDuckGo',
            type: 'engine',
            engine: 'duckduckgo',
            enabled: true,
          }],
        },
        proxyRouteRenameRule: {
          enabled: true,
          mode: 'simple',
          prefix: 'AB-',
          suffix: '',
        },
      }), 'utf8');

      const config = getModelMapConfig();
      assert.equal(config.enhancement.systemPromptPrefixEnabled, true);
      assert.equal(config.enhancement.customHeadersEnabled, true);
      assert.equal(config.enhancement.paramOverridesEnabled, true);
      assert.equal(config.enhancement.toolFilterEnabled, true);
      assert.equal(config.enhancement.rateLimitEnabled, true);
      assert.equal(config.enhancement.requestLogging, true);
      assert.equal(config.enhancement.unlockModels, false);
      assert.equal(config.enhancement.webSearchEnabled, true);
      assert.equal(config.enhancement.webSearchMaxResults, 7);
      assert.equal(config.enhancement.webSearchMaxRounds, 2);
      assert.deepEqual(config.enhancement.customHeaders, [{ key: 'x-test', value: '1' }]);
      assert.deepEqual(config.enhancement.responseHeaders, [{ key: 'x-response', value: '2' }]);
      assert.deepEqual(config.enhancement.paramOverrides, { top_p: 0.7 });
      assert.deepEqual(config.searchModels.searchSources, [{
        id: 'src-1',
        name: 'DuckDuckGo',
        type: 'engine',
        engine: 'duckduckgo',
        enabled: true,
      }]);
      assert.deepEqual(config.proxyRouteRenameRule, {
        enabled: true,
        mode: 'simple',
        prefix: 'AB-',
        suffix: '',
        template: '',
      });
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves target-level api key overrides in proxy routes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-config-cache-'));
    const previousConfigDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = dir;
    invalidate('all');

    try {
      fs.writeFileSync(path.join(dir, 'proxy-routes.json'), JSON.stringify({
        version: 1,
        routes: [{
          id: 'route-a',
          exposedFormats: ['openai'],
          targets: [{
            providerId: 'provider-a',
            model: 'model-a',
            apiKeys: [' key-1 ', '', 'key-2'],
          }],
        }],
      }), 'utf8');

      const config = getProxyRoutes();
      assert.equal(config.loadError, undefined);
      assert.deepEqual(config.routes[0].targets[0].apiKeys, ['key-1', 'key-2']);
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Codex proxy routes separate from global proxy routes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-config-cache-'));
    const previousConfigDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = dir;
    invalidate('all');

    try {
      fs.writeFileSync(path.join(dir, 'proxy-routes.json'), JSON.stringify({
        version: 1,
        routes: [{
          id: 'deepseek-v4-flash',
          exposedFormats: ['openai'],
          targets: [{ providerId: 'global-provider', model: 'deepseek-v4-flash' }],
        }],
      }), 'utf8');
      fs.writeFileSync(path.join(dir, 'codex-proxy-routes.json'), JSON.stringify({
        version: 1,
        routes: [{
          id: 'deepseek-v4-flash',
          exposedFormats: ['openai'],
          source: 'codex:codex-provider',
          targets: [{ providerId: 'codex-provider', model: 'deepseek-v4-flash' }],
        }],
      }), 'utf8');

      const globalConfig = getProxyRoutes();
      const codexConfig = getCodexProxyRoutes();
      assert.equal(globalConfig.routes[0].targets[0].providerId, 'global-provider');
      assert.equal(codexConfig.routes[0].targets[0].providerId, 'codex-provider');
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains last healthy providers & proxyRoutes snapshot on corrupt disk JSON and honors invalidate(proxyRoutes)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-config-cache-'));
    const previousConfigDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = dir;
    invalidate('all');

    try {
      const providersFile = path.join(dir, 'providers.json');
      const routesFile = path.join(dir, 'proxy-routes.json');
      fs.writeFileSync(providersFile, JSON.stringify({
        providers: [{ id: 'p-1', name: 'P1', apiHost: 'https://api.example.com', apiKey: 'sk-ok', enabled: true }],
      }), 'utf8');
      fs.writeFileSync(routesFile, JSON.stringify({
        version: 1,
        routes: [{ id: 'm-1', exposedFormats: ['openai'], targets: [{ providerId: 'p-1', model: 'm-1' }] }],
      }), 'utf8');

      const healthyProviders = getProviders();
      const healthyRoutes = getProxyRoutes();
      assert.equal(healthyProviders.get('p-1')?.apiKey, 'sk-ok');
      assert.equal(healthyRoutes.routes.length, 1);

      // 模拟半写入/坏 JSON 并强制 invalidate 重读
      fs.writeFileSync(providersFile, '{"providers": [broken', 'utf8');
      fs.writeFileSync(routesFile, '{"routes": [broken', 'utf8');
      invalidate('all');

      assert.equal(getProviders().get('p-1')?.apiKey, 'sk-ok', 'providers.json 损坏时不得清空健康缓存');
      assert.equal(getProxyRoutes().routes[0]?.id, 'm-1', 'proxy-routes.json 损坏时不得清空健康路由');

      // 写回有效新路由保持相同 mtime 时，invalidate('proxyRoutes') 必须立刻生效
      const prevStat = fs.statSync(routesFile);
      fs.writeFileSync(routesFile, JSON.stringify({
        version: 1,
        routes: [{ id: 'm-2', exposedFormats: ['openai'], targets: [{ providerId: 'p-1', model: 'm-2' }] }],
      }), 'utf8');
      fs.utimesSync(routesFile, prevStat.atime, prevStat.mtime);
      invalidate('proxyRoutes');
      const reloadedRoutes = getProxyRoutes();
      assert.equal(reloadedRoutes.routes[0]?.id, 'm-2');
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges codexConfigs & sourceProviderId platforms live (apiKeys + enabled), syncs readProvidersJson, and never writes providers.json from pool', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-config-cache-'));
    const previousConfigDir = process.env.BYOK_CONFIG_DIR;
    process.env.BYOK_CONFIG_DIR = dir;
    invalidate('all');

    try {
      const providersFile = path.join(dir, 'providers.json');
      const initialContent = JSON.stringify({
        providers: [
          {
            id: 'main-live',
            name: 'MainLive',
            apiHost: 'https://live.example.com',
            apiKey: 'sk-main-1',
            apiKeys: ['sk-main-1', 'sk-main-2'],
            enabled: true,
          },
          {
            id: 'main-off',
            name: 'MainOff',
            apiHost: 'https://off.example.com',
            apiKey: 'sk-off',
            enabled: false,
          },
        ],
        codexConfigs: [
          { id: 'codex-linked', name: 'Codex Linked', sourceProviderId: 'main-live', enabled: true },
          { id: 'codex-disabled-src', name: 'Codex Off', sourceProviderId: 'main-off', enabled: true },
          { id: 'codex-missing-src', name: 'Codex Missing', sourceProviderId: 'nonexistent', enabled: true },
        ],
        claudeCodeConfigs: [
          { id: 'cc-linked', name: 'CC Linked', sourceProviderId: 'main-live', apiFormat: 'anthropic', enabled: true },
        ],
      }, null, 2);
      fs.writeFileSync(providersFile, initialContent, 'utf8');
      invalidate('providers');

      const map = getProviders();
      const codexLinked = map.get('codex-linked');
      assert.equal(codexLinked.enabled, true);
      assert.equal(codexLinked.apiHost, 'https://live.example.com');
      assert.equal(codexLinked.apiFormat, 'openai');
      assert.deepEqual(codexLinked.apiKeys, ['sk-main-1', 'sk-main-2']);

      assert.equal(map.get('codex-disabled-src').enabled, false, '源供应商禁用时 codexConfig 必须禁用');
      assert.equal(map.get('codex-missing-src').enabled, false, '源供应商缺失时 codexConfig 必须禁用');
      assert.deepEqual(map.get('cc-linked').apiKeys, ['sk-main-1', 'sk-main-2']);
      assert.equal(readProvidersJson().providers[0].id, 'main-live');

      // sidecar 运行期能力标记仅更新内存，绝不改写 providers.json
      assert.equal(rememberProviderToolSchemaCompat('main-live', 'gemini'), true);
      assert.equal(updateModelCapabilities('main-live', 'gpt-5', true, true), true);
      const resolved = resolveTarget({ providerId: 'main-live', model: 'gpt-5' }, map);
      assert.equal(resolved.capabilities.toolSchemaCompat, 'gemini');
      assert.equal(resolved.capabilities.vision, true);
      assert.equal(resolved.capabilities.tools, true);
      assert.equal(fs.readFileSync(providersFile, 'utf8'), initialContent, 'provider-pool 严禁修改磁盘 providers.json');
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
