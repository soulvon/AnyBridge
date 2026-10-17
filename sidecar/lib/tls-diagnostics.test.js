import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mitmCertRejected, TLS_CLIENT_CERT_REJECTED_EVENT } from './tls-diagnostics.js';

describe('mitmCertRejected', () => {
  it('recognises every certificate-trust alert number', () => {
    for (const code of [42, 43, 44, 45, 46, 48]) {
      const message = `70830000:error:0A00041B:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:SSL alert number ${code}`;
      assert.equal(mitmCertRejected(new Error(message)), true, `alert number ${code} must count as rejection`);
    }
  });

  it('recognises textual failures that carry no alert number', () => {
    const messages = [
      'certificate verify failed',
      'unable to verify the first certificate',
      'self signed certificate in certificate chain',
      'tlsv1 alert bad certificate',
      'tlsv1 alert unknown ca',
    ];
    for (const message of messages) {
      assert.equal(mitmCertRejected(new Error(message)), true, message);
    }
  });

  it('falls back to err.code when no message is present', () => {
    assert.equal(mitmCertRejected({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), true);
    assert.equal(mitmCertRejected({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), true);
  });

  it('does not classify unrelated TLS failures as certificate rejection', () => {
    const messages = [
      // decrypt_error 可能来自密钥/套件不匹配，不能当成证书被拒
      '70830000:error:0A00041B:SSL routines:ssl3_read_bytes:tlsv1 alert decrypt error:SSL alert number 51',
      'socket hang up',
      'read ECONNRESET',
      '',
    ];
    for (const message of messages) {
      assert.equal(mitmCertRejected(new Error(message)), false, message);
    }
  });

  it('tolerates nullish input', () => {
    assert.equal(mitmCertRejected(null), false);
    assert.equal(mitmCertRejected(undefined), false);
  });

  it('keeps the event string the desktop parses', () => {
    assert.equal(TLS_CLIENT_CERT_REJECTED_EVENT, 'ANYBRIDGE_EVENT:TLS_CLIENT_CERT_REJECTED');
  });
});
