import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractModelList, unlockModels, renameModels } from './rename-models.js';
import {
  parseFields,
  writeMessageField,
  writeStringField,
  writeVarintField,
} from './proto.js';

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

test('slot.contextWindow overrides GetUserStatus contextWindow for configured routes', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'Provider One' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    labelTemplate: '{label}',
    enhancement: { unlockModels: false },
    slots: [{
      modelUid: 'MODEL_CONFIGURED',
      displayName: 'Configured Model',
      enabled: true,
      supportsImages: true,
      contextWindow: 200000,
      targets: [{ providerId: 'p1', model: 'upstream-model' }],
    }],
  }), 'utf8');

  const result = unlockModels(statusBody([
    { modelUid: 'MODEL_CONFIGURED', label: 'Original', disabled: true, contextWindow: 32000 },
    { modelUid: 'MODEL_LOCKED', label: 'Locked Official', disabled: true, contextWindow: 64000 },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const rows = json.userStatus.cascadeModelConfigData.clientModelConfigs;
  assert.equal(rows.find(row => row.modelUid === 'MODEL_CONFIGURED').contextWindow, 200000);
  assert.equal(rows.find(row => row.modelUid === 'MODEL_LOCKED').contextWindow, 64000);
}));

test('missing slot.contextWindow keeps upstream contextWindow', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'Provider One' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    labelTemplate: '{label}',
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
    { modelUid: 'MODEL_CONFIGURED', label: 'Original', disabled: true, contextWindow: 32000 },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const row = json.userStatus.cascadeModelConfigData.clientModelConfigs
    .find(item => item.modelUid === 'MODEL_CONFIGURED');
  assert.equal(row.contextWindow, 32000);
}));

test('official visibility keeps officially available models and does not release disabled ones', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'CPA' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'ide-models.json'), JSON.stringify({
    accountModelIds: ['swe-1-6-slow', 'MODEL_CLAUDE_3_5_SONNET'],
    models: [
      { modelUid: 'swe-1-6-slow', label: 'SWE-1.6 Slow' },
      { modelUid: 'MODEL_CLAUDE_3_5_SONNET', label: 'Claude 3.5 Sonnet' },
    ],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    slotVisibilityMode: 'official',
    slots: [{
      modelUid: 'gemini-3-7-flash-medium',
      displayName: 'gemini-3.8-flash-high',
      enabled: true,
      targets: [{ providerId: 'p1', model: 'gemini-3.8-flash-high' }],
    }],
  }), 'utf8');

  const result = unlockModels(statusBody([
    { modelUid: 'swe-1-6-slow', label: 'SWE-1.6 Slow', disabled: false },
    { modelUid: 'MODEL_CLAUDE_3_5_SONNET', label: 'Claude 3.5 Sonnet', disabled: true },
    { modelUid: 'gemini-3-7-flash-medium', label: 'Gemini 3.7 Flash Medium', disabled: true },
    { modelUid: 'RANDOM_UNKNOWN_MODEL', label: 'Random Unknown', disabled: true },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const rows = json.userStatus.cascadeModelConfigData.clientModelConfigs;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.modelUid === 'gemini-3-7-flash-medium').label, 'gemini-3.8-flash-high (CPA)');
  assert.equal(rows.find(r => r.modelUid === 'gemini-3-7-flash-medium').disabled, false);
  assert.equal(rows.find(r => r.modelUid === 'swe-1-6-slow').label, 'SWE-1.6 Slow (官方)');
  assert.equal(rows.find(r => r.modelUid === 'swe-1-6-slow').disabled, false);
  assert.equal(rows.find(r => r.modelUid === 'MODEL_CLAUDE_3_5_SONNET'), undefined);
  assert.equal(rows.find(r => r.modelUid === 'RANDOM_UNKNOWN_MODEL'), undefined);
}));

test('normalizes dotted modelUid (gemini-3.7) to dash format for matching official response', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'CPA' }],
  }), 'utf8');
  // 槽位用点格式（JSON API / catalog 旧数据），官方 protobuf 响应用连字符格式
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    slotVisibilityMode: 'official',
    slots: [{
      modelUid: 'gemini-3.7-flash-high',
      displayName: 'gemini-3.7-flash-high',
      enabled: true,
      targets: [{ providerId: 'p1', model: 'gemini-3.7-flash-high' }],
    }],
  }), 'utf8');

  const result = unlockModels(statusBody([
    { modelUid: 'gemini-3-7-flash-high', label: 'Gemini 3.7 Flash High', disabled: true },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const rows = json.userStatus.cascadeModelConfigData.clientModelConfigs;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelUid, 'gemini-3-7-flash-high');
  assert.equal(rows[0].label, 'gemini-3.7-flash-high (CPA)');
  assert.equal(rows[0].disabled, false);
}));

test('label display options: showSlotUid, showThinkingEffort, showContextWindow', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'CPA' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    showSlotUid: true,
    showThinkingEffort: true,
    showContextWindow: true,
    slots: [{
      modelUid: 'gemini-3-7-flash-high',
      displayName: 'gemini-flash',
      enabled: true,
      contextWindow: 1048576,
      thinkingEffort: 'auto',
      targets: [{ providerId: 'p1', model: 'gemini-flash' }],
    }],
  }), 'utf8');

  const result = unlockModels(statusBody([
    { modelUid: 'gemini-3-7-flash-high', label: 'Gemini 3.7 Flash High', disabled: false },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const rows = json.userStatus.cascadeModelConfigData.clientModelConfigs;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'gemini-3.7-flash-high>gemini-flash High [1M] (CPA)');
}));

test('advanced label template supports {slotUid}, {effort}, {context}', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'CPA' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    labelTemplate: '{slotUid} :: {label} :: {effort} :: {context} ({provider})',
    slots: [{
      modelUid: 'gpt-5-6-sol-medium',
      displayName: 'GPT-5.6',
      enabled: true,
      contextWindow: 200000,
      thinkingEffort: 'low',
      targets: [{ providerId: 'p1', model: 'gpt-5.6' }],
    }],
  }), 'utf8');

  const result = unlockModels(statusBody([
    { modelUid: 'gpt-5-6-sol-medium', label: 'GPT-5.6 Sol Medium', disabled: false },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const rows = json.userStatus.cascadeModelConfigData.clientModelConfigs;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'gpt-5.6-sol-medium :: GPT-5.6 :: Low :: 200K (CPA)');
}));

test('shorthand slot uid resolves canonical effort (deepseek-v4-pro → High)', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: '商汤' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    showThinkingEffort: true,
    slots: [{
      modelUid: 'deepseek-v4-pro',
      displayName: 'deepseek-v4-pro',
      enabled: true,
      targets: [{ providerId: 'p1', model: 'deepseek-v4-pro' }],
    }],
  }), 'utf8');

  const result = unlockModels(statusBody([
    { modelUid: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', disabled: false },
  ]));

  assert.ok(result);
  const json = JSON.parse(result.body.toString('utf8'));
  const rows = json.userStatus.cascadeModelConfigData.clientModelConfigs;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'deepseek-v4-pro High (商汤)');
}));

function buildClientModelConfigProto({ label, modelUid, disabled = false, supportsImages = false, contextWindow = 128000 }) {
  return Buffer.concat([
    writeStringField(1, label),
    writeMessageField(2, writeVarintField(1, 1)),
    ...(disabled ? [writeVarintField(4, 1)] : []),
    ...(supportsImages ? [writeVarintField(5, 1)] : []),
    writeVarintField(18, contextWindow),
    writeStringField(22, modelUid),
  ]);
}

function cliModelConfigsProto(entries) {
  return Buffer.concat(entries.map((entry) => writeMessageField(1, buildClientModelConfigProto(entry))));
}

function extractClientModelEntries(protoBuf) {
  return parseFields(protoBuf)
    .filter((f) => f.field === 1 && f.wireType === 2)
    .map((entryField) => {
      const sub = parseFields(entryField.value);
      const getStr = (num) => sub.find((f) => f.field === num && f.wireType === 2)?.value.toString('utf8');
      const getVar = (num) => sub.find((f) => f.field === num && f.wireType === 0)?.value;
      return {
        label: getStr(1),
        modelUid: getStr(22),
        disabled: Boolean(getVar(4)),
        supportsImages: Boolean(getVar(5)),
      };
    });
}

test('unlockModels rewrites bare application/proto GetCliModelConfigs without Connect envelope', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'Provider One' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    labelTemplate: '{label} ({provider})',
    enhancement: { unlockModels: true },
    slots: [{
      modelUid: 'claude-opus-4-8-high',
      displayName: 'Custom Opus',
      enabled: true,
      supportsImages: true,
      targets: [{ providerId: 'p1', model: 'upstream-opus' }],
    }],
  }), 'utf8');

  const rawCliConfigs = cliModelConfigsProto([
    { modelUid: 'claude-opus-4-8-high', label: 'Claude Opus 4.8 High', disabled: true, supportsImages: false },
    { modelUid: 'swe-1-6-slow', label: 'SWE 1.6 Slow', disabled: false },
  ]);

  const result = unlockModels(rawCliConfigs);
  assert.ok(result, 'bare protobuf GetCliModelConfigs must not return null');
  assert.ok(result.changed >= 1);
  assert.equal(Boolean(result.wasConnect), false);
  assert.equal(result.recompressed, false);

  const entries = extractClientModelEntries(result.body);
  assert.equal(entries.length, 2);
  const custom = entries.find((e) => e.modelUid === 'claude-opus-4-8-high');
  assert.equal(custom?.label, 'Custom Opus (Provider One)');
  assert.equal(custom?.disabled, false);
  assert.equal(custom?.supportsImages, true);
}));

test('renameModels rewrites bare application/proto payload without Connect envelope', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'ide-models.json'), JSON.stringify({
    models: [{ modelUid: 'claude-opus-4-8-high', label: 'Claude Opus 4.8 High' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    slots: [{
      modelUid: 'claude-opus-4-8-high',
      displayName: 'Renamed Opus',
      enabled: true,
    }],
  }), 'utf8');

  const rawCliConfigs = cliModelConfigsProto([
    { modelUid: 'claude-opus-4-8-high', label: 'Claude Opus 4.8 High', disabled: false },
  ]);

  const result = renameModels(rawCliConfigs);
  assert.ok(result, 'renameModels must handle bare protobuf');
  assert.equal(Boolean(result.wasConnect), false);
  const entries = extractClientModelEntries(result.body);
  assert.equal(entries[0]?.label, 'Renamed Opus');
}));

test('extractModelList extracts models from bare application/proto payload', () => {
  const rawCliConfigs = cliModelConfigsProto([
    { modelUid: 'claude-opus-4-8-high', label: 'Claude Opus 4.8 High', disabled: true },
    { modelUid: 'swe-1-6-slow', label: 'SWE 1.6 Slow', disabled: false },
  ]);
  const extracted = extractModelList(rawCliConfigs);
  assert.deepEqual(extracted, [
    { modelUid: 'claude-opus-4-8-high', label: 'Claude Opus 4.8 High' },
    { modelUid: 'swe-1-6-slow', label: 'SWE 1.6 Slow' },
  ]);
});

test('unlockModels preserves Connect envelope when input is Connect-framed protobuf', () => withConfigDir((dir) => {
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'Provider One' }],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify({
    labelTemplate: '{label}',
    slots: [{
      modelUid: 'claude-opus-4-8-high',
      displayName: 'Custom Opus',
      enabled: true,
      targets: [{ providerId: 'p1', model: 'upstream-opus' }],
    }],
  }), 'utf8');

  const protoPayload = cliModelConfigsProto([
    { modelUid: 'claude-opus-4-8-high', label: 'Original', disabled: true },
  ]);
  const envelope = Buffer.alloc(5 + protoPayload.length);
  envelope[0] = 0;
  envelope.writeUInt32BE(protoPayload.length, 1);
  protoPayload.copy(envelope, 5);

  const result = unlockModels(envelope);
  assert.ok(result);
  assert.equal(result.wasConnect, true);
  assert.equal(result.body[0], 0);
  const innerLen = result.body.readUInt32BE(1);
  assert.equal(innerLen, result.body.length - 5);
  const entries = extractClientModelEntries(result.body.subarray(5));
  assert.equal(entries[0]?.label, 'Custom Opus');
}));
