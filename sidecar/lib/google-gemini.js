// google-gemini.js — Google AI Studio (Gemini) & Google Cloud Vertex AI 统一端点、
// 协议推断、OAuth2 / Service Account / ADC 凭据签发、思考配置自愈与凭据脱敏。
// 与 Rust 侧 src-tauri/src/commands/google_gemini.rs 保持契约同构。

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { SHARED_HTTPS_AGENT, httpsAgentFor } from '../system-proxy.js';
import { GEMINI_SKIP_THOUGHT_SIGNATURE } from './gemini-thought-signature.js';
import { boundedMapSet, withRetry } from './http-retry.js';

const GOOGLE_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TOKEN_REFRESH_LEAD_SECS = 120;
const MAX_TOKEN_CACHE_ENTRIES = 500;

const tokenCache = new Map();
const tokenInflight = new Map();

export function clearGeminiTokenCache() {
  tokenCache.clear();
  tokenInflight.clear();
}

export function cleanApiPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

export function parseHostOriginAndPath(host) {
  const raw = String(host || '').trim().replace(/\/+$/, '');
  if (!raw) return { error: 'API Host 为空' };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: `API Host 无效(${raw})` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `API Host 协议不支持(${url.protocol})` };
  }
  if (!url.hostname) return { error: `API Host 缺少主机名(${raw})` };
  const protocol = url.protocol === 'http:' ? 'http' : 'https';
  const defaultPort = protocol === 'http' ? 80 : 443;
  const port = url.port ? Number(url.port) : defaultPort;
  const hasExplicitPort = Boolean(url.port);
  const origin = `${protocol}://${url.hostname}${hasExplicitPort ? `:${port}` : ''}`;
  return {
    protocol,
    hostname: url.hostname.toLowerCase(),
    rawHostname: url.hostname,
    port,
    origin,
    basePath: cleanApiPath(url.pathname),
  };
}

export function isAiplatformHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'aiplatform.googleapis.com') return true;
  if (/^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(h)) return true;
  if (h.endsWith('.aiplatform.googleapis.com')) return true;
  return /^aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com$/.test(h);
}

export function isVertexEndpoint(host, apiPath) {
  const parsed = parseHostOriginAndPath(host);
  if (!parsed.error && isAiplatformHost(parsed.hostname)) return true;
  const embedded = parsed.error ? '' : parsed.basePath;
  const combined = `${embedded}${cleanApiPath(apiPath)}`.toLowerCase();
  return combined.includes('/publishers/google/')
    || combined.includes('/publishers/anthropic/')
    || (combined.includes('/projects/') && combined.includes('/locations/'));
}

export function isOfficialGoogleGeminiNativeOnlyEndpoint(host, apiPath) {
  const parsed = parseHostOriginAndPath(host);
  const hostname = parsed.error ? String(host || '').trim().toLowerCase() : parsed.hostname;
  const embedded = parsed.error ? '' : parsed.basePath;
  const cleanedPath = cleanApiPath(apiPath);
  const fullPath = (embedded && cleanedPath.toLowerCase().startsWith(embedded.toLowerCase()))
    ? cleanedPath.toLowerCase()
    : `${embedded}${cleanedPath}`.toLowerCase();

  const hasOpenAiEndpointSuffix = fullPath.includes('/endpoints/openapi')
    || fullPath.includes('/openai/')
    || /\/openai(?:$|\?)/.test(fullPath)
    || fullPath.includes('/chat/completions')
    || fullPath.includes('/responses')
    || fullPath.includes('/compatible-mode');

  if (
    hasOpenAiEndpointSuffix
    || fullPath.includes('/publishers/anthropic/')
    || fullPath.includes(':rawpredict')
    || fullPath.includes(':streamrawpredict')
  ) {
    return false;
  }

  return hostname === 'generativelanguage.googleapis.com'
    || isAiplatformHost(hostname)
    || fullPath.includes('/publishers/google/models');
}

export function inferApiFormatFromEndpoint(host, apiPath) {
  const parsed = parseHostOriginAndPath(host);
  const origin = parsed.error ? '' : parsed.origin;
  const hostname = parsed.error ? String(host || '').trim().toLowerCase() : parsed.hostname;
  const embedded = parsed.error ? '' : parsed.basePath;
  const cleanedPath = cleanApiPath(apiPath);
  const fullPath = (embedded && cleanedPath.toLowerCase().startsWith(embedded.toLowerCase()))
    ? cleanedPath.toLowerCase()
    : `${embedded}${cleanedPath}`.toLowerCase();
  const combined = `${origin.toLowerCase()}${fullPath}`;

  if (!combined) return null;

  if (
    fullPath.includes('/publishers/anthropic/')
    || fullPath.includes(':rawpredict')
    || fullPath.includes(':streamrawpredict')
    || fullPath.endsWith('/messages')
    || fullPath.includes('/v1/messages')
  ) {
    return 'anthropic';
  }
  if (
    fullPath.includes('/endpoints/openapi')
    || fullPath.includes('/openai/')
    || /\/openai(?:$|\?)/.test(fullPath)
    || fullPath.includes('/chat/completions')
    || fullPath.includes('/responses')
    || fullPath.includes('/compatible-mode')
  ) {
    return 'openai';
  }

  const isGoogleGeminiHost = hostname === 'generativelanguage.googleapis.com' || isAiplatformHost(hostname);
  if (
    isGoogleGeminiHost
    || fullPath.includes('/publishers/google/models')
    || fullPath.includes('/v1beta')
    || fullPath.includes(':generatecontent')
    || fullPath.includes(':streamgeneratecontent')
    || fullPath.includes(':counttokens')
    || hostname.includes('gemini')
  ) {
    return 'gemini';
  }

  if (hostname.includes('anthropic')) return 'anthropic';

  const openaiKeywords = [
    'openai', 'deepseek', 'siliconflow', 'dashscope', 'volces', 'moonshot',
    'minimaxi', 'minimax', 'bigmodel', 'z.ai', 'groq', 'mistral', 'together',
    'fireworks', 'cerebras', 'huggingface', 'tokenhub', 'longcat', 'xiaomimimo',
    'stepfun', 'baichuan', 'perplexity', 'nvidia', 'x.ai',
  ];
  if (
    openaiKeywords.some((kw) => hostname.includes(kw))
    || fullPath === '/v1'
    || fullPath.startsWith('/v1/')
    || fullPath.endsWith('/v1')
  ) {
    return 'openai';
  }

  return null;
}

export function looksLikeGoogleOAuthCredential(rawCred) {
  const trimmed = String(rawCred || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return trimmed.startsWith('ya29.')
    || lower.startsWith('bearer ')
    || trimmed.startsWith('{')
    || trimmed.startsWith('@')
    || lower === 'adc'
    || lower === 'gcloud';
}

function defaultAdcPath() {
  const envCred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envCred && fs.existsSync(envCred.trim())) return envCred.trim();
  const sdkDir = process.env.CLOUDSDK_CONFIG;
  if (sdkDir) {
    const p = path.join(sdkDir.trim(), 'application_default_credentials.json');
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    const p = path.join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json');
    if (fs.existsSync(p)) return p;
  }
  const home = os.homedir();
  if (home) {
    const p = path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveCredentialJsonText(rawCred) {
  const trimmed = String(rawCred || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower === 'adc' || lower === 'gcloud') {
    const adc = defaultAdcPath();
    if (!adc) {
      throw new Error('未找到 Google Cloud ADC 凭据文件（请先运行 `gcloud auth application-default login` 或设置 `GOOGLE_APPLICATION_CREDENTIALS`）');
    }
    return fs.readFileSync(adc, 'utf8');
  }
  if (trimmed.startsWith('@')) {
    const rel = trimmed.slice(1).trim();
    const expanded = (rel.startsWith('~/') || rel.startsWith('~\\'))
      ? path.join(os.homedir(), rel.slice(2))
      : rel;
    return fs.readFileSync(expanded, 'utf8');
  }
  return null;
}

export function extractCredentialProjectId(rawCred) {
  try {
    const jsonText = resolveCredentialJsonText(rawCred);
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    const id = String(parsed?.project_id || parsed?.quota_project_id || '').trim();
    return id || null;
  } catch {
    return null;
  }
}

export function geminiActionApiPath(apiPath, action = 'generateContent') {
  const raw = String(apiPath || '');
  if (!raw) return raw;
  const [pathnamePart, queryPart = ''] = raw.split('?');
  const normalizedMethod = action === 'streamGenerateContent'
    ? 'streamGenerateContent'
    : (action === 'countTokens' ? 'countTokens' : 'generateContent');

  let nextPath = pathnamePart;
  if (/:(?:generateContent|streamGenerateContent|countTokens)$/i.test(pathnamePart)) {
    nextPath = pathnamePart.replace(/:(?:generateContent|streamGenerateContent|countTokens)$/i, `:${normalizedMethod}`);
  } else if (nextPath && !nextPath.includes(':')) {
    return raw;
  }

  const params = new URLSearchParams(queryPart);
  if (normalizedMethod === 'streamGenerateContent') {
    if (!params.has('alt')) params.set('alt', 'sse');
  } else {
    params.delete('alt');
  }
  const nextQuery = params.toString();
  return nextQuery ? `${nextPath}?${nextQuery}` : nextPath;
}

function mergeEmbeddedAndApiPath(embedded, cleanArg) {
  if (!cleanArg) return embedded || '';
  if (!embedded) return cleanArg;
  const eLower = embedded.toLowerCase();
  const cLower = cleanArg.toLowerCase();
  if (cLower === eLower || cLower.startsWith(`${eLower}/`) || cLower.startsWith(`${eLower}?`)) {
    return cleanArg;
  }
  return `${embedded}${cleanArg}`;
}

export function normalizeGeminiApiPath(host, apiPath, model, action = 'generateContent') {
  const parsed = parseHostOriginAndPath(host);
  const embedded = parsed.error ? '' : parsed.basePath;
  const cleanArg = cleanApiPath(apiPath);
  const clean = mergeEmbeddedAndApiPath(embedded, cleanArg);

  const [pathOnly, queryOnly = ''] = clean.split('?');
  const lower = pathOnly.toLowerCase();
  const rawModel = String(model || '').trim().replace(/^models\//i, '');
  const encodedModel = encodeURIComponent(rawModel);
  const isVertex = isVertexEndpoint(host, pathOnly);
  const suffix = action === 'streamGenerateContent'
    ? 'streamGenerateContent'
    : (action === 'countTokens' ? 'countTokens' : 'generateContent');

  let baseResolved;
  if (/:(?:generatecontent|streamgeneratecontent|counttokens)$/i.test(lower)) {
    baseResolved = pathOnly;
  } else if (
    lower.includes('/v1beta/models/')
    || lower.includes('/v1/models/')
    || lower.includes('/publishers/google/models/')
  ) {
    baseResolved = `${pathOnly}:${suffix}`;
  } else if (!pathOnly) {
    baseResolved = isVertex
      ? `/v1/publishers/google/models/${encodedModel}:${suffix}`
      : `/v1beta/models/${encodedModel}:${suffix}`;
  } else if (lower.endsWith('/publishers/google/models') || lower.endsWith('/models')) {
    baseResolved = `${pathOnly}/${encodedModel}:${suffix}`;
  } else if (lower.endsWith('/publishers/google')) {
    baseResolved = `${pathOnly}/models/${encodedModel}:${suffix}`;
  } else if (/\/v1(?:beta1?)?\/projects\/[^/]+\/locations\/[^/]+$/i.test(lower)) {
    baseResolved = `${pathOnly}/publishers/google/models/${encodedModel}:${suffix}`;
  } else if (lower.endsWith('/v1beta')) {
    baseResolved = `${pathOnly}/models/${encodedModel}:${suffix}`;
  } else if (lower.endsWith('/v1')) {
    baseResolved = isVertex
      ? `${pathOnly}/publishers/google/models/${encodedModel}:${suffix}`
      : `${pathOnly.slice(0, -3)}/v1beta/models/${encodedModel}:${suffix}`;
  } else {
    baseResolved = `${pathOnly}/v1beta/models/${encodedModel}:${suffix}`;
  }

  const fullWithQuery = queryOnly ? `${baseResolved}?${queryOnly}` : baseResolved;
  return geminiActionApiPath(fullWithQuery, action);
}

export function resolveGeminiEndpoint(host, apiPath, model, rawCred, action = 'generateContent') {
  const parsed = parseHostOriginAndPath(host);
  let protocol = parsed.error ? 'https' : parsed.protocol;
  let hostname = parsed.error ? String(host || '').trim() : parsed.rawHostname;
  let port = parsed.error ? 443 : parsed.port;
  let origin = parsed.error ? String(host || '').trim().replace(/\/+$/, '') : parsed.origin;
  const embedded = parsed.error ? '' : parsed.basePath;

  let effectivePath = mergeEmbeddedAndApiPath(embedded, cleanApiPath(apiPath));
  if (effectivePath.includes('{project}')) {
    const project = extractCredentialProjectId(rawCred);
    if (project) effectivePath = effectivePath.replace(/\{project\}/g, project);
  }

  const isOAuth = looksLikeGoogleOAuthCredential(rawCred);
  if (isOAuth && isVertexEndpoint(origin, effectivePath) && !/\/projects\//i.test(effectivePath)) {
    const project = extractCredentialProjectId(rawCred);
    if (project) {
      const hostLow = hostname.toLowerCase();
      const repMatch = hostLow.match(/^aiplatform\.([a-z0-9-]+)\.rep\.googleapis\.com$/);
      const regMatch = hostLow.match(/^([a-z0-9-]+)-aiplatform\.googleapis\.com$/);
      const loc = repMatch?.[1] || regMatch?.[1] || 'global';
      const [pathPart, queryPart = ''] = effectivePath.split('?');
      const pubMatch = pathPart.match(/^(\/v1(?:beta1?)?)?\/(publishers(?:\/.*)?)$/i);
      if (!pathPart) {
        effectivePath = `/v1/projects/${encodeURIComponent(project)}/locations/${loc}`;
      } else if (/^\/v1(?:beta1?)?$/i.test(pathPart)) {
        effectivePath = `${pathPart}/projects/${encodeURIComponent(project)}/locations/${loc}`;
      } else if (pubMatch) {
        const ver = pubMatch[1] || '/v1';
        effectivePath = `${ver}/projects/${encodeURIComponent(project)}/locations/${loc}/${pubMatch[2]}`;
      }
      if (queryPart && !effectivePath.includes('?')) {
        effectivePath = `${effectivePath}?${queryPart}`;
      }
    }
  }
  if (isOAuth && hostname.toLowerCase() === 'aiplatform.googleapis.com') {
    const locMatch = effectivePath.match(/\/locations\/([^/]+)(?:\/|$)/i);
    if (locMatch) {
      const loc = locMatch[1].trim().toLowerCase();
      if (loc && loc !== 'global' && !loc.includes('{')) {
        hostname = (loc === 'us' || loc === 'eu')
          ? `aiplatform.${loc}.rep.googleapis.com`
          : `${loc}-aiplatform.googleapis.com`;
        origin = `${protocol}://${hostname}${(protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443) ? `:${port}` : ''}`;
      }
    }
  }

  const normalizedPath = normalizeGeminiApiPath(origin, effectivePath || null, model, action);
  return {
    origin,
    protocol,
    hostname,
    port,
    apiPath: normalizedPath,
    isVertex: isVertexEndpoint(origin, normalizedPath),
    isOAuth,
  };
}

function base64Url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signServiceAccountJwt(clientEmail, privateKeyPem, tokenUri) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: GOOGLE_CLOUD_PLATFORM_SCOPE,
    aud: tokenUri,
    iat,
    exp,
  }));
  const signingInput = `${header}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

function canonicalCredentialFingerprint(credObj) {
  const canonicalize = (val) => {
    if (Array.isArray(val)) return val.map(canonicalize);
    if (val && typeof val === 'object') {
      const out = {};
      for (const k of Object.keys(val).sort()) {
        out[k] = canonicalize(val[k]);
      }
      return out;
    }
    return val;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(credObj))).digest('hex');
}

function defaultTokenHttpPost(urlStr, { form, json, headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttp = parsed.protocol === 'http:';
    const body = form
      ? Buffer.from(new URLSearchParams(form).toString(), 'utf8')
      : Buffer.from(JSON.stringify(json || {}), 'utf8');
    const reqHeaders = {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'content-length': body.length,
      ...headers,
    };
    const mod = isHttp ? http : https;
    const req = mod.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : (isHttp ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: reqHeaders,
      signal,
      agent: isHttp ? undefined : httpsAgentFor(SHARED_HTTPS_AGENT),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsedBody = null;
        try { parsedBody = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: res.statusCode || 0, headers: res.headers || {}, text, json: parsedBody });
      });
      res.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(Object.assign(new Error('Google OAuth token exchange timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

async function postTokenWithTransientRetry(tokenPoster, urlStr, reqOpts, errorPrefix) {
  return withRetry(
    async (signal) => {
      const r = await tokenPoster(urlStr, { ...reqOpts, signal });
      if (r.statusCode >= 200 && r.statusCode < 300) return r;
      const err = Object.assign(
        new Error(`${errorPrefix} (HTTP ${r.statusCode}): ${String(r.text || '').slice(0, 200)}`),
        { statusCode: r.statusCode, headers: r.headers || {} },
      );
      throw err;
    },
    { maxRetries: 2, baseMs: 150, capMs: 1000, maxTotalMs: 8000, label: 'google-oauth' },
  );
}

async function mintTokenFromJsonObject(credObj, tokenPoster) {
  const canonicalKey = canonicalCredentialFingerprint(credObj);
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(canonicalKey);
  if (cached && cached.expiresAt > now + TOKEN_REFRESH_LEAD_SECS) {
    boundedMapSet(tokenCache, canonicalKey, cached, MAX_TOKEN_CACHE_ENTRIES);
    return cached.accessToken;
  }
  if (tokenInflight.has(canonicalKey)) {
    return tokenInflight.get(canonicalKey);
  }

  const promise = (async () => {
    const credType = String(credObj?.type || '').trim();
    let accessToken = '';
    let expiresAt = now + 3500;

    if (credType === 'service_account') {
      const email = String(credObj.client_email || '').trim();
      const pk = String(credObj.private_key || '').trim();
      const tokenUri = String(credObj.token_uri || '').trim() || DEFAULT_GOOGLE_TOKEN_URI;
      if (!email) throw new Error('Service Account 凭据缺少 client_email');
      if (!pk) throw new Error('Service Account 凭据缺少 private_key');
      const assertion = signServiceAccountJwt(email, pk, tokenUri);
      const r = await postTokenWithTransientRetry(
        tokenPoster,
        tokenUri,
        {
          form: {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          },
        },
        'Google Service Account 换取令牌失败',
      );
      accessToken = String(r.json?.access_token || '').trim();
      if (!accessToken) throw new Error('Google Token 响应缺少 access_token');
      const ttl = Math.max(60, Number(r.json?.expires_in) || 3600);
      expiresAt = Math.floor(Date.now() / 1000) + ttl;
    } else if (credType === 'authorized_user') {
      const clientId = String(credObj.client_id || '').trim();
      const clientSecret = String(credObj.client_secret || '').trim();
      const refreshToken = String(credObj.refresh_token || '').trim();
      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Google authorized_user 凭据缺少 client_id / client_secret / refresh_token');
      }
      const r = await postTokenWithTransientRetry(
        tokenPoster,
        DEFAULT_GOOGLE_TOKEN_URI,
        {
          form: {
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
          },
        },
        'Google ADC 刷新令牌失败',
      );
      accessToken = String(r.json?.access_token || '').trim();
      if (!accessToken) throw new Error('Google ADC 响应缺少 access_token');
      const ttl = Math.max(60, Number(r.json?.expires_in) || 3600);
      expiresAt = Math.floor(Date.now() / 1000) + ttl;
    } else if (credType === 'impersonated_service_account') {
      const targetUrl = String(credObj.service_account_impersonation_url || '').trim();
      const sourceCred = credObj.source_credentials;
      if (!targetUrl) throw new Error('Google impersonated_service_account 缺少 service_account_impersonation_url');
      if (!sourceCred || typeof sourceCred !== 'object') {
        throw new Error('Google impersonated_service_account 缺少 source_credentials');
      }
      const sourceToken = await mintTokenFromJsonObject(sourceCred, tokenPoster);
      const r = await postTokenWithTransientRetry(
        tokenPoster,
        targetUrl,
        {
          headers: { authorization: `Bearer ${sourceToken}` },
          json: { scope: [GOOGLE_CLOUD_PLATFORM_SCOPE] },
        },
        'IAM 服务账号模拟令牌失败',
      );
      accessToken = String(r.json?.accessToken || r.json?.access_token || '').trim();
      if (!accessToken) throw new Error('IAM 响应缺少 accessToken');
      expiresAt = Math.floor(Date.now() / 1000) + 3500;
    } else {
      throw new Error(`不支持的 Google 凭据类型: ${credType || '(未知)'}`);
    }

    boundedMapSet(tokenCache, canonicalKey, { accessToken, expiresAt }, MAX_TOKEN_CACHE_ENTRIES);
    return accessToken;
  })();

  tokenInflight.set(canonicalKey, promise);
  try {
    return await promise;
  } finally {
    tokenInflight.delete(canonicalKey);
  }
}

export async function resolveGeminiAuthHeader(rawCred, options = {}) {
  const trimmed = String(rawCred || '').trim();
  if (!trimmed) {
    throw new Error('缺少 API 密钥或 Google OAuth 凭据');
  }
  if (/^bearer\s+/i.test(trimmed)) {
    const token = trimmed.replace(/^bearer\s+/i, '').trim();
    return { headers: { authorization: `Bearer ${token}` }, authScheme: 'bearer', token };
  }
  if (trimmed.startsWith('ya29.')) {
    return { headers: { authorization: `Bearer ${trimmed}` }, authScheme: 'bearer', token: trimmed };
  }
  const jsonText = resolveCredentialJsonText(trimmed);
  if (jsonText !== null) {
    let credObj;
    try {
      credObj = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`Google 凭据 JSON 解析失败: ${e.message}`);
    }
    const tokenPoster = typeof options.tokenPoster === 'function' ? options.tokenPoster : defaultTokenHttpPost;
    const token = await mintTokenFromJsonObject(credObj, tokenPoster);
    return { headers: { authorization: `Bearer ${token}` }, authScheme: 'bearer', token };
  }
  return { headers: { 'x-goog-api-key': trimmed }, authScheme: 'x-api-key', token: trimmed };
}

export function redactGeminiCredential(text, rawCred = '') {
  let out = String(text || '');
  const trimmed = String(rawCred || '').trim();
  if (trimmed && trimmed.length >= 6 && !trimmed.startsWith('{')) {
    out = out.split(trimmed).join('***');
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      for (const field of ['private_key', 'refresh_token', 'client_secret']) {
        const val = parsed?.[field];
        if (typeof val === 'string' && val.length >= 6) {
          out = out.split(val).join('***');
        }
      }
    } catch { /* ignore */ }
  }
  out = out.replace(/ya29\.[A-Za-z0-9._-]+/g, '***');
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***');
  return out;
}

export {
  GEMINI_SKIP_THOUGHT_SIGNATURE,
  applyGeminiSkipThoughtSignatureValidator,
  buildGeminiCountTokensPayload,
  downgradeGeminiThinkingConfigOn400,
  healGemini400Payload,
  healGeminiInvalidThoughtSignature,
  isGemini3Or4Model,
  normalizeGeminiResponseJson,
  normalizeGeminiThinkingConfig,
} from './google-gemini/thinking.js';
