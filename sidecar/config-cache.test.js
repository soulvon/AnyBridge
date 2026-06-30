import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getCodexProxyRoutes, getModelMapConfig, getProxyRoutes, invalidate } from './config-cache.js';

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
      assert.deepEqual(config.enhancement.customHeaders, [{ key: 'x-test', value: '1' }]);
      assert.deepEqual(config.enhancement.responseHeaders, [{ key: 'x-response', value: '2' }]);
      assert.deepEqual(config.enhancement.paramOverrides, { top_p: 0.7 });
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
});
