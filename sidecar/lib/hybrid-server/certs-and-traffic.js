import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

export function loadMitmCertificates(CERTS_DIR, MITM_HOSTS) {
  let cert;
  let key;
  let caCert = null;
  let enabled = false;
  let fingerprint = null;
  let errorMsg = null;

  try {
    // 优先使用由本地 CA 签发的 end-entity 叶子证书（mitm-leaf.pem，含 CA 链）。
    // 严格 TLS 客户端（rustls/webpki）拒绝「CA 证书当作服务器证书」(CaUsedAsEndEntity)，
    // 因此 MITM 必须呈现叶子证书，CA 仅作为信任根。
    const leafUrl = new URL('mitm-leaf.pem', CERTS_DIR);
    const leafKeyUrl = new URL('mitm-leaf-key.pem', CERTS_DIR);
    const caUrl = new URL('server.codeium.com.pem', CERTS_DIR);
    const hasLeaf = fs.existsSync(leafUrl) && fs.existsSync(leafKeyUrl);
    if (hasLeaf) {
      cert = fs.readFileSync(leafUrl);
      key = fs.readFileSync(leafKeyUrl);
      caCert = fs.readFileSync(caUrl);
    } else {
      cert = fs.readFileSync(caUrl);
      key = fs.readFileSync(new URL('server.codeium.com-key.pem', CERTS_DIR));
    }
    const certificate = new crypto.X509Certificate(cert);
    const privateKey = crypto.createPrivateKey(key);
    if (!certificate.checkPrivateKey(privateKey)) {
      throw new Error('证书与私钥不匹配');
    }
    if (Date.now() < Date.parse(certificate.validFrom) || Date.now() > Date.parse(certificate.validTo)) {
      throw new Error(`证书不在有效期内: ${certificate.validFrom} ~ ${certificate.validTo}`);
    }
    const missing = [...MITM_HOSTS].filter(host => !certificate.checkHost(host));
    if (missing.length) {
      throw new Error(`证书缺少 SAN: ${missing.join(', ')}`);
    }
    if (hasLeaf) {
      if (certificate.ca) {
        throw new Error('MITM 叶子证书不应标记为 CA');
      }
      const ca = new crypto.X509Certificate(caCert);
      if (!ca.ca) {
        throw new Error('MITM 信任根未标记为 CA');
      }
      if (!certificate.verify(ca.publicKey)) {
        throw new Error('叶子证书未由本地 MITM CA 签发');
      }
    } else if (!certificate.ca) {
      throw new Error('证书未标记为 CA，不能作为 MITM 信任根');
    }
    tls.createSecureContext({ cert, key });
    fingerprint = certificate.fingerprint256;
    enabled = true;
    console.log(`🔐 MITM enabled; ${hasLeaf ? 'leaf' : 'ca-as-leaf'}=${new URL(hasLeaf ? 'mitm-leaf.pem' : 'server.codeium.com.pem', CERTS_DIR).href}; fingerprint=${fingerprint}`);
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    cert = undefined;
    key = undefined;
    caCert = null;
    console.error(`❌ MITM certificate unavailable: ${errorMsg}`);
  }

  return {
    MITM_CERT: cert,
    MITM_KEY: key,
    MITM_CA_CERT: caCert,
    MITM_ENABLED: enabled,
    MITM_CERT_FINGERPRINT: fingerprint,
    MITM_ERROR: errorMsg,
  };
}

export function hashModelList(list) {
  try {
    const h = crypto.createHash('sha1');
    for (const m of list) h.update(`${m.modelUid || ''}|${m.label || ''}\n`);
    return h.digest('hex').slice(0, 16);
  } catch {
    return String(Date.now());
  }
}

export function writeCapturedModelList(file, list) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    existing = {};
  }

  const existingByUid = new Map();
  for (const item of (Array.isArray(existing.models) ? existing.models : [])) {
    if (item && item.modelUid) existingByUid.set(item.modelUid, item);
  }

  const models = [];
  const accountModelIds = [];
  const seen = new Set();
  for (const item of list) {
    const modelUid = String(item?.modelUid || '').trim();
    if (!modelUid || seen.has(modelUid)) continue;
    const label = String(item?.label || modelUid).trim();
    if (/^https?:\/\//i.test(label)) continue;
    seen.add(modelUid);
    const prev = existingByUid.get(modelUid) || {};
    const out = {
      modelUid,
      label: label || modelUid,
    };
    const apiId = item.apiId || prev.apiId;
    if (apiId) out.apiId = apiId;
    models.push(out);
    accountModelIds.push(modelUid);
  }
  if (!models.length) return;

  const next = {
    capturedAt: Date.now(),
    source: 'captured',
    accountModelIds,
    models,
  };
  if (existing.account && typeof existing.account === 'object') next.account = existing.account;
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

export function rewriteConfigSignature(configDir) {
  const dir = configDir();
  return ['model-map.json', 'providers.json', 'ide-models.json']
    .map((name) => {
      try {
        const s = fs.statSync(path.join(dir, name));
        return `${name}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${name}:missing`;
      }
    })
    .join('|');
}
