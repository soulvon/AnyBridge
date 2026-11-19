import http from 'node:http';

export function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

export function mockRes() {
  const chunks = [];
  let resolveEnd;
  const endedPromise = new Promise((r) => { resolveEnd = r; });
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.ended = true;
      resolveEnd();
    },
    on() {},
    once() {},
    emit() {},
    get bodyText() { return chunks.join(''); },
    waitForEnd: () => endedPromise,
  };
}

