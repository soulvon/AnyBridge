// plugins/aistudio2api/adapter.js
// AIStudio2API adapter for AnyBridge plugin system
// 上游：https://github.com/Mag1cFall/AIStudio2API
//
// 所有方法第一个参数为 ctx（显式注入，无 bind）。
// ctx 由 sidecar/plugin-loader.js 注入：
//   { commandExists, fetch, fs, path, exec, log, generateHex, generateBase64, generatePassword, pluginDir }
//
// 分工：发布包的获取（下载 + 解压 + 换二进制 + 记版本）由 AnyBridge 的 Rust 侧统一完成，
// 走的是和 CPA（CLIProxyAPI / CPA Manager Plus）安装部署完全相同的一条链路 ——
// 系统代理 + 镜像测速挑最快源 + 逐源重试。plugin.json 的 deploy.asset 声明要哪个产物。
//
// 这里只负责下载之后的事：磁盘预检、生成 .env、启动参数、面板数据。
// 不再用 curl 下载：curl.exe 用自带 CA 包，本机代理 / 企业网下极易 60 失败。

const BINARY = 'aistudio2api';
const PLUGIN_ID = 'aistudio2api';
const DEFAULT_PORT = 2048;
const VERSION_FILE = '.aistudio2api-version';
const ENV_NAME = '.env';
const MIN_DISK_MB = 200; // 与 plugin.json 的 deploy.minDiskMB 保持一致：exe 约 87MB，运行期还要写 runtime/
const NETWORK_TIMEOUT_MS = 30000;

// 账户目录刻意用 auths 而不是上游默认的 auth：
// plugin_asset.rs 的 restore_latest_backup 只回放 auths/ 与 data/ 两个目录，
// 名字对齐后「卸载 → 重装」才能自动把 Google 账户凭证放回去，不必重新登录。
const AUTH_DIR = 'auths';

function binFileName() {
  return process.platform === 'win32' ? `${BINARY}.exe` : BINARY;
}

// ── 路径 ──────────────────────────────────────────────────────────────────
// 与 Rust 侧 plugins_dir()（dirs::config_dir + AnyBridge/plugins）对齐，
// 用于在无 installPath 的面板方法里读回端口与密钥。
//
// 用户目录可能含空格或中文（C:\Users\John Doe、/home/张三），因此路径一律用
// path.join 组装、绝不在 shell 命令里裸拼；拿不到主目录就明确报错，而不是
// 退化成相对路径把插件装到当前工作目录里去。
function homeDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('无法确定用户主目录（HOME / USERPROFILE 均未设置），无法定位插件数据目录。');
  }
  return home;
}

function anybridgePluginDir(ctx) {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || ctx.path.join(homeDir(), 'AppData', 'Roaming');
    return ctx.path.join(appData, 'AnyBridge', 'plugins', PLUGIN_ID);
  }
  if (platform === 'darwin') {
    return ctx.path.join(homeDir(), 'Library', 'Application Support', 'AnyBridge', 'plugins', PLUGIN_ID);
  }
  const xdg = process.env.XDG_CONFIG_HOME || ctx.path.join(homeDir(), '.config');
  return ctx.path.join(xdg, 'AnyBridge', 'plugins', PLUGIN_ID);
}

// Rust 的 plugin_config_path 写在这里，部署完成后含 port / apiKey / installPath。
async function readStoredConfig(ctx) {
  try {
    return JSON.parse(await ctx.fs.readFile(ctx.path.join(anybridgePluginDir(ctx), 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

async function readInstalledVersion(ctx, installPath) {
  try {
    return (await ctx.fs.readFile(ctx.path.join(installPath, VERSION_FILE), 'utf-8')).trim();
  } catch {
    return '';
  }
}

// 磁盘空间预检：exe 约 87MB，解压与后续运行（账户、日志、媒体）都要余量。
async function ensureDiskSpace(ctx, installPath) {
  const statfs = ctx.fs.statfs;
  if (typeof statfs !== 'function') return; // 老版本 Node 没有 statfs，跳过而不拦路
  try {
    const st = await statfs(installPath);
    const freeMB = (st.bavail * st.bsize) / (1024 * 1024);
    if (freeMB < MIN_DISK_MB) {
      throw new Error(
        `磁盘空间不足：安装目录仅剩 ${Math.round(freeMB)} MB，至少需要 ${MIN_DISK_MB} MB。请清理后重试。`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('磁盘空间不足')) throw e;
    // 探测失败（如不支持的文件系统）不阻断安装
  }
}

// 二进制由 Rust 在部署/更新开始时放到安装目录。这里只校验、不下载：
// 缺失说明前置步骤没走完，如实报错而不是自己再造一条下载路径。
async function requireBinary(ctx, installPath) {
  const binPath = ctx.path.join(installPath, binFileName());
  try {
    await ctx.fs.access(binPath);
  } catch {
    throw new Error(
      `安装目录缺少 ${binFileName()}（${binPath}）。请重新执行安装，让 AnyBridge 重新获取发布包。`
    );
  }
  return binPath;
}

// 只改写托管键，保留用户在控制台设置页保存的其余 .env 项与注释。
// 上游保存设置时会整体写回 .env，全量覆盖会把用户配置清掉。
function applyEnvSettings(existing, settings) {
  const seen = new Set();
  const lines = [];
  for (const line of (existing ? existing.split(/\r?\n/) : [])) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.prototype.hasOwnProperty.call(settings, match[1])) {
      lines.push(line);
      continue;
    }
    if (seen.has(match[1])) continue; // 重复键只留一行
    seen.add(match[1]);
    lines.push(`${match[1]}=${settings[match[1]]}`);
  }
  for (const [key, value] of Object.entries(settings)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// 上游要求 LISTEN_ADDR 与 PREVIEW_LISTEN_ADDR 的端口不同，否则配置校验直接失败。
// 预览页端口跟主端口相邻，被占用时上游自己会另挑一个空闲端口。
function previewPort(port) {
  return port < 65535 ? port + 1 : port - 1;
}

export default {
  // ═══════════════════════════════════════════════════════════════════════
  // 部署阶段
  // ═══════════════════════════════════════════════════════════════════════

  // 预编译二进制直接运行，本机不需要 Go / Node / Docker / git。
  // 下载工具也无需检查：抓包由 AnyBridge 的 Rust 侧完成（不依赖 curl / tar）。
  async checkEnvironment(ctx, strategy = 'adapter') {
    return { ready: true, missing: [], strategy };
  },

  async generateConfig(ctx, configValues, installPath) {
    await ctx.fs.mkdir(installPath, { recursive: true });
    await ensureDiskSpace(ctx, installPath);
    await requireBinary(ctx, installPath);

    const port = Number(configValues.port) || DEFAULT_PORT;
    const apiKey = typeof configValues.apiKey === 'string' ? configValues.apiKey.trim() : '';
    if (!apiKey) {
      // configSchema 声明了 generate: base64-32，sidecar 会在首次安装时生成。
      // 缺密钥还继续写 .env，会得到「网关免鉴权 + AnyBridge 不登记供应商」的错配状态，
      // 界面只表现为拉不到模型，因此这里直接把原因说出来。
      throw new Error('缺少 API 密钥：请在配置中填写，或重新安装让 AnyBridge 自动生成。');
    }

    const settings = {
      LISTEN_ADDR: `127.0.0.1:${port}`,
      PREVIEW_LISTEN_ADDR: `127.0.0.1:${previewPort(port)}`,
      PROXY_API_KEY: apiKey,
      // 装好即可用：管理进程一起来就拉生成服务，不必先去控制台点「启动服务」。
      // 没有账户时上游按 5s→5min 退避重试，日志由其自身轮转上限约束。
      AUTO_START: 'true',
      AISTUDIO_AUTH_STATES: AUTH_DIR
    };

    const envPath = ctx.path.join(installPath, ENV_NAME);
    const existing = await ctx.fs.readFile(envPath, 'utf-8').catch(() => '');
    await ctx.fs.writeFile(envPath, applyEnvSettings(existing, settings), 'utf-8');
    ctx.log('info', `配置文件已生成 ${envPath}（端口 ${port}）`);

    // 回传真正写进 .env 的密钥，Rust 侧据此登记本地供应商；
    // 两边只要不是同一把，拉取模型列表就会 401。
    return { configPath: envPath, apiKey };
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 运行阶段
  // ═══════════════════════════════════════════════════════════════════════

  async prepareStart(ctx, installPath, configValues) {
    const binPath = await requireBinary(ctx, installPath);
    const port = Number(configValues.port) || DEFAULT_PORT;

    // 上游 parseFlags 默认「无参数才打开管理界面」，插件托管时必须显式关掉：
    // Windows 包是 GUI 子系统，Linux/macOS 的 CLI 版会 xdg-open 弹浏览器。
    // 端口与密钥都在工作目录的 .env 里，这里不再传 -listen / -auth，
    // 免得同一份配置有两条来源、改端口时只改到一边。
    ctx.log('info', `启动 ${BINARY} -open-ui=false（端口 ${port}）`);
    return {
      command: binPath,
      args: ['-open-ui=false'],
      cwd: installPath,
      env: {}
    };
  },

  // 返回 null：交由 AnyBridge 结束进程树（Windows taskkill /T /F，Unix SIGTERM）。
  async prepareStop(ctx, installPath, configValues) {
    return null;
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 更新：二进制由 Rust 换成新版本后才调用到这里，这里只做收尾核对。
  // .env、auths/ 账户目录、runtime/ 运行数据全程不动。
  // ═══════════════════════════════════════════════════════════════════════

  async upgrade(ctx, installPath, configValues, onProgress) {
    await requireBinary(ctx, installPath);
    const version = await readInstalledVersion(ctx, installPath);
    onProgress?.({ step: 'done', status: 'done', message: '二进制已更新，配置与账户保留不变' });
    return {
      ok: true,
      message: version ? `已更新 ${BINARY} 到 ${version}` : `${BINARY} 已更新`,
    };
  },

  // 版本切换由 Rust 侧拦截处理（下载 → 换二进制 → 按原状态重启），这里不实现，
  // 以免出现第二条下载路径。

  // ═══════════════════════════════════════════════════════════════════════
  // 卸载：Google 账户凭证是登录成果，丢失后需要逐个重新登录，故先备份再删除
  // ═══════════════════════════════════════════════════════════════════════

  async prepareUninstall(ctx, installPath, configValues) {
    const from = ctx.path.join(installPath, AUTH_DIR);
    if (!await ctx.fs.access(from).then(() => true).catch(() => false)) {
      return { backupPath: '' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = ctx.path.join(homeDir(), '.anybridge', `${PLUGIN_ID}-backup-${stamp}`);
    await ctx.fs.cp(from, ctx.path.join(backupRoot, AUTH_DIR), { recursive: true });
    ctx.log('info', `账户凭证已备份到 ${backupRoot}`);
    return { backupPath: backupRoot };
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 管理面板（panels → gateway）
  // 复杂管理交给上游自带的控制台；这里只呈现确定契约的字段。
  // ═══════════════════════════════════════════════════════════════════════

  async getGatewayStatus(ctx, port) {
    const stored = await readStoredConfig(ctx);
    const apiKey = stored.apiKey || '';
    const base = `http://127.0.0.1:${port || DEFAULT_PORT}`;
    const apiBase = `${base}/v1`;

    // /api/status 是管理端状态（仅 loopback，默认免登录）：含 version 与 running。
    // /health 只反映管理进程存活，数据面没启动时仍返回 ok，因此面板不能拿它当「可用」。
    let status = null;
    try {
      const res = await ctx.fetch(`${base}/api/status`, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      if (res.ok) status = await res.json();
    } catch {
      status = null;
    }

    let modelCount = 0;
    if (apiKey) {
      try {
        const res = await ctx.fetch(`${apiBase}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
        });
        if (res.ok) {
          const payload = await res.json();
          modelCount = Array.isArray(payload?.data) ? payload.data.length : 0;
        }
      } catch {
        // 数据面未启动时 /v1/* 返回 503，模型数记 0，状态仍由管理端如实呈现
      }
    }

    const version = status?.version || (stored.installPath ? await readInstalledVersion(ctx, stored.installPath) : '');
    return {
      service: 'AIStudio2API',
      state: !status ? '管理进程未响应' : (status.running ? '运行中' : '未启动'),
      apiBase,
      version,
      models: modelCount,
      apiKey
    };
  },

  async openConsole(ctx, port) {
    const url = `http://127.0.0.1:${port || DEFAULT_PORT}/`;
    if (process.platform === 'win32') {
      await ctx.exec(`start "" "${url}"`);
    } else if (process.platform === 'darwin') {
      await ctx.exec(`open "${url}"`);
    } else {
      await ctx.exec(`xdg-open "${url}"`);
    }
    return { url };
  }
};
