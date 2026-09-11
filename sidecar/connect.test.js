import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  wrapEnvelope,
  endOfStreamEnvelope,
  endOfStreamErrorEnvelope,
  streamHeaders,
} from './connect.js';

test('stream envelopes default to uncompressed for Devin Local compatibility', () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const frame = wrapEnvelope(payload);

  assert.equal(frame[0], 0);
  assert.equal(frame.readUInt32BE(1), payload.length);
  assert.deepEqual(frame.subarray(5), payload);
  assert.equal(streamHeaders()['connect-content-encoding'], undefined);
});

test('explicit compression remains available for legacy callers', () => {
  const payload = Buffer.from('legacy payload');
  const frame = wrapEnvelope(payload, true);

  assert.equal(frame[0], 1);
  assert.deepEqual(zlib.gunzipSync(frame.subarray(5)), payload);
});

test('end-of-stream envelopes are uncompressed JSON trailers', () => {
  const success = endOfStreamEnvelope();
  assert.equal(success[0], 2);
  assert.equal(success.subarray(5).toString('utf8'), '{}');

  const failure = endOfStreamErrorEnvelope({ code: 'unavailable', message: 'failed' });
  assert.equal(failure[0], 2);
  assert.deepEqual(JSON.parse(failure.subarray(5).toString('utf8')), {
    error: { code: 'unavailable', message: 'failed' },
  });
});
