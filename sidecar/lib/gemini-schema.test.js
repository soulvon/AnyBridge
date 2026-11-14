import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanGeminiToolParameters, sanitizeGeminiSchema } from './gemini-schema.js';

test('drops $schema/additionalProperties/$defs but keeps property names', () => {
  const out = sanitizeGeminiSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $defs: { X: { type: 'string' } },
    additionalProperties: false,
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'file path' },
      count: { type: 'integer', minimum: 1 },
    },
  });
  assert.equal(out.$schema, undefined);
  assert.equal(out.$defs, undefined);
  assert.equal(out.additionalProperties, undefined);
  assert.equal(out.type, 'OBJECT');
  assert.equal(out.properties.path.type, 'STRING');
  assert.equal(out.properties.count.type, 'INTEGER');
  assert.deepEqual(out.required, ['path']);
});

test('nested arrays and objects are sanitized recursively', () => {
  const out = sanitizeGeminiSchema({
    type: 'object',
    properties: {
      list: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: { flag: { type: 'boolean' } },
        },
      },
    },
  });
  assert.equal(out.properties.list.type, 'ARRAY');
  assert.equal(out.properties.list.items.type, 'OBJECT');
  assert.equal(out.properties.list.items.additionalProperties, undefined);
  assert.equal(out.properties.list.items.properties.flag.type, 'BOOLEAN');
});

test('type array with null folds into nullable single type', () => {
  const out = sanitizeGeminiSchema({ type: ['string', 'null'], description: 'x' });
  assert.equal(out.type, 'STRING');
  assert.equal(out.nullable, true);
});

test('oneOf degrades to anyOf and enum drops null', () => {
  const out = sanitizeGeminiSchema({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    enum: ['a', null],
  });
  assert.equal(out.anyOf.length, 2);
  assert.equal(out.anyOf[0].type, 'STRING');
  assert.equal(out.anyOf[1].type, 'NUMBER');
  assert.deepEqual(out.enum, ['a']);
});

test('empty or invalid schema falls back to legal empty object parameters', () => {
  assert.deepEqual(sanitizeGeminiSchema({}), {});
  assert.equal(sanitizeGeminiSchema(null), null);
  assert.deepEqual(cleanGeminiToolParameters({}), { type: 'object', properties: {} });
  assert.deepEqual(cleanGeminiToolParameters(null), { type: 'object', properties: {} });
});
