import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import { preprocessImagesWithThirdPartyVision } from './vision-fallback.js';

function installHttpsMock(handler) {
  const original = https.request;
  const calls = [];
  https.request = function mockRequest(options, cb) {
    let body = Buffer.alloc(0);
    const req = new EventEmitter();
    req.write = chunk => {
      if (chunk) body = Buffer.concat([body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    };
    req.setTimeout = () => req;
    req.destroy = err => { if (err) req.emit('error', err); };
    req.end = chunk => {
      if (chunk) req.write(chunk);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      calls.push({ options, payload });
      const result = handler({ options, payload, calls });
      const res = new Readable({ read() {} });
      res.statusCode = result.statusCode || 200;
      res.headers = { 'content-type': 'application/json' };
      process.nextTick(() => {
        cb(res);
        res.push(JSON.stringify(result.body));
        res.push(null);
      });
    };
    return req;
  };
  return {
    calls,
    restore() {
      https.request = original;
    },
  };
}

function providers() {
  return new Map([['vision', {
    id: 'vision',
    name: 'Vision',
    enabled: true,
    apiHost: 'https://vision.test',
    apiKey: 'test-key',
    apiPath: '/v1',
    defaultModel: 'vision-model',
  }]]);
}

function image(seed) {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(seed).toString('base64'),
    },
  };
}

test('batch mode sends multiple images in one vision request', async () => {
  const mock = installHttpsMock(({ payload }) => {
    const content = payload.messages?.[0]?.content || [];
    const imageCount = content.filter(part => part.type === 'image_url').length;
    return {
      body: { choices: [{ message: { content: `批量识别成功，共 ${imageCount} 张图片。图片 #1 有 A，图片 #2 有 B。` } }] },
    };
  });
  try {
    const result = await preprocessImagesWithThirdPartyVision([
      { role: 'user', content: [{ type: 'text', text: '比较两张图' }, image('a'), image('b')] },
    ], [{ providerId: 'vision', model: 'vision-model' }], providers(), {
      requestedModel: 'target',
      visionOptions: { multiImageMode: 'batch', maxTokens: 4096 },
    });

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].payload.max_tokens, 4096);
    const content = mock.calls[0].payload.messages[0].content;
    assert.equal(content.filter(part => part.type === 'image_url').length, 2);
    assert.match(result.messages[0].content[1].text, /批量图片 #1-#2/);
    assert.match(result.messages[0].content[2].text, /已包含在上方批量图片 #1-#2/);
  } finally {
    mock.restore();
  }
});

test('summary context mode includes prior text in the vision prompt', async () => {
  const mock = installHttpsMock(() => ({
    body: { choices: [{ message: { content: '图片中有一个红色错误提示。' } }] },
  }));
  try {
    await preprocessImagesWithThirdPartyVision([
      { role: 'user', content: [{ type: 'text', text: '验收标准：错误提示必须在输入框下方。' }] },
      { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
      { role: 'user', content: [{ type: 'text', text: '这张图是否合格？' }, image('c')] },
    ], [{ providerId: 'vision', model: 'vision-model' }], providers(), {
      requestedModel: 'target',
      visionOptions: { contextMode: 'summary', contextMaxChars: 4000 },
    });

    const prompt = mock.calls[0].payload.messages[0].content.find(part => part.type === 'text').text;
    assert.match(prompt, /验收标准：错误提示必须在输入框下方/);
    assert.match(prompt, /这张图是否合格/);
  } finally {
    mock.restore();
  }
});

test('chunk mode converts trailing single image instead of leaving image blocks', async () => {
  const mock = installHttpsMock(({ payload }) => {
    const content = payload.messages?.[0]?.content || [];
    const imageCount = content.filter(part => part.type === 'image_url').length;
    return {
      body: { choices: [{ message: { content: `本批次识别成功，共 ${imageCount} 张图片，包含清晰的 UI 截图描述。` } }] },
    };
  });
  try {
    const result = await preprocessImagesWithThirdPartyVision([
      { role: 'user', content: [{ type: 'text', text: '逐张说明' }, image('chunk-a'), image('chunk-b'), image('chunk-c')] },
    ], [{ providerId: 'vision', model: 'vision-model' }], providers(), {
      requestedModel: 'target',
      visionOptions: { multiImageMode: 'chunk', batchSize: 2 },
    });

    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0].payload.messages[0].content.filter(part => part.type === 'image_url').length, 2);
    assert.equal(mock.calls[1].payload.messages[0].content.filter(part => part.type === 'image_url').length, 1);
    assert.equal(result.messages[0].content.filter(part => part.type === 'image').length, 0);
    assert.match(result.messages[0].content[3].text, /批量图片 #3/);
  } finally {
    mock.restore();
  }
});

test('full context truncation keeps current user question in the vision prompt', async () => {
  const mock = installHttpsMock(() => ({
    body: { choices: [{ message: { content: '图片里展示了一个设置页。' } }] },
  }));
  try {
    await preprocessImagesWithThirdPartyVision([
      { role: 'user', content: [{ type: 'text', text: `很长的历史：${'背景信息'.repeat(300)}` }] },
      { role: 'user', content: [{ type: 'text', text: '当前问题：这张图里的开关应该怎么配置？' }, image('full-context-current')] },
    ], [{ providerId: 'vision', model: 'vision-model' }], providers(), {
      requestedModel: 'target',
      visionOptions: { contextMode: 'full', contextMaxChars: 500 },
    });

    const prompt = mock.calls[0].payload.messages[0].content.find(part => part.type === 'text').text;
    assert.match(prompt, /当前问题：这张图里的开关应该怎么配置/);
    assert.match(prompt, /上下文已按 visionContextMaxChars=500 截断|前文因 visionContextMaxChars=500/);
  } finally {
    mock.restore();
  }
});
