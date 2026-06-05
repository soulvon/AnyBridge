// probe_connect_target.js — Test which CONNECT hosts the BYOK proxy MITMs vs pipes
// Usage: node scripts/probe_connect_target.js

import net from 'node:net';

const PROXY_PORT = 7460;
const TEST_HOSTS = [
  'server.self-serve.windsurf.com',
  'server.codeium.com',
  'inference.codeium.com',
  'register.windsurf.com',
  'app.devin.ai',
  'api.devin.ai',
];

function testConnect(host) {
  return new Promise((resolve) => {
    const socket = net.connect(PROXY_PORT, '127.0.0.1', () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });

    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ host, response: response.trim() || 'TIMEOUT', mitm: false });
    }, 3000);

    socket.on('data', (data) => {
      response += data.toString();
      // Check the Proxy-agent header — MITM returns "windsurf-hybrid"
      const isMitm = response.includes('windsurf-hybrid');
      if (response.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ host, response: response.trim(), mitm: isMitm });
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      resolve({ host, response: `ERROR: ${err.message}`, mitm: false });
    });
  });
}

async function main() {
  console.log('Testing BYOK proxy CONNECT behavior on port', PROXY_PORT);
  console.log('---');

  for (const host of TEST_HOSTS) {
    const result = await testConnect(host);
    const status = result.mitm ? '🔓 MITM' : '➡️ PIPE';
    console.log(`${status}  ${result.host}`);
    console.log(`   Response: ${result.response.split('\r\n')[0]}`);
  }

  console.log('---');
  console.log('Done. Kill the proxy process when finished.');
}

main();
