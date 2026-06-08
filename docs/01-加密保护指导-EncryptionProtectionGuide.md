# IDE BYOK 加密保护指导

> 基于 WindsurfGate / Infinity / 星火 / 八戒 / 游侠 / Infinite-WF 六个同类产品的逆向分析经验，从攻击者视角制定针对性方案。

---

## 一、当前项目安全现状评估

### 1.1 架构分析

```
IDE BYOK = Tauri 2.x (Rust 壳) + Node.js Sidecar (pkg 打包 EXE) + 前端 UI (单文件 HTML)

┌─────────────────────────────────────────────────┐
│  Tauri EXE (Rust 编译)                          │
│  ├─ src-tauri/src/commands/ (9个Rust模块)        │
│  │   ├─ config.rs       — 配置读写              │
│  │   ├─ proxy.rs        — Sidecar 生命周期管理    │
│  │   ├─ system.rs       — 系统操作/证书/自启      │
│  │   ├─ ide_config.rs   — IDE 配置 patch         │
│  │   ├─ ide_models.rs   — 模型列表管理           │
│  │   ├─ model_map.rs    — 模型映射               │
│  │   ├─ workbench_inject.rs — workbench.html注入 │
│  │   ├─ update.rs       — 自动更新               │
│  │   └─ mod.rs          — 原子写入工具            │
│  ├─ ui/index.html (244KB 单文件)                 │
│  └─ sidecar: ide-byok-proxy.exe (pkg Node.js)   │
│       ├─ hybrid-server.js   — MITM 代理核心      │
│       ├─ handlers/chat.js   — 聊天拦截/转发      │
│       ├─ rename-models.js   — 模型解锁           │
│       └─ ... (共 ~15 个 JS 文件)                 │
└─────────────────────────────────────────────────┘
```

### 1.2 脆弱点清单

| # | 脆弱点 | 严重度 | 说明 |
|---|--------|--------|------|
| 1 | **Sidecar 是 pkg 打包的 Node.js** | 🔴 高 | pkg 可被解包还原出全部 JS 源码（`npx pkg-fetch` + 解压 V8 snapshot） |
| 2 | **前端 UI 是明文 HTML** | 🔴 高 | `ui/index.html` 244KB 单文件，Tauri 打包后仍可从安装目录直接读取 |
| 3 | **无反调试** | 🔴 高 | Frida/x64dbg 可随意 attach，设断点分析所有 IPC 命令 |
| 4 | **无代码完整性校验** | 🟠 中 | Rust 二进制可被直接 patch（Infinity 就是这么破的） |
| 5 | **配置明文存储** | 🟠 中 | `%APPDATA%\ide-byok\byok-config.json` 和 `providers.json` 明文可读 |
| 6 | **API Key 明文存储** | 🔴 高 | providers.json 中用户的 Anthropic/OpenAI Key 完全暴露 |
| 7 | **Sidecar 端口固定** | 🟡 低 | 默认 7450/7451，可被其他程序探测/占用 |
| 8 | **无反逆向工具检测** | 🟡 低 | 攻击者可同时运行 IDA/Ghidra/Fiddler 无人阻止 |

### 1.3 与同类产品对比

| 保护措施 | WindsurfGate (未破) | Infinity (已破) | **IDE BYOK (当前)** |
|----------|-------------------|----------------|-------------------|
| Rust 后端 | ✅ | ✅ | ✅ |
| 反调试 | ✅ 7种方法 | ❌ | ❌ |
| 代码完整性 | ✅ 代码段校验 | ❌ | ❌ |
| 会话加密 | ✅ AES-256-GCM | ✅ AES-CBC | ❌ 明文 JSON |
| 前端保护 | ✅ 嵌入二进制(压缩) | ❌ | ❌ 明文 HTML |
| Sidecar 保护 | N/A | N/A | ❌ pkg 可解包 |

**结论**: 当前保护水平 ≈ Infinity（被破），远低于 WindsurfGate（未破）。

---

## 二、加密保护方案（按优先级排序）

### 🥇 优先级 1：Sidecar 保护（最关键）

Sidecar 是整个应用的核心——MITM 代理逻辑、gRPC 解析、模型解锁全在里面。pkg 打包的 Node.js 是最大的安全黑洞。

#### 方案 1A：将 Sidecar 逻辑迁移到 Rust（推荐）

**原理**: 把 `hybrid-server.js` / `handlers/chat.js` / `rename-models.js` 等核心逻辑用 Rust 重写，编译为原生代码。

```
当前:  Tauri → spawn sidecar.exe (pkg Node.js, 可解包)
目标:  Tauri → 内置 Rust HTTP 代理 (编译后不可还原源码)
```

**迁移路线**:

| Sidecar 模块 | Rust 替代 | 难度 |
|-------------|----------|------|
| hybrid-server.js (HTTP 代理) | hyper + tokio | 中 |
| handlers/chat.js (gRPC 解析) | prost/tonic 或手动解析 | 中高 |
| connect.js (CONNECT 隧道) | tokio TcpStream | 低 |
| rename-models.js (模型解锁) | serde_json 操作 | 低 |
| proto.js (protobuf 编解码) | prost | 中 |
| stats.js (统计) | 原子计数器 | 低 |
| mitm-logger.js (日志) | tracing | 低 |
| port-utils.js (端口) | tokio net | 低 |

**收益**: 
- 消除 pkg 解包风险（最大安全提升）
- 代理性能提升（Rust 异步 vs Node.js 单线程）
- 减少一个独立进程，简化部署

**代价**: 开发量较大，约 2-3 周

#### 方案 1B：Sidecar 加固（快速方案）

如果短期内无法迁移到 Rust，至少做以下加固：

**1B-1. pkg 打包时启用 V8 bytecode**

```bash
# pkg 的 --options=v8-vm 启用 V8 snapshot 编译
npx pkg proxy-entry.js \
  --targets node22-win-x64 \
  --options=v8-vm \
  --output ide-byok-proxy.exe
```

> ⚠️ **注意**: pkg 的 V8 snapshot 不是真正的 bytecode 编译，仍可被 `v8-to-istanbul` 等工具部分还原。只能增加难度，不能根本解决。

**1B-2. JS 源码混淆**

对 sidecar 的 JS 文件在 pkg 打包前做混淆：

```bash
# 使用 javascript-obfuscator
npx javascript-obfuscator sidecar/ \
  --output sidecar-obf/ \
  --compact true \
  --control-flow-flattening true \
  --dead-code-injection true \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.75
```

> ⚠️ **注意**: 6/6 参考项目的 JS 混淆全被 AST 解混淆。这只是增加时间成本。

**1B-3. Sidecar 完整性校验**

在 Rust 侧启动 sidecar 前验证 EXE 哈希：

```rust
// src-tauri/src/commands/proxy.rs 中添加
fn verify_sidecar_integrity(exe_path: &Path) -> Result<(), String> {
    let expected_hash = include_str!("../../binaries/sidecar.sha256").trim();
    let data = std::fs::read(exe_path).map_err(|e| e.to_string())?;
    let hash = sha256(&data);
    if hash != expected_hash {
        return Err("Sidecar integrity check failed".into());
    }
    Ok(())
}
```

打包时生成哈希：
```bash
sha256sum src-tauri/binaries/ide-byok-proxy-x86_64-pc-windows-msvc.exe \
  > src-tauri/binaries/sidecar.sha256
```

---

### 🥈 优先级 2：前端 UI 保护

当前 `ui/index.html` 是 244KB 的单文件明文 HTML，安装后任何人可直接打开阅读。

#### 方案 2A：前端资源加密嵌入（推荐）

Tauri 2.x 支持将前端资源编译进二进制，默认就是嵌入的。但嵌入后仍可从安装目录的 `resources/` 读取。

**加固方法**: 自定义资源加载，运行时解密。

```rust
// 1. 构建时加密前端资源
// build.rs
fn main() {
    // 读取 ui/index.html
    // AES-256-GCM 加密
    // 写入 ui/index.html.enc
    // tauri-build 正常打包 .enc 文件
}

// 2. 运行时解密
// 在 Tauri setup 中拦截资源请求，解密后返回
// 使用 tauri::protocol::tauri 的 custom_protocol
```

**更简单的替代方案**: 将 HTML 拆分为多文件 + JS 混淆 + 压缩。

#### 方案 2B：前端 JS 混淆

```bash
# 对 ui/ 目录中的 JS 做混淆
# 如果 index.html 内嵌了 JS，先提取再混淆
npx javascript-obfuscator ui/index.html \
  --output ui/index.html \
  --compact true \
  --string-array true \
  --string-array-encoding rc4
```

> ⚠️ 同上，JS 混淆只是时间成本，不是安全措施。

#### 方案 2C：前端重构为编译型框架（中期方案）

将单文件 HTML 重构为 Vue/React + Vite 项目：
- Vite 构建后输出 minified + tree-shaken 的 JS
- 配合 Tauri 的 CSP 限制，增加分析难度
- 可以用 `vite-plugin-obfuscator` 在构建时混淆

---

### 🥉 优先级 3：Rust 二进制保护

Tauri 的 Rust 部分编译后是原生代码，天然比 JS 安全。但仍需防止 binary patch（Infinity 被破的方式）。

#### 方案 3A：反调试巡逻（参考 WindsurfGate）

```rust
// src-tauri/src/antidebug.rs — 新增模块

use std::thread;
use std::time::Duration;

#[cfg(target_os = "windows")]
mod win_antidebug {
    /// 方法 1: IsDebuggerPresent
    pub fn check_debugger_present() -> bool {
        #[link(name = "kernel32")]
        extern "system" {
            fn IsDebuggerPresent() -> i32;
        }
        unsafe { IsDebuggerPresent() != 0 }
    }

    /// 方法 2: 时间差检测 (RDTSC)
    pub fn check_timing() -> bool {
        static mut TSC_BASE: u64 = 0;
        let tsc = unsafe { core::arch::x86_64::_rdtsc() };
        if TSC_BASE == 0 {
            unsafe { TSC_BASE = tsc };
            return false;
        }
        let delta = tsc - TSC_BASE;
        unsafe { TSC_BASE = tsc };
        // 单步执行会让 delta 异常大
        delta > 10_000_000 // ~3ms @ 3GHz，调试时远超此值
    }

    /// 方法 3: NtQueryInformationProcess (DebugPort = 7)
    pub fn check_debug_port() -> bool {
        #[link(name = "ntdll")]
        extern "system" {
            fn NtQueryInformationProcess(
                process_handle: isize,
                process_information_class: i32,
                process_information: *mut u8,
                process_information_length: u32,
                return_length: *mut u32,
            ) -> i32;
        }
        let mut debug_port: u64 = 0;
        let status = unsafe {
            NtQueryInformationProcess(
                -1isize, // GetCurrentProcess()
                7,       // ProcessDebugPort
                &mut debug_port as *mut u64 as *mut u8,
                8,
                std::ptr::null_mut(),
            )
        };
        status >= 0 && debug_port != 0
    }
}

pub fn start_patrol() {
    thread::spawn(|| loop {
        #[cfg(target_os = "windows")]
        {
            if win_antidebug::check_debugger_present()
                || win_antidebug::check_timing()
                || win_antidebug::check_debug_port()
            {
                // 不要用 std::process::exit — 太明显
                // 用更隐蔽的方式：让程序自然崩溃或进入无效状态
                std::process::exit(0xDEAD_BEEF as i32);
            }
        }
        thread::sleep(Duration::from_secs(5));
    });
}
```

**集成到 main.rs**:

```rust
// src-tauri/src/lib.rs — 在 tauri::Builder::setup 中启动
.setup(|app| {
    // 反调试巡逻 (最先启动)
    antidebug::start_patrol();

    // 完整性校验
    integrity::start_patrol();

    // 原有逻辑
    commands::system::build_tray(app.handle())?;
    Ok(())
})
```

#### 方案 3B：代码完整性校验（防 binary patch）

```rust
// src-tauri/src/integrity.rs — 新增模块

use sha2::{Sha256, Digest};
use std::thread;
use std::time::Duration;

/// 计算自身 EXE 的 .text 段哈希
#[cfg(target_os = "windows")]
fn compute_text_section_hash() -> Option<[u8; 32]> {
    // 1. GetModuleHandle(NULL) → 拿到自身基址
    // 2. 解析 PE 头 → 找到 .text 段的 RVA 和 Size
    // 3. SHA256(.text 段内容)
    // 注意: Rust 的 panic/unwind 表也在 .text 中，可能随编译变化
    // 建议只校验关键函数区域而非整个 .text

    // 简化实现: 校验整个 EXE 文件 (排除 PE timestamp 和 checksum)
    let exe_path = std::env::current_exe().ok()?;
    let data = std::fs::read(&exe_path).ok()?;

    // 跳过 PE 头中的 CheckSum 字段 (offset 0x58, 4 bytes)
    // 和 TimeDateStamp (offset 0x88, 4 bytes)
    let mut hasher = Sha256::new();
    if data.len() > 0x90 {
        hasher.update(&data[..0x58]);
        hasher.update(&data[0x5C..0x88]);
        hasher.update(&data[0x8C..]);
    } else {
        hasher.update(&data);
    }

    let result = hasher.finalize();
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&result);
    Some(hash)
}

/// 启动时计算基线，运行时定期校验
pub fn start_patrol() {
    let baseline = match compute_text_section_hash() {
        Some(h) => h,
        None => return, // 计算失败则跳过（开发模式等）
    };

    thread::spawn(move || loop {
        if let Some(current) = compute_text_section_hash() {
            if current != baseline {
                // 二进制被篡改 (Frida inline hook / 手动 patch)
                std::process::exit(0xCAFE_BABE as i32);
            }
        }
        thread::sleep(Duration::from_secs(30));
    });
}
```

#### 方案 3C：反逆向工具检测

```rust
// src-tauri/src/antidebug.rs 中添加

/// 检测常见逆向工具进程
#[cfg(target_os = "windows")]
fn scan_blacklisted_processes() -> bool {
    let blacklist = [
        "x64dbg", "x32dbg", "ollydbg", "ida", "ida64",
        "ghidra", "dnspy", "cheatengine", "fiddler",
        "wireshark", "httpdebugger", "processhacker",
        "pestudio", "scylla", "die",
    ];

    // 使用 Windows API EnumProcesses 或 tasklist
    let output = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();

    if let Ok(out) = output {
        let stdout = String::from_utf8_lossy(&out.stdout).to_lowercase();
        for name in &blacklist {
            if stdout.contains(name) {
                return true; // 检测到逆向工具
            }
        }
    }
    false
}
```

---

### 🏅 优先级 4：敏感数据保护

#### 方案 4A：配置文件加密

当前 `byok-config.json` 和 `providers.json` 是明文存储，用户的 API Key 完全暴露。

```rust
// src-tauri/src/commands/config.rs 中添加加密层

use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_gcm::aead::Aead;

/// 从设备指纹派生加密密钥 (不硬编码!)
fn derive_encryption_key() -> [u8; 32] {
    // 使用 Windows MachineGuid + 应用标识派生
    let machine_guid = read_machine_guid(); // 注册表读取
    let app_id = "com.idebyok.desktop";

    // HKDF-SHA256 派生
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(b"ide-byok-config-v1").unwrap();
    mac.update(machine_guid.as_bytes());
    mac.update(app_id.as_bytes());
    let result = mac.finalize().into_bytes();

    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

/// 加密保存配置
pub fn save_config_encrypted(data: &str) -> Result<(), String> {
    let key = derive_encryption_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(b"unique-nonce-12"); // 实际应随机生成并存储

    let ciphertext = cipher.encrypt(nonce, data.as_bytes())
        .map_err(|e| e.to_string())?;

    let path = config_path().with_extension("enc");
    std::fs::write(&path, ciphertext).map_err(|e| e.to_string())
}

/// 解密读取配置
pub fn load_config_encrypted() -> Result<String, String> {
    let key = derive_encryption_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;

    let path = config_path().with_extension("enc");
    let ciphertext = std::fs::read(&path).map_err(|e| e.to_string())?;

    let plaintext = cipher.decrypt(Nonce::from_slice(b"unique-nonce-12"), &ciphertext)
        .map_err(|e| e.to_string())?;

    String::from_utf8(plaintext).map_err(|e| e.to_string())
}
```

**Cargo.toml 新增依赖**:
```toml
[dependencies]
aes-gcm = "0.10"
hmac = "0.12"
sha2 = "0.10"
```

#### 方案 4B：API Key 内存保护

```rust
// 在 Rust 侧管理 API Key，不传给前端明文
// 前端只显示 Key 的掩码版本 (sk-****...****)

#[tauri::command]
pub fn mask_api_key(key: &str) -> String {
    if key.len() <= 8 {
        return "*".repeat(key.len());
    }
    format!("{}****{}", &key[..4], &key[key.len()-4..])
}
```

---

### 🎖️ 优先级 5：传输层保护

#### 方案 5A：Tauri IPC 命令保护

当前 30+ 个 IPC 命令全部暴露给前端，攻击者可通过 WebView DevTools 直接调用。

```rust
// 在每个敏感命令中添加调用者验证
#[tauri::command]
pub fn save_providers(providers: String) -> Result<(), String> {
    // 验证调用来源 (防止外部 WebView 注入)
    // Tauri 2.x 的 command 已有 CSP 保护，但可额外加一层
    verify_caller()?;

    // ... 原有逻辑
}

fn verify_caller() -> Result<(), String> {
    // 检查是否在预期的时间窗口内调用
    // 或检查调用栈深度 (DevTools 调用 vs 正常 UI 交互)
    Ok(())
}
```

#### 方案 5B：Sidecar 通信加密

Tauri ↔ Sidecar 目前通过 stdout/stdin 通信。可加密通信内容：

```rust
// proxy.rs 中启动 sidecar 时注入共享密钥
let shared_secret = generate_random_secret();
std::env::set_var("BYOK_IPC_SECRET", &shared_secret);

// sidecar 侧验证:
// if (process.env.BYOK_IPC_SECRET !== expected) process.exit(1);
```

---

## 三、实施路线图

### Phase 1: 快速加固 (3-5 天)

| 步骤 | 工作量 | 效果 |
|------|--------|------|
| 1. 添加 `antidebug.rs` 模块 | 2h | 阻止 Frida/x64dbg 动态分析 |
| 2. 添加 `integrity.rs` 模块 | 3h | 阻止 binary patch |
| 3. Sidecar 完整性校验 | 1h | 防止 sidecar 被替换 |
| 4. 配置文件 AES-256-GCM 加密 | 4h | 保护 API Key 不泄露 |
| 5. 反逆向工具检测 | 1h | 检测 IDA/Ghidra 等 |
| 6. Cargo.toml 新增依赖 | 0.5h | aes-gcm, hmac, sha2 |

**Phase 1 后保护水平**: 从 ⭐⭐ (Infinity级) → ⭐⭐⭐⭐ (接近 WindsurfGate级)

### Phase 2: Sidecar 迁移 (2-3 周)

| 步骤 | 工作量 | 说明 |
|------|--------|------|
| 1. Rust HTTP 代理框架 | 3天 | hyper + tokio 实现 CONNECT 隧道 |
| 2. gRPC 解析迁移 | 5天 | prost 或手动解析 protobuf |
| 3. 模型解锁逻辑迁移 | 2天 | serde_json 操作 |
| 4. 统计/日志迁移 | 1天 | 原子计数器 + tracing |
| 5. MITM 证书管理 | 2天 | rcgen (已有依赖) |
| 6. 集成测试 | 3天 | 全功能验证 |

**Phase 2 后保护水平**: ⭐⭐⭐⭐⭐ (WindsurfGate级，核心逻辑全在 Rust)

### Phase 3: 深度加固 (1 周)

| 步骤 | 工作量 | 说明 |
|------|--------|------|
| 1. 前端重构为 Vite 项目 | 3天 | 拆分单文件 HTML → 组件化 |
| 2. 前端资源加密嵌入 | 1天 | 运行时解密 |
| 3. Sidecar 通信加密 | 1天 | 共享密钥 + HMAC |
| 4. API Key 内存掩码 | 0.5天 | 前端不显示完整 Key |
| 5. 虚拟机检测 (可选) | 1天 | 拒绝在 VM 中运行 |

---

## 四、Cargo.toml 完整依赖（Phase 1 后）

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-shell = "2"
tauri-plugin-updater = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
flate2 = "1"
dirs = "5"
rcgen = "0.13"
json5 = "0.4"
regex = "1"

# 新增: 加密保护
sha2 = "0.10"          # SHA256 (完整性校验)
aes-gcm = "0.10"       # AES-256-GCM (配置加密)
hmac = "0.12"          # HMAC (密钥派生)
hex = "0.4"            # hex 编解码
rand = "0.8"           # 随机数 (nonce 生成)

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = [
    "Win32_System_Diagnostics_Debug",
    "Win32_System_Threading",
    "Win32_Foundation",
] }
winreg = "0.52"        # 注册表读取 (MachineGuid)
```

---

## 五、新增文件结构

```
src-tauri/src/
├── main.rs              (不变)
├── lib.rs               (添加 antidebug/integrity 启动)
├── antidebug.rs         (新增 — 反调试巡逻)
├── integrity.rs         (新增 — 代码完整性校验)
├── crypto.rs            (新增 — 配置加密/解密工具)
└── commands/
    ├── mod.rs           (不变)
    ├── config.rs        (改造 — 加密存储)
    ├── proxy.rs         (改造 — sidecar 完整性校验)
    ├── system.rs        (不变)
    ├── ide_config.rs    (不变)
    ├── ide_models.rs    (不变)
    ├── model_map.rs     (不变)
    ├── workbench_inject.rs (不变)
    └── update.rs        (不变)
```

---

## 六、注意事项

### 6.1 反调试的副作用

- **开发阶段**: Debug build 不应启用反调试（用 `#[cfg(not(debug_assertions))]` 条件编译）
- **安全软件**: 360/火绒可能误报反调试行为为恶意软件，建议加白名单提示
- **合法调试**: 用户自己用 VS Code 调试时会被误杀，需要提供一个 `--disable-protection` 启动参数（仅在验证了某种条件后才生效）

### 6.2 完整性校验的局限

- Rust 编译每次产出不同的二进制（地址布局随机化、编译时间戳等）
- 需要在 **build 后** 计算 baseline hash，不能在编译时硬编码
- 建议: 在 CI/CD 的 release workflow 中自动生成 hash 文件

### 6.3 配置加密的密钥管理

- 密钥从设备指纹派生 → 换电脑后配置无法解密（这是预期行为）
- 需要提供"导出配置"功能（导出时明文，导入时重新加密）
- 重装系统后 MachineGuid 会变 → 配置丢失 → 需要提示用户备份

### 6.4 不做的事

- ❌ **不混淆 Rust 代码** — 编译后本身就是机器码，不需要
- ❌ **不做 VM 检测** — 你的用户可能在 VM 里正常使用，检测会误伤
- ❌ **不做自毁/删文件** — 过度防护会变成恶意软件特征
- ❌ **不做网络校验** — 当前阶段不加卡密，纯本地保护

---

## 七、效果预期

| 攻击方式 | 当前防护 | Phase 1 后 | Phase 2 后 |
|----------|---------|-----------|-----------|
| pkg 解包读 Sidecar 源码 | ❌ 轻松 | ⚠️ 仍可 | ✅ 不存在 |
| Frida attach 分析 IPC | ❌ 轻松 | ✅ 被检测退出 | ✅ 被检测退出 |
| Binary patch 跳过检查 | ❌ 轻松 | ✅ 完整性校验 | ✅ 完整性校验 |
| 替换 sidecar.exe | ❌ 轻松 | ✅ 哈希校验 | ✅ 不存在 |
| 读配置文件拿 API Key | ❌ 轻松 | ✅ AES 加密 | ✅ AES 加密 |
| IDA 静态分析 Rust | ⚠️ 可做 | ⚠️ 可做 | ⚠️ 可做 |
| 读 HTML 前端代码 | ❌ 轻松 | ❌ 仍可 | ⚠️ 加密/混淆 |

**核心结论**: Phase 1 就能把保护水平从"2小时破"提升到"需要专业逆向工程师数天"。Phase 2 (Sidecar 迁移到 Rust) 后达到 WindsurfGate 级别。
