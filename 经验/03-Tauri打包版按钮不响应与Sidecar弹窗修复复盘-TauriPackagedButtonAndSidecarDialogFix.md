## Tauri 打包版按钮不响应 + Sidecar CMD 窗口弹出修复复盘

调查时间：2026-06-05

---

### 一、背景

AnyBridge（Tauri v2 桌面应用）在 `tauri dev` 开发模式下一切正常，但 `cargo build --release` 或 `npx tauri build` 打包后，多个按钮点击无反应，且启动代理时会弹出 CMD 命令行窗口。

---

### 二、问题一：打包版按钮不响应

#### 2.1 根因（四层叠加）

| 层级 | 问题 | 影响 |
|------|------|------|
| **CSP 哈希吞噬 unsafe-inline（核心根因）** | Tauri v2 打包时自动为 HTML 中所有 `<script>` 标签计算 SHA-256 哈希并注入 CSP；一旦 CSP 包含哈希值，浏览器按规范**直接忽略 `'unsafe-inline'`** | `onclick="..."` 等内联事件处理器没有对应哈希，被 CSP 全部拦截，按钮点击无任何反应 |
| **Tauri Bridge 初始化时序** | `window.__TAURI__` 在打包版中可能晚于 `<script>` 执行才注入，`const invoke = window.__TAURI__?.core?.invoke` 拿到 `null` | 所有 `invoke()` 调用静默失败 |
| **`onclick` 内联事件不可靠** | 打包版 CSP 或 bridge 时序导致 `onclick="toggleProxy()"` 等内联处理器不触发 | 按钮点击无任何反应 |
| **Drag Region 吞点击** | `.topbar` 有 `data-tauri-drag-region` + `-webkit-app-region: drag`，子元素未显式标记 `no-drag` 时点击被 drag 吞掉 | topbar 内的按钮（窗口控制、主题切换等）点不动 |

#### 2.2 修复方案

**⓪ CSP 哈希问题（核心修复 — 2026-06-06 补充）**

Tauri v2 打包时自动对 `<script>` 标签做 SHA-256 哈希注入 CSP，导致浏览器忽略 `'unsafe-inline'`，所有 `onclick` 等内联事件处理器全部被拦截。

**原理**：CSP 规范规定，当 `script-src` 中出现哈希值时，`'unsafe-inline'` 自动失效。`<script>` 标签本身有哈希所以能跑，但 `onclick="..."` 属性不是 `<script>` 标签，没有哈希，因此被拦截。

```json
// tauri.conf.json — 修复前
"dangerousDisableAssetCspModification": ["style-src"]

// tauri.conf.json — 修复后：加入 "script-src" 阻止 Tauri 注入哈希
"dangerousDisableAssetCspModification": ["script-src", "style-src"]
```

> `dangerousDisableAssetCspModification` 告诉 Tauri 不要对指定 CSP 指令做自动哈希/nonce 注入，让开发者自行控制的 `'unsafe-inline'` 真正生效。

**① Bridge 重试机制**

```javascript
// 旧：一次性绑定，bridge 未就绪则永久 null
const invoke = window.__TAURI__?.core?.invoke;

// 新：let + 重试
let invoke = null;
function bindTauriBridge() {
  const TAURI = window.__TAURI__ || null;
  invoke = TAURI?.core?.invoke || null;
  return !!invoke;
}
async function ensureTauriBridge(maxWaitMs = 3000) {
  if (bindTauriBridge()) return true;
  let waited = 0;
  while (waited < maxWaitMs) {
    await new Promise(r => setTimeout(r, 100));
    waited += 100;
    if (bindTauriBridge()) return true;
  }
  return false;
}
```

**② 关键按钮用 `addEventListener` 替代 `onclick`**

```javascript
// 旧：依赖内联 onclick
<button onclick="toggleProxy()">

// 新：显式绑定
function bindProxyButtonHandlers() {
  const btn = document.getElementById('proxyBtn');
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleProxy().catch(err => addLog('err', '代理操作异常: ' + err));
  };
  btn.addEventListener('click', handler);
  btn.addEventListener('pointerup', handler);
}
```

对窗口控制按钮（最小化/最大化/关闭）同理，新增 `bindWindowControlHandlers()`。

**③ Drag Region 内元素显式标记 `no-drag`**

```css
/* 旧：只覆盖了 button 和 tab-nav */
.topbar button, .topbar .tab-nav, .topbar .status-pill {
  -webkit-app-region: no-drag;
}

/* 新：扩展到 win-controls 及其子元素 */
.topbar button, .topbar .tab-nav, .topbar .status-pill,
.topbar .win-controls, .topbar .win-btn, .topbar .win-btn svg {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
```

**④ 启动时清理残留弹层**

```javascript
// init() 中：清理上次退出时残留的 .modal-overlay.active
document.querySelectorAll('.modal-overlay.active')
  .forEach(el => el.classList.remove('active'));
```

#### 2.3 经验 Checklist

- [x] Tauri 打包版必须用 `ensureTauriBridge()` 等待 bridge 就绪，不能一次性 `const`
- [x] 关键按钮（涉及 invoke/appWindow）必须用 `addEventListener` 绑定，不依赖 `onclick`
- [x] 无边框窗口（`decorations: false`）的 drag region 内所有可交互元素必须显式 `no-drag`
- [x] `no-drag` 要覆盖到 SVG 等子元素，否则点击 SVG 区域仍被吞
- [x] 启动时清理残留 `.modal-overlay.active`，避免透明遮罩挡住所有点击

---

### 三、问题二：Sidecar 启动弹出 CMD 窗口

#### 3.1 根因

`anybridge-proxy` 是用 `@yao-pkg/pkg` 打包的 Node.js 二进制，属于 **Windows Console Subsystem**。即使 `tauri_plugin_shell` 已设置 `CREATE_NO_WINDOW (0x08000000)`，这个标志只能阻止"为没有控制台的进程创建新窗口"——对于 Console Subsystem 的二进制，Windows 会在进程启动时**自动分配控制台**，`CREATE_NO_WINDOW` 无法阻止。

| 标志 | 作用 | 对 Console Subsystem 二进制有效？ |
|------|------|------|
| `CREATE_NO_WINDOW` (0x08000000) | 不为新进程创建控制台窗口 | ❌ 只在进程本身无控制台时有效 |
| `DETACHED_PROCESS` (0x00000008) | 子进程不继承父进程控制台，也不创建新控制台 | ✅ 对 Console Subsystem 也有效 |

#### 3.2 修复方案

**改用 `std::process::Command` + `DETACHED_PROCESS`**

```rust
use std::os::windows::process::CommandExt;

const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

let mut cmd = std::process::Command::new(&sidecar_path);
cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
```

不再使用 `tauri_plugin_shell` 的 `app.shell().sidecar()`，改为手动解析 sidecar 路径 + `std::process::Command` 启动，同时手动处理 stdout/stderr 管道转发和进程退出监控。

#### 3.3 Sidecar 路径解析踩坑

**错误写法**：手动拼接 target triple 后缀
```rust
// ❌ 打包后实际文件名不含 target triple
let sidecar_file = format!("anybridge-proxy-{}.exe", target_triple);
```

**正确写法**：Tauri 构建脚本会自动将 `binaries/anybridge-proxy-x86_64-pc-windows-msvc.exe` 重命名为 `anybridge-proxy.exe` 放在 exe 旁边
```rust
// ✅ 与 tauri_plugin_shell 的 relative_command_path 逻辑一致
let sidecar_file = "anybridge-proxy.exe";  // Windows
```

路径解析逻辑：基于 `current_exe` 的父目录查找，与 `tauri_plugin_shell` 源码中的 `relative_command_path()` 完全一致。

#### 3.4 经验 Checklist

- [x] Windows 上 Console Subsystem 的二进制必须用 `DETACHED_PROCESS` 而非仅 `CREATE_NO_WINDOW`
- [x] `tauri_plugin_shell` 的 sidecar 路径不含 target triple 后缀（构建脚本已重命名）
- [x] 手动解析 sidecar 路径时，基于 `current_exe` 父目录而非 `resource_dir`
- [x] 自行管理子进程时需要手动处理 stdout/stderr 管道和退出监控
- [x] `ManagedChild` 内部用 `Mutex<Child>` 避免多线程竞争
- [x] **升级安装时 “Error opening file for writing: anybridge-proxy.exe”**：旧的 sidecar 进程仍在跑，锁住了文件。必须在 App 退出和启动时主动杀进程（见 3.5）

#### 3.5 升级安装文件锁问题（2026-06-06 补充）

**现象**：重新安装时弹出 “Error opening file for writing: anybridge-proxy.exe”，中止/重试/忽略三个按钮。

**根因**：旧版 App 退出时没有杀 sidecar 进程（`RunEvent::ExitRequested` 里只还原了 IDE 配置，未清理子进程），导致 `anybridge-proxy.exe` 被进程占用，安装程序无法覆盖。

**修复**：

```rust
// lib.rs - .setup() 启动时先清理孤儿进程
commands::proxy::kill_sidecar_process();

// lib.rs - RunEvent::ExitRequested 先杀 sidecar 再还原配置
if let Some(state) = app.try_state::<ProxyState>() {
    let child = commands::proxy::lock_or_recover(&state.child).take();
    if let Some(c) = child {
        let _ = c.kill();
    }
}
commands::proxy::kill_sidecar_process(); // 双保险：按进程名全盘清理
```

```rust
// proxy.rs - 独立的全盘清理函数（不依赖 ProxyState）
pub fn kill_sidecar_process() {
    // Windows: taskkill /F /T /IM anybridge-proxy.exe
    // macOS/Linux: pkill -f anybridge-proxy
}
```

---

### 四、通用经验

| 场景 | 教训 |
|------|------|
| **打包后所有 onclick 按钮失效（最常见）** | **Tauri 打包时会给 `<script>` 注入哈希，导致 `'unsafe-inline'` 被浏览器忽略。解决：在 `dangerousDisableAssetCspModification` 中加入 `"script-src"`** |
| Tauri 打包版 vs dev 模式行为不一致 | 打包版 bridge 初始化时序不同，必须做重试 |
| 无边框窗口按钮不响应 | 优先检查 drag region 是否吞掉了点击事件；其次检查 CSP 哈希问题 |
| Sidecar 弹出 CMD 窗口 | `pkg` 打包的 Node.js 二进制是 Console Subsystem，必须 `DETACHED_PROCESS` |
| Sidecar 路径找不到 | 不要手动拼 target triple，Tauri 构建脚本已重命名 |
| **升级安装时 “文件被占用”** | **App 退出时未杀 sidecar，在 `ExitRequested` + `.setup()` 里补上 `kill_sidecar_process()`** |
| 版本号没变 | 确认运行的是新构建的产物，不是旧 exe |

---

### 五、CSP 哈希问题速查

```
现象：dev 正常，打包后 onclick / onchange / onsubmit 全部不响应
诊断：打包版按 F12 或远程调试，控制台出现：
  "Refused to execute inline event handler because it violates the following
   Content Security Policy directive: 'script-src ...'"
原因：Tauri 构建时自动对 <script> 标签做 SHA-256 哈希注入 CSP，
      一旦 CSP 包含哈希，浏览器按规范忽略 'unsafe-inline'
修复：tauri.conf.json → dangerousDisableAssetCspModification 加入 "script-src"
替代方案（更安全）：将所有 onclick 改为 addEventListener 绑定
```
