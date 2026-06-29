import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getModelMapConfig, invalidate } from './config-cache.js';

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
    } finally {
      invalidate('all');
      if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
      else process.env.BYOK_CONFIG_DIR = previousConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
