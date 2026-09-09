// plugins/jimeng2api/adapter.js
// Jimeng2API adapter for AnyBridge plugin system
// All methods receive ctx as first parameter (explicit injection, no bind)

export default {
  // ═══════════════════════════════════════════════════
  // 部署阶段
  // ═══════════════════════════════════════════════════

  async checkEnvironment(ctx, strategy = 'source') {
    const missing = [];
    const isWindows = process.platform === 'win32';
    const pick = (win, mac, linux) => (isWindows ? win : process.platform === 'darwin' ? mac : linux);

    // 源码策略：需要 Node.js >= 22 与 Git
    if (!await ctx.commandExists('node')) {
      missing.push({
        name: 'Node.js',
        version: '>=22',
        installer: pick('winget:OpenJS.NodeJS', 'brew:node', 'apt:nodejs'),
        alternativeDownload: 'https://nodejs.org/'
      });
    } else {
      try {
        const { stdout } = await ctx.exec('node -v');
        const match = stdout.trim().match(/v?(\d+)/);
        const major = match ? parseInt(match[1], 10) : 0;
        if (major < 22) {
          missing.push({
            name: `Node.js (当前 v${major}，因 better-sqlite3 模块硬性要求 >= 22)`,
            version: '>=22',
            installer: pick('winget:OpenJS.NodeJS', 'brew:node', 'apt:nodejs'),
            alternativeDownload: 'https://nodejs.org/'
          });
        }
      } catch {
        // 忽略版本解析异常，保留已有 node
      }
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
    const port = Number(configValues.port) || 5566;
    const accountPoolKey = configValues.accountPoolKey || ctx.generateBase64(32);
    const timezone = configValues.timezone || 'Asia/Shanghai';
    const adminPassword = configValues.adminPassword || '';

    // 1. 生成项目根目录下的 .env 文件
    const envLines = [
      `PORT=${port}`,
      `SERVER_PORT=${port}`,
      `TZ=${timezone}`,
      `JIMENG_ACCOUNT_POOL_KEY=${accountPoolKey}`,
      `ACCOUNT_POOL_ENCRYPTION_KEY=${accountPoolKey}`
    ];
    if (adminPassword) {
      envLines.push(`ADMIN_PASSWORD=${adminPassword}`);
    }
    const envContent = envLines.join('\n') + '\n';
    const envPath = ctx.path.join(installPath, '.env');
    await ctx.fs.writeFile(envPath, envContent, 'utf-8');

    // 同步更新 configs 目录中的 service.yml 端口配置
    for (const sub of ['dev', 'prod']) {
      const cfgPath = ctx.path.join(installPath, 'configs', sub, 'service.yml');
      try {
        if (await ctx.fs.stat(cfgPath).catch(() => null)) {
          let yml = await ctx.fs.readFile(cfgPath, 'utf-8');
          yml = yml.replace(/port:\s*\d+/g, `port: ${port}`);
          await ctx.fs.writeFile(cfgPath, yml, 'utf-8');
        }
      } catch {}
    }

    // 应用免登录补丁（使本地控制台免密直达，对齐 CPA 体验）
    await this.applyAutoLoginPatch(ctx, installPath);

    return { configPath: envPath };
  },

  // ═══════════════════════════════════════════════════
  // 本地免密直达补丁
  // ═══════════════════════════════════════════════════

  async applyAutoLoginPatch(ctx, installPath) {
    // 1. 补丁 dist/index.js 与 dist/index.cjs 中的 authError 和 requireAdmin
    for (const fileName of ['index.js', 'index.cjs']) {
      const distPath = ctx.path.join(installPath, 'dist', fileName);
      try {
        if (await ctx.fs.stat(distPath).catch(() => null)) {
          let dist = await ctx.fs.readFile(distPath, 'utf-8');
          let modified = false;

          if (dist.includes('function authError(') && dist.includes('return sessionUser(')) {
            dist = dist.replace(/function authError\(request2\)\s*\{[\s\S]*?statusCode:\s*401\s*\}\);?\s*\}/, 'function authError(request2) {\n  return null;\n}');
            modified = true;
          }

          if (dist.includes('function requireAdmin(') && dist.includes('validateSession(')) {
            dist = dist.replace(/function requireAdmin\(request2\)\s*\{[\s\S]*?statusCode:\s*401\s*\}\);?\s*return null;\s*\}/, 'function requireAdmin(request2) {\n  return null;\n}');
            modified = true;
          }

          if (modified) {
            await ctx.fs.writeFile(distPath, dist, 'utf-8');
          }
        }
      } catch {}
    }

    // 2. 补丁 public/index.html：加载页面时直接激活 Dashboard，隐藏多余的密码修改与登出按钮
    const htmlPath = ctx.path.join(installPath, 'public', 'index.html');
    try {
      if (await ctx.fs.stat(htmlPath).catch(() => null)) {
        let html = await ctx.fs.readFile(htmlPath, 'utf-8');
        if (!html.includes('/* ANYBRIDGE_AUTO_LOGIN */')) {
          html = html.replace('async function checkAuth() {', '/* ANYBRIDGE_AUTO_LOGIN */ async function checkAuth() { showDashboard(); return;');
          html = html.replace('<div class="header-actions">', '<div class="header-actions" style="display:none">');
          await ctx.fs.writeFile(htmlPath, html, 'utf-8');
        }
      }
    } catch {}
  },

  // ═══════════════════════════════════════════════════
  // 运行阶段
  // ═══════════════════════════════════════════════════

  async prepareStart(ctx, installPath, configValues) {
    // 确保免登录补丁已生效
    await this.applyAutoLoginPatch(ctx, installPath);

    const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';
    const entryPath = ctx.path.join(installPath, 'dist', 'index.js');
    const port = String(configValues.port || 5566);
    const key = String(configValues.accountPoolKey || '');
    const tz = String(configValues.timezone || 'Asia/Shanghai');

    return {
      command: binaryName,
      args: ['--enable-source-maps', '--no-node-snapshot', entryPath, '--port', port],
      cwd: installPath,
      env: {
        PORT: port,
        SERVER_PORT: port,
        JIMENG_ACCOUNT_POOL_KEY: key,
        ACCOUNT_POOL_ENCRYPTION_KEY: key,
        TZ: tz
      }
    };
  },

  async healthCheck(ctx, port, configValues) {
    try {
      const start = Date.now();
      const res = await ctx.fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(3000)
      });
      return {
        ok: res.ok,
        latency: Date.now() - start
      };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  },

  async prepareStop(ctx, installPath, configValues) {
    // 源码策略：返回 null，Rust 核心直接按 PID 发送终止信号
    return null;
  }
};
