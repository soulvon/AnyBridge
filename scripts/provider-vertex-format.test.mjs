import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'ui/assets/scripts/40-model-picker.js'), 'utf8');

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
    ${extractFn(src, 'autoDetectFormatFromHost')}
    return {
      cleanProviderApiPath,
      isGeneratedProviderApiPath,
      displayProviderApiPath,
      providerEndpointParts,
      autoDetectFormatFromHost,
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

