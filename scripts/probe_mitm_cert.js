// probe_mitm_cert.js — Check if the BYOK proxy MITMs a host by examining the TLS certificate
// MITM → proxy presents its own cert (CN = "Windsurf BYOK Local MITM")
// Pipe → real server's cert (CN = *.codeium.com or similar)
// Usage: node scripts/probe_mitm_cert.js

import net from 'node:net';
import tls from 'node:tls';

const PROXY_PORT = 7460;
const TEST_HOSTS = [
  'server.self-serve.windsurf.com',
  'server.codeium.com',
  'inference.codeium.com',
  'register.windsurf.com',
  'app.devin.ai',
  'api.devin.ai',
];

function testMitmCert(host) {
  return new Promise((resolve) => {
    // Step 1: Send CONNECT through proxy
    const proxySocket = net.connect(PROXY_PORT, '127.0.0.1', () => {
      proxySocket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });

    let connectResponse = '';
    proxySocket.on('data', (data) => {
      connectResponse += data.toString();
      if (connectResponse.includes('\r\n\r\n')) {
        // CONNECT tunnel established, now do TLS handshake
        const tlsSocket = tls.connect({
          socket: proxySocket,
          servername: host,
          rejectUnauthorized: false, // We want to see the cert even if it's MITM
        }, () => {
          const cert = tlsSocket.getPeerCertificate();
          const cn = cert.subject?.CN || 'N/A';
          const ou = cert.subject?.OU || 'N/A';
          const san = cert.subjectaltname || 'N/A';
          const isMitm = cn.includes('BYOK') || cn.includes('MITM') || cn.includes('Local');
          tlsSocket.destroy();
          proxySocket.destroy();
          resolve({ host, cn, ou, san: san.substring(0, 100), mitm: isMitm });
        });

        tlsSocket.on('error', (err) => {
          proxySocket.destroy();
          resolve({ host, cn: `TLS ERROR: ${err.message}`, mitm: false });
        });
      }
    });

    proxySocket.on('error', (err) => {
      resolve({ host, cn: `PROXY ERROR: ${err.message}`, mitm: false });
    });

    // Timeout
    setTimeout(() => {
      proxySocket.destroy();
      resolve({ host, cn: 'TIMEOUT', mitm: false });
    }, 5000);
  });
}

async function main() {
  console.log('Testing BYOK proxy MITM detection via TLS certificate on port', PROXY_PORT);
  console.log('---\n');

  for (const host of TEST_HOSTS) {
    const result = await testMitmCert(host);
    const status = result.mitm ? '🔓 MITM (proxy cert)' : '➡️ PIPE (real cert)';
    console.log(`${status}  ${result.host}`);
    console.log(`   CN: ${result.cn}`);
    if (result.san !== 'N/A') console.log(`   SAN: ${result.san}`);
    console.log();
  }

  console.log('---');
  console.log('Done.');
}

main();
