import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function stableModelID(modelID) {
  return crypto.createHash('sha256').update(`byok|${modelID}`).digest('hex').slice(0, 16);
}

export function writeProxyRoutes(routes = [{
  id: 'cursor-smoke-route',
  displayName: 'Cursor Smoke Model',
  enabled: true,
  exposedFormats: ['openai'],
  targets: [{
    providerId: 'smoke-provider',
    model: 'gpt-smoke',
  }],
}]) {
  fs.writeFileSync(path.join(process.env.BYOK_CONFIG_DIR, 'proxy-routes.json'), JSON.stringify({
    version: 1,
    routes,
  }, null, 2));
}

export function makeReq(host, url) {
  return { url, headers: { host } };
}

export function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
    },
    body() {
      return Buffer.concat(this.chunks);
    },
  };
}

export function readEnvelope(buf, offset = 0) {
  const flags = buf[offset];
  const length = buf.readUInt32BE(offset + 1);
  const rawPayload = buf.subarray(offset + 5, offset + 5 + length);
  const payload = (flags & 1) === 1 ? zlib.gunzipSync(rawPayload) : rawPayload;
  return { flags, length, payload, next: offset + 5 + length };
}

export function protoConcat(parts) {
  return Buffer.concat(parts.filter(Boolean));
}
