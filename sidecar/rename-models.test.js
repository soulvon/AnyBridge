import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { unlockModels } from './rename-models.js';

function withConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-rename-models-'));
  const previousConfigDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previousConfigDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function statusBody(entries) {
  return Buffer.from(JSON.stringify({
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: entries,
      },
    },
  }), 'utf8');
}

test('unlockModels=false keeps configured routes but does not rewrite unconfigured entries', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'Provider One' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    labelTemplate: '{label} via {provider}',
    enhancement: { unlockModels: false },
    slots: [{
      modelUid: 'MODEL_CONFIGURED',
      displayName: 'Configured Model',
      enabled: true,
      supportsImages: true,
      targets: [{ providerId: 'p1', model: 'upstream-model' }],
    }],
  }), 'utf8');

  const result = unlockModels(statusBody([
    { modelUid: 'MODEL_CONFIGURED', label: 'Original Configured', disabled: true },
    { modelUid: 'MODEL_LOCKED', label: 'Locked Official', disabled: true },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const rows = json.userStatus.cascadeModelConfigData.clientModelConfigs;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.modelUid === 'MODEL_CONFIGURED'), {
    modelUid: 'MODEL_CONFIGURED',
    label: 'Configured Model via Provider One',
    disabled: false,
    supportsImages: true,
  });
  assert.deepEqual(rows.find(row => row.modelUid === 'MODEL_LOCKED'), {
    modelUid: 'MODEL_LOCKED',
    label: 'Locked Official',
    disabled: true,
  });
}));

test('unlockModels=false with no configured routes leaves the response untouched', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    enhancement: { unlockModels: false },
    slots: [],
  }), 'utf8');

  const body = statusBody([{ modelUid: 'MODEL_LOCKED', label: 'Locked Official', disabled: true }]);
  assert.equal(unlockModels(body), null);
}));
