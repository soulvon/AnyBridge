# Tauri 2.x 开发踩坑经验

> 项目：AnyBridge | 整理时间：2026-06-06

---

## 一、Rust 跨平台条件编译

### 1.1 `windows-sys` crate 的模块路径陷阱

**问题**：`windows-sys` 0.59 中，`CONTEXT`、`GetThreadContext`、`SetThreadContext` 在 x86_64 架构下**不在** `Win32::System::Diagnostics::Debug` 模块中。

```
error[E0432]: unresolved import `windows_sys::Win32::System::Diagnostics::Debug::CONTEXT`
```

编译器提示 `CONTEXT` 被 `aarch64` feature 或 `Win32_System_Kernel` feature 门控，但实际在 x86_64 上这些 API 根本不在 Debug 模块。

**解决**：用 raw `extern "system"` FFI 直接声明，完全绕开 `windows-sys` 的模块路径混乱：

```rust
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn clear_hardware_breakpoints() {
    #[repr(C)]
    struct X86_64Context {
        p1_home: u64, p2_home: u64, p3_home: u64, p4_home: u64,
        p5_home: u64, p6_home: u64, ctx_flags: u32, mx_csr: u32,
        seg_cs: u16, seg_ds: u16, seg_es: u16, seg_fs: u16,
        seg_gs: u16, seg_ss: u16, e_flags: u32, dr0: u64,
        dr1: u64, dr2: u64, dr3: u64, dr6: u64, dr7: u64,
        // ... 其余字段
    }

    extern "system" {
        fn GetCurrentThread() -> isize;
        fn GetThreadContext(thread: isize, ctx: *mut X86_64Context) -> i32;
        fn SetThreadContext(thread: isize, ctx: *const X86_64Context) -> i32;
    }
    // ...
}
```

**教训**：
- `windows-sys` 的 feature gate 和模块路径在不同版本、不同架构间变化很大
- 对于底层 Win32 API，直接 raw FFI 声明比依赖 crate 重导出更可靠
- `#[repr(C)]` 结构体 + `std::mem::zeroed()` 初始化，不要用 `#[derive(Default)]`（大数组 `[u8; 512]` 不实现 Default）

### 1.2 条件依赖的正确写法

**Cargo.toml**：
```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = [
    "Win32_System_Diagnostics_Debug",
    "Win32_System_Performance",
    "Win32_System_Threading",
    "Win32_System_Kernel",  # ← 必须加这个才能在 x86_64 上用 CONTEXT
]}

[target.'cfg(unix)'.dependencies]
libc = "0.2"
```

### 1.3 条件导入消除 warning

```rust
use std::time::Duration;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::Instant;  // 仅 macOS/Linux 使用
```

### 1.4 dead_code warning 的处理

保护模块（antidebug、integrity）只在 release 模式调用，dev 下会报 dead_code warning：

```rust
// lib.rs
#[allow(dead_code)]
mod antidebug;
#[allow(dead_code)]
mod integrity;
```

---

## 二、Tauri 生产构建样式丢失（CSP 问题）

### 2.1 现象

- `npx tauri dev` 样式正常
- `cargo tauri build` 打包后样式异常/丢失

### 2.2 根因

**Tauri 编译时自动修改 CSP**：

> *"At compile time, Tauri parses all the frontend assets and changes the Content-Security-Policy to only allow loading of your own scripts and styles by injecting nonce and hash sources."*

具体机制：
1. Tauri 在 build 时扫描所有前端资源
2. 给 `<style>` 标签注入 nonce，给 `<script>` 标签注入 hash
3. 将这些 nonce/hash 追加到 CSP 的 `style-src` 和 `script-src`
4. **问题**：注入的 nonce/hash 会覆盖手动设置的 `'unsafe-inline'`，导致 JS 动态生成的 inline style（如 `el.style.display = ...`、`innerHTML` 中的 `style="..."`）被 CSP 阻塞

### 2.3 解决方案

在 `tauri.conf.json` 的 `security` 中添加 `dangerousDisableAssetCspModification`：

```json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "dangerousDisableAssetCspModification": ["style-src"]
    }
  }
}
```

**关键**：只禁用 `style-src` 的自动注入，保留 `script-src` 的 hash 保护。

- `dangerousDisableAssetCspModification` 支持三种值：
  - `true` — 禁用所有 CSP 自动修改
  - `false` — 启用所有（默认）
  - `["style-src"]` — 只禁用指定指令的修改（**推荐**）

### 2.4 安全性评估

CSS 注入攻击的实际危害极低（参考 https://scotthelme.co.uk/can-you-get-pwned-with-css/），禁用 `style-src` 的 nonce 注入而保留 `'unsafe-inline'` 是可接受的权衡。`script-src` 的 hash 保护仍然生效。

---

## 三、Tauri 2.x Windows 生产环境 origin 变化

### 3.1 变化

Tauri 2.x 在 Windows 上：
- **dev 模式**：`https://localhost:1420`（或配置的 dev 端口）
- **生产构建**：`http://tauri.localhost`（注意是 **http**，不是 https）

Tauri 1.x 生产环境使用 `https://tauri.localhost`，升级到 2.x 后改为 `http://`。

### 3.2 影响

- IndexedDB、LocalStorage、Cookies 会因 origin 变化而**重置**
- CSP 中的 `'self'` 会匹配 `http://tauri.localhost`，一般不影响
- 如果需要保持 https，设置 `app > windows > useHttpsScheme: true`

---

## 四、Sidecar 跨平台构建

### 4.1 文件命名规则

Tauri 的 `externalBin` 配置要求 sidecar 二进制文件名包含 target triple：

| 平台 | 文件名 |
|------|--------|
| Windows x86_64 | `anybridge-proxy-x86_64-pc-windows-msvc.exe` |
| macOS x86_64 | `anybridge-proxy-x86_64-apple-darwin` |
| macOS aarch64 | `anybridge-proxy-aarch64-apple-darwin` |
| Linux x86_64 | `anybridge-proxy-x86_64-unknown-linux-gnu` |

**tauri.conf.json** 配置：
```json
"externalBin": ["binaries/anybridge-proxy"]
```
Tauri 自动追加 `-{target_triple}` 后缀和平台扩展名。

### 4.2 pkg 打包的 target 参数

```bash
pkg . --target node18-win-x64    # Windows
pkg . --target node18-mac-x64    # macOS Intel
pkg . --target node18-mac-arm64  # macOS Apple Silicon
pkg . --target node18-linux-x64  # Linux
```

### 4.3 Rust 端 sidecar 文件名解析

```rust
fn sidecar_filename() -> String {
    if cfg!(target_os = "windows") {
        format!("anybridge-proxy-{}-pc-windows-msvc.exe", std::env::consts::ARCH)
    } else if cfg!(target_os = "macos") {
        format!("anybridge-proxy-{}-apple-darwin", std::env::consts::ARCH)
    } else if cfg!(target_os = "linux") {
        format!("anybridge-proxy-{}-unknown-linux-gnu", std::env::consts::ARCH)
    } else {
        panic!("Unsupported platform")
    }
}
```

---

## 五、Tauri 2.x bundle.targets 不支持数组

### 5.1 问题

尝试用数组指定多个打包目标：
```json
"targets": ["msi", "nsis", "app", "appimage", "dmg", "deb", "updater"]
```

报错：`is not valid under any of the schemas listed in the 'anyOf' keyword`

### 5.2 解决

Tauri 2.x 的 `bundle.targets` 只接受字符串：
```json
"targets": "all"
```

如需特定格式，用 CLI 参数覆盖：
```bash
cargo tauri build --bundles nsis
```

---

## 六、javascript-obfuscator 选项名变更

### 6.1 问题

`javascript-obfuscator` CLI 的 `--rotate-string-array` 选项在新版本中改名：

```
error: unknown option '--rotate-string-array'
```

### 6.2 解决

新版本选项名：`--string-array-rotate`（下划线分隔改为连字符分隔）

---

## 七、EXE 被占用导致编译失败

### 7.1 问题

```
error: failed to remove file `target\debug\anybridge.exe`
Caused by: 拒绝访问。 (os error 5)
```

### 7.2 解决

先杀掉旧进程再编译：
```powershell
Get-Process -Name "AnyBridge" -ErrorAction SilentlyContinue | Stop-Process -Force
```

或用 `taskkill`：
```powershell
taskkill /f /im "anybridge.exe"
```

---

## 八、Python 脚本文件清理问题

### 8.1 问题

`shutil.rmtree()` 在 Windows 上经常因文件锁、权限问题失败：
```
FileNotFoundError: [WinError 2] 系统找不到指定的文件。
```

### 8.2 解决

用 PowerShell 的 `Remove-Item` 更可靠：
```python
subprocess.run(["powershell", "-Command", f"Remove-Item -Recurse -Force '{path}'"], check=True)
```

---

## 九、经验总结速查表

| 问题 | 症状 | 解决 |
|------|------|------|
| CSP nonce 覆盖 unsafe-inline | 生产构建样式丢失 | `dangerousDisableAssetCspModification: ["style-src"]` |
| windows-sys 模块路径混乱 | CONTEXT/GetThreadContext 找不到 | raw extern "system" FFI |
| 大数组 derive(Default) | `[u8; 512]` 不实现 Default | `std::mem::zeroed()` |
| dev only 函数 warning | dead_code 警告 | `#[allow(dead_code)] mod xxx` |
| bundle.targets 数组 | schema 验证失败 | 用字符串 `"all"` 或 CLI `--bundles` |
| EXE 占用 | os error 5 | 先 Stop-Process 再编译 |
| shutil.rmtree 失败 | WinError 2 | 用 PowerShell Remove-Item |
| obfuscator 选项改名 | unknown option | `--string-array-rotate` |
| Windows origin 变化 | LocalStorage 重置 | `useHttpsScheme: true` 或接受 http |
| Sidecar configDir 硬编码 Windows | macOS/Linux 配置找不到 | 跨平台 configDir 判断 `process.platform` |
| 云端签名私钥缺失 | 四平台包已生成后签名失败 | 先配置 `TAURI_SIGNING_PRIVATE_KEY` 并早期校验 |
| 矩阵并发创建 Release | 同 tag 多个 draft，资产分散 | 先 `prepare-release`，再传 `releaseId` |
| 公开仓库为空 | `Repository is empty`，无法标记 latest | 初始化只含 README 的 `main` 分支 |
| `latest.json` 缺平台 | 只包含 macOS 或部分平台 | 按实际产物名匹配 `.exe/.msi/.AppImage/.deb` |

---

## 十、跨平台兼容性审查与 GitHub Actions 云端构建（v1.2.0）

> 审查时间：2026-06-07

### 10.1 Sidecar configDir 硬编码 Windows 路径（严重）

**问题**：sidecar 目录下 4 个文件各自有独立的 `configDir()` 函数，全部硬编码了 `AppData/Roaming`：

```javascript
// ❌ 修复前：macOS/Linux 上路径不存在，sidecar 读不到配置
function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  return path.join(os.homedir(), 'AppData', 'Roaming', 'anybridge');
}
```

**影响文件**（含 sidecar-build 副本，共 8 处）：
- `sidecar/rename-models.js`
- `sidecar/provider-pool.js`
- `sidecar/mitm-logger.js`
- `sidecar/load-env.js`
- `sidecar-build/provider-pool.js`
- `sidecar-build/jsc/rename-models.js`
- `sidecar-build/jsc/provider-pool.js`
- `sidecar-build/jsc/mitm-logger.js`
- `sidecar-build/jsc/load-env.js`

**修复**：按平台判断，与 Rust 侧 `dirs::config_dir()` 对齐：

```javascript
// ✅ 修复后：三平台配置目录一致
function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'anybridge');
  if (process.platform === 'linux') return path.join(os.homedir(), '.config', 'anybridge');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'anybridge');
}
```

**路径对照表**（Rust `dirs::config_dir()` + Node.js 修复后）：

| 平台 | 配置目录 |
|------|----------|
| Windows | `%APPDATA%/anybridge`（`~/AppData/Roaming/anybridge`） |
| macOS | `~/Library/Application Support/anybridge` |
| Linux | `~/.config/anybridge` |

> **注意**：`BYOK_CONFIG_DIR` 环境变量是 Tauri 启动 sidecar 时注入的（`cmd.env("BYOK_CONFIG_DIR", ...)`），所以实际上云端构建后 Tauri 端能自动覆盖路径。但 sidecar 独立运行（调试模式）时必须依赖 `configDir()` 的正确判断，所以仍需修复。

### 10.2 Rust 代码跨平台兼容性（已完善 ✅）

审查结果：Rust 代码已通过 `#[cfg(target_os = "...")]` 完整覆盖三大平台：

| 模块 | Windows | macOS | Linux |
|------|---------|-------|-------|
| `system.rs` — 开机自启 | 注册表 `HKCU\...\Run` | launchd plist | `.desktop` autostart |
| `system.rs` — 打开目录 | `explorer` | `open` | `xdg-open` |
| `system.rs` — 探测 IDE | PowerShell + 注册表 | `.app` 路径探测 | `/usr/bin` 等路径 |
| `system.rs` — 重启 IDE | `taskkill` + `spawn` | `killall` + `open -a` | `pkill` + `spawn` |
| `system.rs` — 检测运行 | PowerShell `Get-Process` | `pgrep -x` | `pgrep -x` |
| `proxy.rs` — 进程标志 | `DETACHED_PROCESS` | 无需特殊标志 | 无需特殊标志 |
| `proxy.rs` — 杀孤儿进程 | `taskkill /F /T /IM` | `pkill -f` | `pkill -f` |
| `ide_config.rs` — settings.json 路径 | `dirs::config_dir()` | `dirs::data_dir()` | `dirs::config_dir()` |
| `workbench_inject.rs` — workbench.html | exe 同级 `resources/app` | `.app/Contents/Resources/app` | bin 同级 `resources/app` |
| `antidebug.rs` — 反调试 | `IsDebuggerPresent` + 硬件断点清除 | `sysctl P_TRACED` | `/proc/self/status TracerPid` |
| `integrity.rs` — sidecar 文件名 | `anybridge-proxy.exe` | `anybridge-proxy` | `anybridge-proxy` |
| `update.rs` — 打开下载页 | `cmd /C start` | `open` | `xdg-open` |

### 10.3 GitHub Actions 云端构建

#### 10.3.1 已有 workflow 配置

项目已有 `.github/workflows/release.yml`，支持四平台并行构建：

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - platform: "windows-latest"    # Windows x64
        args: ""
      - platform: "macos-latest"      # macOS Apple Silicon
        args: "--target aarch64-apple-darwin"
      - platform: "macos-latest"      # macOS Intel
        args: "--target x86_64-apple-darwin"
      - platform: "ubuntu-22.04"      # Linux x64
        args: ""
```

#### 10.3.2 构建流程

```
触发 (push tag v* / workflow_dispatch)
  │
  ├─ prepare-release
  │   ├─ 读取 package.json 版本
  │   ├─ 从 CHANGELOG.md 提取当前版本 release notes
  │   └─ 创建唯一 source draft release，输出 releaseId
  │
  ├─ 四平台并行构建（共用 prepare-release 输出的 releaseId）
  │   ├─ Checkout → 安装 Rust/Node → npm install
  │   ├─ Build Sidecar Binary (pkg 按 platform 打包)
  │   │   Windows → node22-win-x64 → anybridge-proxy-x86_64-pc-windows-msvc.exe
  │   │   macOS ARM → node22-macos-arm64 → anybridge-proxy-aarch64-apple-darwin
  │   │   macOS x64 → node22-macos-x64 → anybridge-proxy-x86_64-apple-darwin
  │   │   Linux → node22-linux-x64 → anybridge-proxy-x86_64-unknown-linux-gnu
  │   ├─ chmod +x (非 Windows)
  │   └─ tauri-action 构建 + 上传到同一个 GitHub Release draft
  │
  └─ rebuild-latest-json (单任务，依赖 prepare-release + 四平台构建完成)
      ├─ 下载所有平台产物
      ├─ 合并生成 latest.json（含签名）
      ├─ 上传到公开 Release 仓库 (soulvon/AnyBridge-Release)
      └─ 发布 Release (draft → public)
```

#### 10.3.3 必需的 GitHub Secrets

| Secret | 用途 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 更新包签名私钥（`tauri-sign.key` 文件内容） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 签名私钥密码（如无密码可留空） |
| `RELEASE_REPO_TOKEN` | 有 `contents:write` 权限的 PAT，用于向 AnyBridge-Release 仓库上传 |
| `GITHUB_TOKEN` | 自动提供，用于当前仓库的 Release 操作 |

检查 Secret：

```powershell
gh secret list --repo soulvon/AnyBridge
```

写入本地 updater 私钥：

```powershell
Get-Content -Raw tauri-sign.key | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo soulvon/AnyBridge
```

如果私钥无密码，也要把 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 配成空字符串；非交互环境不应等待人工输入。

#### 10.3.4 Linux 依赖

Ubuntu 22.04 需安装 webkit2gtk 等依赖（workflow 中已配置）：

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
  pkg-config libsoup-3.0-dev javascriptcoregtk-4.1 libjavascriptcoregtk-4.1-dev \
  libnm-dev xdg-utils
```

#### 10.3.5 发布步骤

1. 确认版本号：`package.json` / `tauri.conf.json` / `Cargo.toml` 三处一致
2. 提交代码，打 tag：`git tag v1.2.0 && git push origin v1.2.0`
3. GitHub Actions 自动触发四平台构建
4. 构建完成后 `rebuild-latest-json` 任务合并签名并发布到公开仓库
5. 用户端自动更新拉取 `latest.json` → 下载对应平台安装包

### 10.4 跨平台兼容性 Checklist

- [x] Sidecar `configDir()` 按平台返回正确路径（Windows/macOS/Linux）
- [x] Rust 侧 `dirs::config_dir()` 与 Node.js 侧路径一致
- [x] macOS IDE 探测：`.app` 路径 + `killall` + `open -a`
- [x] Linux IDE 探测：`/usr/bin` 等路径 + `pkill` + 直接 spawn
- [x] Sidecar 二进制权限：非 Windows 平台需 `chmod +x`
- [x] macOS 图标文件 `icon.icns` 已存在
- [x] 进程创建标志：Windows 用 `DETACHED_PROCESS`，其他平台无需
- [x] `port-utils.js` 已有 `process.platform === 'win32'` 分支
- [x] user-agent 仍为 Windows 标识（HTTP 请求中的 UA，不影响功能）
- [x] GitHub Actions workflow 已配置 `prepare-release` + 四平台并行构建 + latest.json 合并

### 10.5 签名打包卡死问题（重要）

**问题**：设置 `TAURI_SIGNING_PRIVATE_KEY` 环境变量后执行 `npm run tauri:build`，打包过程卡住不动，无法完成。

**根因**：Tauri 签名工具在检测到 `TAURI_SIGNING_PRIVATE_KEY` 后，会交互式等待用户输入密码。在 IDE 终端或 CI 非交互环境下，密码提示无法显示也无法输入，导致进程死锁。

**解决**：**必须同时设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量**（即使密钥无密码也要设空字符串）：

```powershell
# ✅ 正确：同时设置密钥和密码（无密码则设空字符串）
$env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText("E:\project\AnyBridge\tauri-sign.key").Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri:build

# ❌ 错误：只设密钥不设密码 → 签名工具交互式等待输入 → 卡死
$env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText("E:\project\AnyBridge\tauri-sign.key").Trim()
npm run tauri:build
```

**产出**：打包成功后会额外生成 `.sig` 签名文件，用于 `latest.json` 的自动更新校验：

```
AnyBridge_1.2.1_x64-setup.exe
AnyBridge_1.2.1_x64-setup.exe.sig    ← 签名文件
AnyBridge_1.2.1_x64_en-US.msi
AnyBridge_1.2.1_x64_en-US.msi.sig   ← 签名文件
```

> **CI/CD 注意**：GitHub Actions 中同样需要设置两个环境变量，否则也会卡死。

### 10.6 v1.2.10 云端发布链路复盘（重要）

> 踩坑时间：2026-06-12

#### 10.6.1 `releaseBodyPath` 不是 `tauri-action@v0` 的有效输入

**症状**：

```text
Unexpected input(s) 'releaseBodyPath'
```

**根因**：当前使用的 `tauri-apps/tauri-action@v0` 输入列表里没有 `releaseBodyPath`。直接传文件路径不会生效。

**解决**：把 release notes 生成放到前置步骤，或由 `prepare-release` job 用 `gh release create --notes-file release-notes.md` 创建 draft release，再把 `releaseId` 传给 `tauri-action`。这样 release 正文和 `latest.json` 都能复用 `CHANGELOG.md` 当前版本段落。

#### 10.6.2 云端缺少 `TAURI_SIGNING_PRIVATE_KEY`

**症状**：四个平台都能编译出安装包，但最后签名失败：

```text
failed to decode secret key: incorrect updater private key password: Missing comment in secret key
```

日志里 `TAURI_SIGNING_PRIVATE_KEY` 为空时，实际根因通常是 Secret 根本没配，而不是密码真的错。

**解决**：

1. 用 `gh secret list --repo soulvon/AnyBridge` 确认 Secret 存在。
2. 用 `Get-Content -Raw tauri-sign.key | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo soulvon/AnyBridge` 写入私钥。
3. 无密码私钥也设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为空字符串。
4. workflow 早期加 `Validate updater signing secret`，缺私钥时立即失败，不要等四个平台编译完才失败。

本地验证空密码是否可用：

```powershell
npx tauri signer sign -f tauri-sign.key -p "" package.json
```

成功后会生成临时 `package.json.sig`，测试后删除即可。

#### 10.6.3 矩阵并发创建 draft release 导致资产分裂

**症状**：四个平台 job 都成功，但私有仓库出现多个同 tag draft release；公开仓库只同步到一部分资产，例如只有 macOS arm64、缺 Windows 或 macOS x64。

**根因**：多个矩阵 job 同时执行 `tauri-action`，都在“找不到 release”时尝试创建同一个 tag 的 draft release。GitHub draft release 在并发场景下可能被分裂成多个 untagged draft，资产被上传到不同 draft。

**解决**：

- 新增 `prepare-release` 单任务，先创建唯一 source draft release。
- 通过 `gh release view --json id` 取出 `releaseId`。
- 四个平台 `tauri-action` 都传同一个 `releaseId`，只负责上传资产。

失败后清理重复 draft：

```powershell
gh api repos/soulvon/AnyBridge/releases --jq '.[] | select(.tag_name=="v1.2.10" and .draft==true) | .id'
gh api -X DELETE repos/soulvon/AnyBridge/releases/RELEASE_ID
```

公开仓库如果已经生成错误 draft，也按同样方式删除后重跑。

#### 10.6.4 公开仓库为空导致无法发布 latest

**症状**：

```text
HTTP 422: Validation Failed
Repository is empty.
```

**根因**：`soulvon/AnyBridge-Release` 作为公开分发仓库，如果完全没有默认分支提交，GitHub API 可以创建 draft release，但无法正常 `--latest` 发布。

**解决**：初始化一个只含 README 的 `main` 分支，不放源码：

```powershell
git init -b main
git config user.name "AnyBridge Release Bot"
git config user.email "release-bot@users.noreply.github.com"
Set-Content -Path README.md -Value "# AnyBridge Release`n`nBinary release assets only. Source code remains private.`n"
git add README.md
git commit -m "Initialize release repository"
git remote add origin https://github.com/soulvon/AnyBridge-Release
git push origin main
```

#### 10.6.5 `latest.json` 只包含 macOS

**症状**：公开 release 资产完整，包含 Windows、macOS、Linux，但下载 `latest.json` 后只看到：

```json
{
  "platforms": {
    "darwin-aarch64": {},
    "darwin-x86_64": {}
  }
}
```

**根因**：`scripts/release/build_merged_latest_json.cjs` 仍按旧 updater 命名匹配 Windows `.zip` 和 Linux `.tar.gz`，但 Tauri v2 当前产物可能是直接的：

```text
AnyBridge_1.2.10_x64-setup.exe
AnyBridge_1.2.10_x64_en-US.msi
AnyBridge_1.2.10_amd64.AppImage
AnyBridge_1.2.10_amd64.deb
```

这些文件各自配套 `.sig`，可以直接进入 updater 清单。

**解决**：更新资产匹配正则，同时兼容旧 `.zip/.tar.gz` 和当前直接产物。修好脚本后可以只重新生成并覆盖上传 `latest.json`，不必重新打包安装包。

线上验收：

```powershell
gh release download v1.2.10 --repo soulvon/AnyBridge-Release --pattern latest.json --dir $env:TEMP --clobber
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.env.TEMP+'\\\\latest.json','utf8')); console.log(Object.keys(j.platforms).sort())"
```

至少应看到 Windows、macOS 双架构、Linux x64 的平台 key。

---

## 十一、Sidecar 重建导致 IDE 代理配置回弹（重要）

> 踩坑时间：2026-06-08

### 11.1 现象

修改 sidecar JS 代码并重建二进制后，IDE（Windsurf / Devin）突然无法使用代理——自带的模型和第三方接入的模型都不可用。代理进程在运行（`http://127.0.0.1:7450/__byok/stats` 正常响应），但 `requests: 0`。

### 11.2 根因

**Sidecar 重建 → 旧进程被杀 → `restore_all` 自动清理 IDE 的代理配置 → IDE 已在运行不会重读 settings.json → 代理虽在跑但 IDE 不走它。**

完整链路：

1. 修改 sidecar JS 代码（如 `handlers/chat.js`、`hybrid-server.js`）
2. 执行 `python scripts/build_sidecar_plain.py` 重建二进制
3. 新二进制覆盖旧文件 → 旧 `anybridge-proxy.exe` 进程被杀
4. Tauri 监控线程检测到进程退出 → 调用 `restore_all()`
5. `restore_all()` 将 IDE 的 `settings.json` 还原（删除 `http.proxy` 和 `http.proxyStrictSSL`）
6. `npx tauri dev` 启动新代理进程 → `start_proxy()` 的 `patch()` 重新写入代理配置
7. **但 IDE 已经在运行**，不会热加载 `settings.json` → 代理配置不生效
8. IDE 直连 Codeium 官方，绕过代理

### 11.3 Devin vs Windsurf 的配置路径区别

| IDE | settings.json 路径 |
|-----|-------------------|
| Windsurf | `%APPDATA%\Windsurf\User\settings.json` |
| Devin | `%APPDATA%\Devin\User\settings.json` |

AnyBridge 的 `target_ide` 配置（保存在 `byok-config.json` 的 `target_ide` 字段）决定代理配置写入哪个文件。如果 `target_ide` 设为 `"devin"`，配置只会写入 Devin 的 settings.json，不会影响 Windsurf。

### 11.4 恢复方法

**方法一：重启 IDE（推荐）**

重建 sidecar 后，重启 IDE 让它重新读取 settings.json（此时代理配置已被 `patch()` 重新写入）。

**方法二：手动写入代理配置**

如果代理配置被清掉且 `patch()` 未重新执行（如 Tauri dev 模式未重启），直接编辑 IDE 的 settings.json：

```json
{
  "http.proxy": "http://localhost:7450",
  "http.proxyStrictSSL": false,
  ...其他配置...
}
```

然后重启 IDE。

**方法三：在 AnyBridge 中重新启动代理**

1. 打开 AnyBridge
2. 确认「目标 IDE」选择正确（Windsurf / Devin / 自动检测）
3. 点击停止代理 → 再启动代理
4. 点击「重启 IDE」按钮

### 11.5 重建 sidecar 的正确流程

```powershell
# 1. 修改 sidecar JS 代码
# 2. 重建二进制
python scripts/build_sidecar_plain.py

# 3. 重启 Tauri dev（会自动启动新代理并 patch IDE 配置）
npx tauri dev

# 4. 重启 IDE（让 settings.json 生效）
#    或在 AnyBridge 中点击「重启 IDE」按钮
```

### 11.6 自动检测逻辑

`detect_target_ide()` 的优先级：

1. 正在运行的 IDE（进程探测）→ Windsurf 和 Devin 都在运行时返回先检测到的
2. settings.json 中有 `http.proxy` 的 IDE
3. 已安装的 IDE（优先 Devin）
4. 默认 `"windsurf"`

当代理配置被清掉后，自动检测会退回到步骤 3，可能切换目标 IDE。
