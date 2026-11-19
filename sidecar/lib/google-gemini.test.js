import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  buildGeminiCountTokensPayload,
  clearGeminiTokenCache,
  downgradeGeminiThinkingConfigOn400,
  healGemini400Payload,
  inferApiFormatFromEndpoint,
  isOfficialGoogleGeminiNativeOnlyEndpoint,
  normalizeGeminiApiPath,
  normalizeGeminiResponseJson,
  normalizeGeminiThinkingConfig,
  redactGeminiCredential,
  resolveGeminiAuthHeader,
  resolveGeminiEndpoint,
} from './google-gemini.js';
import {
  createAnthropicSSEFromGemini,
  createAntigravityGeminiRelay,
  createResponsesSSEFromGemini,
} from './gemini-sse-transform.js';
import { invalidate } from '../config-cache.js';
import { resolveTarget } from '../provider-pool.js';
import { handleLocalProxyRequest } from '../local-proxy.js';
import { parseSSEStream } from './local-proxy/transport.js';
import { buildGeminiUpstreamSpec } from '../handlers/chat/upstream-builders.js';
import { Readable } from 'node:stream';

import { closeServer, mockRes, startServer } from './google-gemini-test-helpers.js';

test('Google AI Studio & Vertex endpoints infer format accurately without hijacking Claude/OpenAI', () => {
  assert.equal(inferApiFormatFromEndpoint('https://generativelanguage.googleapis.com', null), 'gemini');
  assert.equal(inferApiFormatFromEndpoint('https://aiplatform.googleapis.com', '/v1/publishers/google/models'), 'gemini');
  assert.equal(inferApiFormatFromEndpoint('https://us-central1-aiplatform.googleapis.com', '/v1/projects/p/locations/us-central1/publishers/google/models'), 'gemini');
  assert.equal(inferApiFormatFromEndpoint('https://aiplatform.us.rep.googleapis.com', '/v1/projects/p/locations/us'), 'gemini');
  assert.equal(inferApiFormatFromEndpoint('https://us-central1-aiplatform.googleapis.com', '/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4:rawPredict'), 'anthropic');
  assert.equal(inferApiFormatFromEndpoint('https://aiplatform.googleapis.com', '/v1/projects/p/locations/global/endpoints/openapi/chat/completions'), 'openai');

  assert.equal(isOfficialGoogleGeminiNativeOnlyEndpoint('https://generativelanguage.googleapis.com', '/v1beta'), true);
  assert.equal(isOfficialGoogleGeminiNativeOnlyEndpoint('https://generativelanguage.googleapis.com', '/v1beta/openai/chat/completions'), false);
  assert.equal(isOfficialGoogleGeminiNativeOnlyEndpoint('https://aiplatform.googleapis.com', '/v1/publishers/google/models'), true);
  assert.equal(isOfficialGoogleGeminiNativeOnlyEndpoint('https://us-central1-aiplatform.googleapis.com', '/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4:rawPredict'), false);
});

test('Vertex regional hosts, Express paths, countTokens paths and {project} template resolution', () => {
  assert.equal(
    normalizeGeminiApiPath('https://aiplatform.googleapis.com', '/v1/publishers/google/models', 'gemini-3.8-flash', 'streamGenerateContent'),
    '/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
  );
  assert.equal(
    normalizeGeminiApiPath('https://aiplatform.googleapis.com', '/v1/projects/demo/locations/us-central1', 'gemini-2.5-pro', 'countTokens'),
    '/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-2.5-pro:countTokens',
  );

  const saJson = JSON.stringify({
    type: 'service_account',
    project_id: 'gcp-prod-99',
    client_email: 'sa@gcp-prod-99.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
  });
  const regional = resolveGeminiEndpoint(
    'https://aiplatform.googleapis.com',
    '/v1/projects/{project}/locations/europe-west4/publishers/google/models',
    'gemini-3.8-flash',
    saJson,
  );
  assert.equal(regional.hostname, 'europe-west4-aiplatform.googleapis.com');
  assert.equal(regional.apiPath, '/v1/projects/gcp-prod-99/locations/europe-west4/publishers/google/models/gemini-3.8-flash:generateContent');
  assert.equal(regional.isVertex, true);
  assert.equal(regional.isOAuth, true);

  const multiRegion = resolveGeminiEndpoint(
    'https://aiplatform.googleapis.com',
    '/v1/projects/{project}/locations/us/publishers/google/models',
    'gemini-2.5-pro',
    'ya29.token-123',
  );
  assert.equal(multiRegion.hostname, 'aiplatform.us.rep.googleapis.com');

  const docsVertexPath = resolveGeminiEndpoint(
    'https://us-central1-aiplatform.googleapis.com',
    '/publishers/google/models',
    'gemini-2.5-pro',
    saJson,
  );
  assert.equal(docsVertexPath.hostname, 'us-central1-aiplatform.googleapis.com');
  assert.equal(
    docsVertexPath.apiPath,
    '/v1/projects/gcp-prod-99/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent',
  );
});

test('Service Account RSA JWT signing, token caching, credential types and redaction', async () => {
  clearGeminiTokenCache();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const saCred = JSON.stringify({
    type: 'service_account',
    project_id: 'proj-jwt',
    client_email: 'bot@proj-jwt.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  });

  let tokenExchangeCount = 0;
  let capturedJwt = '';
  const mockPoster = async (_url, { form }) => {
    tokenExchangeCount += 1;
    capturedJwt = form.assertion;
    return { statusCode: 200, json: { access_token: 'ya29.minted-sa-token', expires_in: 3600 }, text: '{}' };
  };

  const auth1 = await resolveGeminiAuthHeader(saCred, { tokenPoster: mockPoster });
  const auth2 = await resolveGeminiAuthHeader(saCred, { tokenPoster: mockPoster });
  assert.deepEqual(auth1.headers, { authorization: 'Bearer ya29.minted-sa-token' });
  assert.equal(auth2.token, 'ya29.minted-sa-token');
  assert.equal(tokenExchangeCount, 1, 'cached token must prevent duplicate OAuth exchanges');

  const [hdrB64, claimsB64, sigB64] = capturedJwt.split('.');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${hdrB64}.${claimsB64}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(sigB64, 'base64url')), true, 'JWT RS256 signature must verify');
  const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8'));
  assert.equal(claims.iss, 'bot@proj-jwt.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');

  const expressAuth = await resolveGeminiAuthHeader('AQ.Ab8ExpressKey');
  assert.deepEqual(expressAuth.headers, { 'x-goog-api-key': 'AQ.Ab8ExpressKey' });

  const oauthAuth = await resolveGeminiAuthHeader('ya29.direct-token');
  assert.deepEqual(oauthAuth.headers, { authorization: 'Bearer ya29.direct-token' });

  const redacted = redactGeminiCredential(`Failed using ${privateKey} and ya29.secret_tok`, saCred);
  assert.equal(redacted.includes('BEGIN PRIVATE KEY'), false);
  assert.equal(redacted.includes('ya29.secret_tok'), false);
});

test('Gemini thinkingConfig normalization and 400 self-heal adapt 2.5 vs 3.x models', () => {
  const g3 = normalizeGeminiThinkingConfig({
    generationConfig: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
  }, { model: 'gemini-3.8-flash' });
  assert.deepEqual(g3.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM', includeThoughts: true });

  const g25 = normalizeGeminiThinkingConfig({
    generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } },
  }, { model: 'gemini-2.5-pro' });
  assert.deepEqual(g25.generationConfig.thinkingConfig, { thinkingBudget: 24576, includeThoughts: true });

  const healState = {};
  const minimalStep = downgradeGeminiThinkingConfigOn400({
    generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: true } },
  }, 'MINIMAL thinking_level is not supported', healState);
  assert.equal(minimalStep.payload.generationConfig.thinkingConfig.thinkingLevel, 'LOW');

  const dropStep = downgradeGeminiThinkingConfigOn400(minimalStep.payload, 'thinking_level is not supported by this model', healState);
  assert.equal(dropStep.payload.generationConfig.thinkingConfig, undefined);
});

test('Antigravity v1internal:streamGenerateContent streams Vertex/AI Studio SSE natively & fixes countTokens', async () => {
  const seenRequests = [];
  const { server, origin } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    seenRequests.push({ url: req.url, headers: req.headers, body });

    if (req.url.endsWith(':countTokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ totalTokens: 42 }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Thinking...', thought: true }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello Vertex!' }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [{
            functionCall: { name: 'lookup', args: { q: 'docs' } },
            thoughtSignature: 'sig-vertex-999',
          }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
    })}\n\n`);
    res.end();
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-ag-vertex-'));
  const prevDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = dir;
  invalidate('all');

  try {
    fs.writeFileSync(path.join(dir, 'byok-config.json'), JSON.stringify({
      values: { LOCAL_PROXY_KEY: 'test-local-key' },
    }), 'utf8');
    // 故意构造一个历史上错存了 apiFormat: "openai" 的官方 Vertex AI Studio 供应商配置，验证自动纠偏 + 真流式 + countTokens
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
      antigravityMode: 'pure',
      providers: [{
        id: 'p-vertex',
        name: 'Google Vertex',
        apiHost: origin,
        apiPath: '/v1/projects/demo-p/locations/global/publishers/google/models',
        apiKey: 'ya29.test-oauth-bearer',
        defaultModel: 'gemini-3.8-flash',
        models: ['gemini-3.8-flash'],
        enabled: true,
      }],
      antigravityConfigs: [{
        id: 'ag-p-vertex-gemini',
        name: 'gemini-3.8-flash',
        sourceProviderId: 'p-vertex',
        sourceProviderName: 'Google Vertex',
        apiHost: origin,
        apiPath: '/v1/projects/demo-p/locations/global/publishers/google/models',
        apiKey: 'ya29.test-oauth-bearer',
        apiFormat: 'openai',
        defaultModel: 'gemini-3.8-flash',
        models: ['gemini-3.8-flash'],
        enabled: true,
        injectModels: true,
      }],
    }), 'utf8');
    invalidate('all');

    // 1. 验证 streamGenerateContent 走原生 Gemini 真流式、带 Bearer 鉴权、不转 OpenAI、保留 googleSearch 并转 thinkingLevel
    const streamRes = mockRes();
    const agReqBody = Buffer.from(JSON.stringify({
      model: 'gemini-3.8-flash',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
      },
    }));
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:streamGenerateContent?alt=sse', headers: { 'content-type': 'application/json' } },
      streamRes,
      agReqBody,
    );
    await streamRes.waitForEnd();

    assert.equal(streamRes.statusCode, 200);
    assert.equal(seenRequests[0].url, '/v1/projects/demo-p/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    assert.equal(seenRequests[0].headers.authorization, 'Bearer ya29.test-oauth-bearer');
    assert.equal(seenRequests[0].headers['x-goog-api-key'], undefined);
    assert.equal(seenRequests[0].body.model, undefined);
    assert.equal(seenRequests[0].body.stream, undefined);
    assert.deepEqual(seenRequests[0].body.tools, [{ googleSearch: {} }]);
    assert.deepEqual(seenRequests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM', includeThoughts: true });

    const sseFrames = streamRes.bodyText
      .split('\n\n')
      .filter((blk) => blk.startsWith('data: '))
      .map((blk) => JSON.parse(blk.slice(6)));
    assert.equal(sseFrames.length, 3, 'should forward 3 incremental frames directly without whole-response buffering');
    assert.equal(sseFrames[0].response.candidates[0].content.parts[0].thought, true);
    assert.equal(sseFrames[1].response.candidates[0].content.parts[0].text, 'Hello Vertex!');
    assert.equal(sseFrames[2].response.candidates[0].finishReason, 'TOOL_CALL');
    assert.equal(sseFrames[2].response.candidates[0].content.parts[0].thoughtSignature, 'sig-vertex-999');

    // 2. 验证 countTokens 发到 :countTokens 且 Vertex 使用扁平结构
    const countRes = mockRes();
    await handleLocalProxyRequest(
      { method: 'POST', url: '/v1internal:countTokens', headers: { 'content-type': 'application/json' } },
      countRes,
      Buffer.from(JSON.stringify({
        model: 'gemini-3.8-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'count me' }] }] },
      })),
    );
    assert.equal(seenRequests[1].url, '/v1/projects/demo-p/locations/global/publishers/google/models/gemini-3.8-flash:countTokens');
    assert.equal(seenRequests[1].body.generateContentRequest, undefined, 'Vertex countTokens must use flat REST payload');
    assert.equal(seenRequests[1].body.contents[0].parts[0].text, 'count me');
    assert.deepEqual(JSON.parse(countRes.bodyText), { totalTokens: 42 });
  } finally {
    await closeServer(server);
    invalidate('all');
    if (prevDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Anthropic & Responses SSE converters stream Gemini thought/text/tool frames incrementally', () => {
  const anth = createAnthropicSSEFromGemini('gemini-3.8-flash');
  const aEvents = [
    ...anth.write({ candidates: [{ content: { parts: [{ text: 'plan', thought: true }] } }] }),
    ...anth.write({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }),
    ...anth.write({ candidates: [{ content: { parts: [{ functionCall: { name: 'calc', args: { x: 1 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }),
    ...anth.flush(),
  ];
  assert.ok(aEvents.some((e) => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta' && e.data.delta.thinking === 'plan'));
  assert.ok(aEvents.some((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta' && e.data.delta.text === 'answer'));
  assert.ok(aEvents.some((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use' && e.data.content_block.name === 'calc'));
  assert.ok(aEvents.some((e) => e.event === 'message_delta' && e.data.delta.stop_reason === 'tool_use'));

  const resp = createResponsesSSEFromGemini('gemini-3.8-flash');
  const rEvents = [
    ...resp.write({ candidates: [{ content: { parts: [{ text: 'thought', thought: true }] } }] }),
    ...resp.write({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
    ...resp.flush(),
  ];
  assert.ok(rEvents.some((e) => e.type === 'response.reasoning_summary_text.delta' && e.delta === 'thought'));
  assert.ok(rEvents.some((e) => e.type === 'response.output_text.delta' && e.delta === 'done'));
  assert.equal(rEvents[rEvents.length - 1].type, 'response.completed');
  assert.equal(rEvents[rEvents.length - 1].response.output_text, 'done');

  const relay = createAntigravityGeminiRelay();
  const f1 = relay.write({ candidates: [{ index: 0, content: { parts: [{ text: 'hi' }] } }] });
  const flushFrames = relay.flush();
  assert.equal(f1.length, 1);
  assert.equal(flushFrames[0].candidates[0].finishReason, 'STOP');
});

test('resolveGeminiEndpoint merges host prefix cleanly and avoids /v1 vs /v1beta false prefix match', () => {
  const withPrefix = resolveGeminiEndpoint(
    'https://proxy.example.com/prefix',
    '/v1/publishers/google/models',
    'gemini-3.8-flash',
    'AQ.express-key',
  );
  assert.equal(withPrefix.apiPath, '/prefix/v1/publishers/google/models/gemini-3.8-flash:generateContent');
  assert.equal(withPrefix.isVertex, true);

  const v1Prefix = resolveGeminiEndpoint(
    'https://proxy.example.com/v1',
    '/v1beta/models',
    'gemini-2.5-pro',
    'AIza-test',
  );
  assert.equal(v1Prefix.apiPath, '/v1/v1beta/models/gemini-2.5-pro:generateContent');
});

test('parseSSEStream decodes split multi-byte UTF-8 chunks and data: without space', async () => {
  const payload = 'data:{"text":"你好🌍"}\ndata: [DONE]\n';
  const full = Buffer.from(payload, 'utf8');
  const splitAt = payload.indexOf('🌍');
  const byteSplit = Buffer.byteLength(payload.slice(0, splitAt), 'utf8') + 2;
  const stream = Readable.from([full.subarray(0, byteSplit), full.subarray(byteSplit)]);
  const frames = [];
  for await (const frame of parseSSEStream(stream)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ text: '你好🌍' }]);
});

test('Gemini SSE transforms surface inline SSE error objects and do not emit synthetic STOP on error', () => {
  const relay = createAntigravityGeminiRelay();
  assert.throws(() => relay.write({ error: { code: 400, message: 'Bad thinking config' } }), /Bad thinking config/);
  assert.deepEqual(relay.flush(), []);

  const anth = createAnthropicSSEFromGemini('gemini-2.5-pro');
  assert.throws(() => anth.write({ error: { message: 'Quota exceeded' } }), /Quota exceeded/);

  const resp = createResponsesSSEFromGemini('gemini-2.5-pro');
  assert.throws(() => resp.write({ error: { message: 'Model overloaded' } }), /Model overloaded/);
});

test('normalizeGeminiResponseJson unwraps JSON array stream fallback and buildGeminiUpstreamSpec emits protobuf frames', async () => {
  const merged = normalizeGeminiResponseJson([
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello ' }] } }], modelVersion: 'gemini-2.5-pro' },
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Vertex!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } },
  ]);
  assert.equal(merged.candidates[0].content.parts.map((p) => p.text).join(''), 'Hello Vertex!');
  assert.equal(merged.candidates[0].finishReason, 'STOP');
  assert.equal(merged.usageMetadata.promptTokenCount, 3);

  const spec = await buildGeminiUpstreamSpec({
    systemPrompt: 'Be concise.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    toolChoice: { type: 'auto' },
    resolvedModel: 'gemini-2.5-pro',
    messageId: 'msg_test_gemini',
    conn: {
      providerId: 'vertex',
      providerName: 'Vertex Express',
      protocol: 'https',
      hostname: 'aiplatform.googleapis.com',
      port: 443,
      apiPath: '/v1/publishers/google/models/gemini-2.5-pro:generateContent',
      apiKey: 'AQ.secret-key-1234',
      model: 'gemini-2.5-pro',
      format: 'gemini',
    },
    thinking: { mode: 'level', level: 'medium' },
  });
  assert.equal(spec.format, 'gemini');
  assert.match(spec.targetPath, /:streamGenerateContent\?alt=sse$/);
  assert.equal(spec.reqHeaders['x-goog-api-key'], 'AQ.secret-key-1234');
  assert.ok(!spec.logHeaders['x-goog-api-key'].includes('AQ.secret-key-1234'));
  assert.equal(spec.apiPayload.generationConfig.thinkingConfig.thinkingBudget, 4096);

  const session = spec.createSession();
  const events = session.parseEvents('data:{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1}}');
  const chunks = events.flatMap((e) => session.processEvent(e));
  chunks.push(...session.processEvent(session.finishPayload()));
  assert.ok(chunks.length > 0);
  assert.equal(session.activeProcessor().isDone, true);
});

test('AI Studio /v1beta/openai without trailing slash stays openai across endpoint inference and target resolution', () => {
  assert.equal(isOfficialGoogleGeminiNativeOnlyEndpoint('https://generativelanguage.googleapis.com/v1beta/openai', null), false);
  assert.equal(isOfficialGoogleGeminiNativeOnlyEndpoint('https://generativelanguage.googleapis.com', '/v1beta/openai'), false);
  assert.equal(isOfficialGoogleGeminiNativeOnlyEndpoint('https://generativelanguage.googleapis.com', '/v1beta/openai?foo=1'), false);
  assert.equal(inferApiFormatFromEndpoint('https://generativelanguage.googleapis.com/v1beta/openai', null), 'openai');
  assert.equal(inferApiFormatFromEndpoint('https://generativelanguage.googleapis.com', '/v1beta/openai'), 'openai');

  const target = { providerId: 'aistudio-compat', model: 'gemini-2.5-pro' };
  const providers = new Map([[
    'aistudio-compat',
    {
      id: 'aistudio-compat',
      name: 'AI Studio Compat',
      apiHost: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'AIzaTestCompat',
      apiFormat: 'openai',
      enabled: true,
    },
  ]]);
  const conn = resolveTarget(target, providers);
  assert.equal(conn.format, 'openai');
  assert.equal(conn.apiPath, '/v1beta/openai/chat/completions');
});

test('Standard Vertex OAuth/SA auto-fills /v1/projects/{project}/locations/{loc} when apiPath is empty', () => {
  const sa = JSON.stringify({
    type: 'service_account',
    project_id: 'std-proj-9',
    client_email: 'sa@std-proj-9.iam.gserviceaccount.com',
    private_key: 'dummy',
  });
  const globalEp = resolveGeminiEndpoint('https://aiplatform.googleapis.com', '', 'gemini-2.5-pro', sa);
  assert.equal(globalEp.origin, 'https://aiplatform.googleapis.com');
  assert.equal(globalEp.apiPath, '/v1/projects/std-proj-9/locations/global/publishers/google/models/gemini-2.5-pro:generateContent');

  const regionalEp = resolveGeminiEndpoint('https://us-central1-aiplatform.googleapis.com', '/v1', 'gemini-2.5-flash', sa);
  assert.equal(regionalEp.origin, 'https://us-central1-aiplatform.googleapis.com');
  assert.equal(regionalEp.apiPath, '/v1/projects/std-proj-9/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent');

  // Express key must stay on Express /v1/publishers/google/models
  const expressEp = resolveGeminiEndpoint('https://aiplatform.googleapis.com', '', 'gemini-2.5-flash', 'AQ.express-only');
  assert.equal(expressEp.apiPath, '/v1/publishers/google/models/gemini-2.5-flash:generateContent');
});

test('normalizeGeminiThinkingConfig enforces gemini-2.5-pro min budget 128 and flash-lite non-zero min 512', () => {
  const proZero = normalizeGeminiThinkingConfig({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, { model: 'gemini-2.5-pro' });
  assert.equal(proZero.generationConfig.thinkingConfig.thinkingBudget, 128);

  const proNone = normalizeGeminiThinkingConfig({ generationConfig: { thinkingConfig: { thinkingLevel: 'NONE' } } }, { model: 'gemini-2.5-pro' });
  assert.equal(proNone.generationConfig.thinkingConfig.thinkingBudget, 128);

  const proDynamic = normalizeGeminiThinkingConfig({ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, { model: 'gemini-2.5-pro' });
  assert.equal(proDynamic.generationConfig.thinkingConfig.thinkingBudget, -1);

  const flashZero = normalizeGeminiThinkingConfig({ generationConfig: { thinkingConfig: { thinkingBudget: 0, includeThoughts: true } } }, { model: 'gemini-2.5-flash' });
  assert.equal(flashZero.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(flashZero.generationConfig.thinkingConfig.includeThoughts, undefined);

  const liteLow = normalizeGeminiThinkingConfig({ generationConfig: { thinkingConfig: { thinkingBudget: 100 } } }, { model: 'gemini-2.5-flash-lite' });
  assert.equal(liteLow.generationConfig.thinkingConfig.thinkingBudget, 512);
});

test('healGemini400Payload repairs invalid/missing thought_signature once per healState', () => {
  const state = {};
  const payload = {
    contents: [
      { role: 'user', parts: [{ text: 'hi', thoughtSignature: 'stale-user-sig' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'a', args: {} }, thoughtSignature: 'bad-sig' },
          { functionCall: { name: 'b', args: {} } },
        ],
      },
    ],
  };
  const healed = healGemini400Payload(payload, 'Invalid thought_signature in functionCall parts', state);
  assert.ok(healed);
  assert.equal(healed.kind, 'gemini-skip-thought-signature');
  assert.equal(healed.payload.contents[0].parts[0].thoughtSignature, undefined);
  assert.equal(healed.payload.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(healed.payload.contents[1].parts[1].thoughtSignature, undefined);
  assert.equal(healGemini400Payload(healed.payload, 'Invalid thought_signature', state), null);
});

test('healGemini400Payload repairs snake_case function_call thought_signature', () => {
  const state = {};
  const payload = {
    contents: [
      {
        role: 'model',
        parts: [
          { function_call: { name: 'read_file', args: { path: 'a' } }, thought_signature: 'bad-sig' },
          { function_call: { name: 'list_dir', args: {} } },
        ],
      },
    ],
  };
  const healed = healGemini400Payload(payload, 'Invalid thought_signature in function_call', state);
  assert.ok(healed);
  assert.equal(healed.payload.contents[0].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(healed.payload.contents[0].parts[1].thoughtSignature, undefined);
  assert.equal(healed.payload.contents[0].parts[0].thought_signature, undefined);
});

test('config-cache sourceProviderId keeps live provider fields over stale antigravityConfig snapshot extras', async () => {
  const { loadProviders } = await import('../provider-pool.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cache-stale-'));
  const prevDir = process.env.BYOK_CONFIG_DIR;
  process.env.BYOK_CONFIG_DIR = tmpDir;
  try {
    fs.writeFileSync(path.join(tmpDir, 'providers.json'), JSON.stringify({
      providers: [
        {
          id: 'p-live',
          name: 'Live Provider',
          apiHost: 'https://generativelanguage.googleapis.com',
          apiKey: 'AIza-live-new',
          apiKeys: [{ key: 'AIza-live-new', enabled: true }],
          wireApi: 'responses',
          capabilities: { text: true, stream: true, gzip: true },
          enabled: true,
        },
      ],
      antigravityConfigs: [
        {
          id: 'ag-legacy',
          name: 'gemini-2.5-pro',
          defaultModel: 'gemini-2.5-pro',
          models: ['gemini-2.5-pro'],
          sourceProviderId: 'p-live',
          apiHost: 'https://stale.example.com',
          apiKey: 'sk-old',
          apiKeys: [{ key: 'sk-old', enabled: true }],
          wireApi: 'chat',
          unlocks: { legacy: true },
          codexChatReasoning: 'low',
          capabilities: { gzip: false, legacyFlag: true },
          apiFormat: 'openai',
          enabled: true,
        },
      ],
    }), 'utf8');
    invalidate('all');
    const loaded = loadProviders();
    const ag = loaded.get('ag-legacy');
    assert.equal(ag.apiKey, 'AIza-live-new');
    assert.deepEqual(ag.apiKeys, [{ key: 'AIza-live-new', enabled: true }]);
    assert.equal(ag.wireApi, 'responses');
    assert.equal(ag.unlocks, undefined);
    assert.equal(ag.codexChatReasoning, undefined);
    assert.equal(ag.capabilities.gzip, true);
    assert.equal(ag.capabilities.legacyFlag, undefined);
    assert.equal(ag.apiFormat, 'gemini');
  } finally {
    if (prevDir === undefined) delete process.env.BYOK_CONFIG_DIR;
    else process.env.BYOK_CONFIG_DIR = prevDir;
    invalidate('all');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
