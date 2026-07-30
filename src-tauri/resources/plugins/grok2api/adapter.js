// plugins/grok2api/adapter.js
// Grok2API adapter for AnyBridge plugin system
// All methods receive ctx as first parameter (explicit injection, no bind)

export default {
  // ═══════════════════════════════════════════════════
  // 部署阶段
  // ═══════════════════════════════════════════════════

  async checkEnvironment(ctx, strategy = 'source') {
    const missing = [];
    const isWindows = process.platform === 'win32';
    const pick = (win, mac, linux) => (isWindows ? win : process.platform === 'darwin' ? mac : linux);

    // Docker strategy only needs a working Docker CLI
    if (strategy === 'docker') {
      if (!await ctx.commandExists('docker')) {
        missing.push({
          name: 'Docker',
          installer: pick('winget:Docker.DockerDesktop', 'brew:docker', 'apt:docker.io'),
          alternativeDownload: 'https://www.docker.com/products/docker-desktop/'
        });
      }
      return { ready: missing.length === 0, missing, strategy };
    }

    // Source strategy: full toolchain
    if (!await ctx.commandExists('go')) {
      missing.push({
        name: 'Go',
        version: '>=1.26',
        installer: pick('winget:GoLang.Go', 'brew:go', 'apt:golang'),
        alternativeDownload: 'https://golang.google.cn/dl/'
      });
    }

    if (!await ctx.commandExists('node')) {
      missing.push({
        name: 'Node.js',
        version: '>=18',
        installer: pick('winget:OpenJS.NodeJS', 'brew:node', 'apt:nodejs'),
        alternativeDownload: 'https://nodejs.org/'
      });
    }

    if (!await ctx.commandExists('pnpm')) {
      missing.push({
        name: 'pnpm',
        installer: 'npm:pnpm',
        alternativeDownload: 'https://pnpm.io/installation'
      });
    }

    if (!await ctx.commandExists('git')) {
      missing.push({
        name: 'Git',
        installer: pick('winget:Git.Git', 'brew:git', 'apt:git'),
        alternativeDownload: 'https://git-scm.com/downloads'
      });
    }

    return { ready: missing.length === 0, missing, strategy };
  },

  async generateConfig(ctx, configValues, installPath) {
    const listenAddr = configValues._deployStrategy === 'docker' ? '0.0.0.0' : '127.0.0.1';
    const yaml = `server:
  listen: "${listenAddr}:${configValues.port}"
  maxBodyBytes: 33554432
  readTimeout: 15m
  requestTimeout: 2h
  swaggerEnabled: false

auth:
  accessTokenTTL: 15m
  refreshTokenTTL: 720h
  secureCookies: false

secrets:
  jwtSecret: "${configValues.jwtSecret}"
  credentialEncryptionKey: "${configValues.encryptionKey}"

bootstrapAdmin:
  username: "admin"
  password: "${configValues.adminPassword}"

frontend:
  staticPath: "./frontend/dist"

database:
  driver: sqlite
  sqlite:
    path: "./data/backend.db"

runtimeStore:
  driver: memory

deployment:
  replicas: 1
  instanceID: ""
  clusterID: "grok2api"
  sharedMedia: false

media:
  driver: local
  local:
    path: "./data/media"

routing:
  reasoningReplayEnabled: true
  reasoningReplayTTL: 1h
  reasoningReplayMaxEntries: 10240
  segmentedSelectorEnabled: false
  segmentedSelectorMinCandidates: 3000
  segmentedSelectorWindowSize: 64

audit:
  bufferSize: 16384
  batchSize: 256
  flushInterval: 250ms
  commitDelay: 5ms
  ledgerMode: enforce
  ledgerFailureThreshold: 1
  ledgerUnhealthyGrace: 10s
  ledgerQueueHighWatermarkPercent: 90
`;
    const configPath = ctx.path.join(installPath, 'config.yaml');
    await ctx.fs.writeFile(configPath, yaml, 'utf-8');
    return { configPath };
  },

  // ═══════════════════════════════════════════════════
  // 运行阶段
  // ═══════════════════════════════════════════════════

  async prepareStart(ctx, installPath, configValues) {
    const binaryName = process.platform === 'win32' ? 'grok2api.exe' : 'grok2api';
    return {
      command: ctx.path.join(installPath, binaryName),
      args: ['--config', ctx.path.join(installPath, 'config.yaml')],
      cwd: installPath,
      env: {}
    };
  },

  async healthCheck(ctx, port, configValues) {
    try {
      const start = Date.now();
      const res = await ctx.fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
      return {
        ok: res.ok,
        latency: Date.now() - start
      };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  },

  // ═══════════════════════════════════════════════════
  // 认证
  // ═══════════════════════════════════════════════════

  async authenticate(ctx, port, configValues) {
    const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: configValues.adminPassword
      })
    });
    const data = await res.json();
    return { token: data.tokens.accessToken, expiresAt: data.tokens.accessTokenExpiresAt };
  },

  // ═══════════════════════════════════════════════════
  // 账号管理
  // ═══════════════════════════════════════════════════

  async getAccountStats(ctx, port, adminToken) {
    const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/accounts/summary`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    return res.json();
  },

  async getAccounts(ctx, port, adminToken, options = {}) {
    const { page = 1, pageSize = 50, provider = 'grok_build' } = options;
    const url = new URL(`http://127.0.0.1:${port}/api/admin/v1/accounts`);
    url.searchParams.set('page', page);
    url.searchParams.set('pageSize', pageSize);
    url.searchParams.set('provider', provider);

    const res = await ctx.fetch(url, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    return res.json();
  },

  async importAccounts(ctx, port, adminToken, filePath, type) {
    const endpointMap = {
      build: 'accounts/import',
      web: 'accounts/web/import',
      console: 'accounts/console/import'
    };
    const endpoint = endpointMap[type] || endpointMap.build;
    const fileBuffer = await ctx.fs.readFile(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), ctx.path.basename(filePath));

    const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` },
      body: formData
    });
    return res.json();
  },

  async exportAccounts(ctx, port, adminToken, provider) {
    const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/accounts/export?provider=${provider}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    return res.blob();
  },

  // ═══════════════════════════════════════════════════
  // Client Key 管理
  // ═══════════════════════════════════════════════════

  async listClientKeys(ctx, port, adminToken) {
    const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/client-keys`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    return res.json();
  },

  async createClientKey(ctx, port, adminToken, name) {
    const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/client-keys`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        enabled: true,
        expiresAt: '',
        rpmLimit: 0,
        maxConcurrent: 0,
        billingLimitUsdTicks: 0,
        allowModelAliases: false,
        allowedModelIds: []
      })
    });
    return res.json();
  },

  async deleteClientKey(ctx, port, adminToken, keyId) {
    const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/client-keys/${keyId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    return res.json();
  },

  // ═══════════════════════════════════════════════════
  // 版本信息
  // ═══════════════════════════════════════════════════

  async getVersion(ctx, port, adminToken) {
    try {
      const res = await ctx.fetch(`http://127.0.0.1:${port}/api/admin/v1/system/version`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        return { version: data.version || 'unknown' };
      }
      return { version: 'unknown' };
    } catch {
      return { version: 'unknown' };
    }
  },

  // ═══════════════════════════════════════════════════
  // 日志
  // ═══════════════════════════════════════════════════

  async getLogs(ctx, port, options = {}) {
    return null;
  },

  // ═══════════════════════════════════════════════════
  // 卸载
  // ═══════════════════════════════════════════════════

  async prepareUninstall(ctx, installPath, configValues) {
    return {
      cleanFiles: [
        installPath,
        ctx.path.join(installPath, 'data')
      ],
      cleanRegistry: false
    };
  }
};
