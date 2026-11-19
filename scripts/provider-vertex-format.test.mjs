import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = [
  fs.readFileSync(path.join(root, 'ui/assets/scripts/40-model-picker.js'), 'utf8'),
  ...fs.readdirSync(path.join(root, 'ui/assets/scripts/model-picker'))
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(root, 'ui/assets/scripts/model-picker', f), 'utf8')),
].join('\n');
const platformsSrc = fs.readFileSync(path.join(root, 'ui/assets/scripts/platforms/antigravity_models.js'), 'utf8');
const presetsSrc = fs.readFileSync(path.join(root, 'ui/assets/scripts/35-provider-presets.js'), 'utf8');

function extractFn(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `未找到函数 ${name}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 括号未闭合`);
}

function loadPickerHelpers() {
  const factory = new Function(`
    ${extractFn(src, 'cleanProviderApiPath')}
    ${extractFn(src, 'isGeneratedProviderApiPath')}
    ${extractFn(src, 'displayProviderApiPath')}
    ${extractFn(src, 'providerEndpointParts')}
    ${extractFn(src, 'inferExplicitFormatFromEndpoint')}
    ${extractFn(src, 'autoDetectFormatFromHost')}
    ${extractFn(platformsSrc, 'isOfficialGoogleGeminiOnlyEndpointForUi')}
    ${extractFn(platformsSrc, 'inferProviderApiFormat')}
    return {
      cleanProviderApiPath,
      isGeneratedProviderApiPath,
      displayProviderApiPath,
      providerEndpointParts,
      inferExplicitFormatFromEndpoint,
      autoDetectFormatFromHost,
      inferProviderApiFormat,
    };
  `);
  return factory();
}

test('autoDetectFormatFromHost recognizes Vertex Express global endpoint without misclassifying regional Claude', () => {
  const { autoDetectFormatFromHost } = loadPickerHelpers();

  assert.equal(autoDetectFormatFromHost('https://aiplatform.googleapis.com'), 'gemini');
  assert.equal(autoDetectFormatFromHost('https://aiplatform.googleapis.com/v1/publishers/google/models'), 'gemini');
  assert.equal(
    autoDetectFormatFromHost('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models'),
    'gemini',
  );
  assert.equal(
    autoDetectFormatFromHost('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4:rawPredict'),
    'anthropic',
  );
  assert.equal(
    autoDetectFormatFromHost('https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/chat/completions'),
    'openai',
  );
});

test('Vertex custom /v1/publishers/google/models path is preserved during editor display and save', () => {
  const { isGeneratedProviderApiPath, displayProviderApiPath, providerEndpointParts } = loadPickerHelpers();

  assert.equal(isGeneratedProviderApiPath('gemini', '/v1beta/models/gemini-2.5-pro:generateContent'), true);
  assert.equal(isGeneratedProviderApiPath('gemini', '/v1beta/models'), true);

  assert.equal(isGeneratedProviderApiPath('gemini', '/v1/publishers/google/models'), false);
  assert.equal(isGeneratedProviderApiPath('gemini', '/v1/publishers/google/models/gemini-3.8-flash:generateContent'), false);

  assert.equal(displayProviderApiPath('gemini', '/v1/publishers/google/models'), '/v1/publishers/google/models');
  assert.deepEqual(
    providerEndpointParts('https://aiplatform.googleapis.com', 'gemini', '/v1/publishers/google/models'),
    {
      apiHost: 'https://aiplatform.googleapis.com',
      apiPath: '/v1/publishers/google/models',
    },
  );
});

test('inferProviderApiFormat keeps AI Studio and Vertex endpoints as gemini when adding/healing Antigravity models', () => {
  const { inferProviderApiFormat, autoDetectFormatFromHost } = loadPickerHelpers();

  assert.equal(autoDetectFormatFromHost('https://aiplatform.us.rep.googleapis.com'), 'gemini');

  // 官方 AI Studio（即便历史 provider 未写 apiFormat 或误存 openai）必须判为 gemini
  assert.equal(
    inferProviderApiFormat({
      apiHost: 'https://generativelanguage.googleapis.com',
      apiPath: '/v1beta',
    }, 'gemini-2.5-pro'),
    'gemini',
  );
  assert.equal(
    inferProviderApiFormat({
      apiHost: 'https://generativelanguage.googleapis.com',
      apiPath: '',
      apiFormat: 'openai',
    }, 'gemini-2.5-pro'),
    'gemini',
  );

  // 官方 Google AI Studio 明确配了 OpenAI 兼容入口时尊重 openai
  assert.equal(
    inferProviderApiFormat({
      apiHost: 'https://generativelanguage.googleapis.com',
      apiPath: '/v1beta/openai/chat/completions',
      apiFormat: 'openai',
    }, 'gemini-2.5-pro'),
    'openai',
  );

  // Vertex Express / Standard 必须判为 gemini，而 Vertex Claude 必须保持 anthropic
  assert.equal(
    inferProviderApiFormat({
      apiHost: 'https://aiplatform.googleapis.com',
      apiPath: '/v1/publishers/google/models',
    }, 'gemini-3.8-flash'),
    'gemini',
  );
  assert.equal(
    inferProviderApiFormat({
      apiHost: 'https://us-central1-aiplatform.googleapis.com',
      apiPath: '/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4:rawPredict',
      apiFormat: 'anthropic',
    }, 'claude-sonnet-4'),
    'anthropic',
  );

  // 官方 AI Studio OpenAI 兼容入口不带尾随斜杠也必须保持 openai
  assert.equal(autoDetectFormatFromHost('https://generativelanguage.googleapis.com/v1beta/openai'), 'openai');
  assert.equal(
    inferProviderApiFormat({
      apiHost: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiPath: '',
      apiFormat: 'openai',
    }, 'gemini-2.5-pro'),
    'openai',
  );
});

test('activeVertexRegionPreset only triggers for Standard Vertex /projects/.../locations/... and uses loadingHtml spinner', () => {
  const activePresetFn = extractFn(presetsSrc, 'activeVertexRegionPreset');
  assert.doesNotMatch(presetsSrc, /\.textContent\s*=\s*['"]测速中/, '测速按钮禁用态必须用 loadingHtml 带 spinner');
  assert.match(presetsSrc, /loadingHtml\((?:busyText|'测速中…')/);

  const runWithDom = (hostVal, pathVal, activeId = '') => {
    const doc = {
      getElementById(id) {
        if (id === 'pf-host') return { value: hostVal };
        if (id === 'pf-path') return { value: pathVal };
        return null;
      },
    };
    const g = {
      PROVIDER_PRESET_ACTIVE_ID: activeId,
      PROVIDER_PRESET_CATALOG: { providers: [{ id: 'vertexai', regions: [{ id: 'global', label: '全球' }] }] },
    };
    const fn = new Function('document', 'globalThis', `${activePresetFn}; return activeVertexRegionPreset();`);
    return fn(doc, g);
  };

  assert.equal(runWithDom('https://aiplatform.googleapis.com', '/v1/publishers/google/models'), null);
  assert.equal(runWithDom('https://aiplatform.googleapis.com', ''), null);
  assert.ok(runWithDom('https://aiplatform.googleapis.com', '/v1/projects/demo/locations/global/publishers/google/models'));
});

