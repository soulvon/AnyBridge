# AnyBridge EXE 加密保护方案

> 参考 WindsurfGate (Tauri 1.8.3) 保护体系，为 AnyBridge (Tauri 2.x) 构建多层防护。

## 保护层级

```
┌─────────────────────────────────────────────────┐
│  Layer 1: Sidecar 保护 (最重要)                │
│  - javascript-obfuscator 重度混淆              │
│  - bytenode 编译成 V8 bytecode (.jsc)          │
│  - pkg 打包成二进制                             │
│  → JS 源码在编译阶段即被销毁                      │
├─────────────────────────────────────────────────┤
│  Layer 2: Rust EXE 加固                         │
│  - strip 去除所有符号信息                        │
│  - lto=fat + codegen-units=1 最大优化           │
│  - panic=abort 避免展开信息泄露                 │
├─────────────────────────────────────────────────┤
│  Layer 3: 运行时反调试                          │
│  - IsDebuggerPresent 检测                      │
│  - 时间差异常检测 (单步/断点)                   │
│  - 硬件断点清除 (DR0-DR3)                       │
│  - 后台巡逻线程 (2秒间隔)                       │
├─────────────────────────────────────────────────┤
│  Layer 4: 完整性校验                            │
│  - sidecar 二进制 SHA-256 基准校验               │
│  - resources/ 关键文件哈希校验                    │
│  - 首次启动建基线，后续启动比对                  │
│  - 篡改 → 立即退出                             │
├─────────────────────────────────────────────────┤
│  Layer 5: 前端资源                              │
│  - ui/index.html 已在构建时 bundler 压缩       │
│  - 如需进一步保护可用 webpack-obfuscator        │
│  - byok-cards.js 已被 integrity.rs 校验        │
└─────────────────────────────────────────────────┘
```

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `Cargo.toml` | 修改 | 添加编译加固选项 + sha2/hex/windows-sys 依赖 |
| `src/lib.rs` | 修改 | 集成 antidebug + integrity 模块 |
| `src/antidebug.rs` | 新增 | 反调试巡逻 + 硬件断点清除 |
| `src/integrity.rs` | 新增 | 运行时文件完整性校验 |
| `scripts/build_protected_sidecar.py` | 新增 | Sidecar 混淆+编译+打包脚本 |
| `scripts/PROTECTION_GUIDE.md` | 新增 | 本文档 |

## 使用步骤

### 第一步：构建受保护的 Sidecar

```bash
cd E:\project\AnyBridge\sidecar

# 安装构建依赖
npm install --save-dev bytenode javascript-obfuscator

# 运行保护构建脚本
python ..\scripts\build_protected_sidecar.py
```

输出：`src-tauri/binaries/anybridge-proxy-x86_64-pc-windows-msvc.exe`

### 第二步：构建加固的 Rust EXE

```bash
cd E:\project\AnyBridge\src-tauri

# 安装新增依赖
cargo fetch

# Release 构建（自动应用 Cargo.toml 中的加固选项）
cargo tauri build
```

Release 构建会自动应用：
- `strip = true` — 去除调试符号
- `lto = "fat"` — 跨 crate 链接时优化
- `codegen-units = 1` — 单编译单元，最大内联
- `panic = "abort"` — 异常直接 abort，不展开栈

### 第三步：发布

构建产物在 `src-tauri/target/release/`：
- `anybridge.exe` — 加固后的主程序
- `anybridge-proxy-x86_64-pc-windows-msvc.exe` — 受保护的 sidecar

NSIS 安装包在 `src-tauri/target/release/bundle/nsis/`

## 保护效果

### Sidecar 层
- **混淆前**: pkg 打包的二进制可用 [pkg-extract](https://github.com/vercel/pkg) 等工具提取完整 JS 源码
- **混淆+bytenode 后**: 提取出的只有 V8 bytecode（无源码），且 bytecode 经过重度混淆
- **进阶**: 如需更高安全性，可考虑将核心代理逻辑（hybrid-server.js 的 gRPC 拦截部分）迁移到 Rust 中，sidecar 只做极简转发

### Rust EXE 层
- `strip = true` 去除 `.pdb` 符号 → IDA/Ghidra 看到的函数名是 `sub_140001000` 这种
- `lto = "fat"` 跨 crate 内联 → 函数边界模糊，控制流分析更困难
- `panic = "abort"` → 没有 panic 展开信息暴露源文件路径

### 反调试层
- 检测到调试器 → 2 秒内进程退出
- 检测到时间异常（单步/断点）→ 进程退出
- 每次巡逻清除硬件断点 → x64dbg 的硬件断点失效
- **注意**: 反调试仅在 release 模式启用，开发调试不受影响

### 完整性校验层
- 首次启动记录 sidecar 和资源文件的 SHA-256 基线
- 后续启动比对，任何字节改动 → 进程拒绝启动
- 基线存储在用户配置目录，用户自己改也会触发

## 与 WindsurfGate 对比

| 保护项 | WindsurfGate | AnyBridge (本方案) |
|--------|-------------|-------------------|
| 框架 | Tauri 1.8.3 | Tauri 2.x |
| 反调试 | 7 种方法 | 3 种核心方法 |
| 反逆向工具检测 | 40+ 工具 | 未实现（可加） |
| 代码完整性 | 代码段基线校验 | 文件级 SHA-256 校验 |
| 会话加密 | AES-256-GCM + HMAC | 未涉及（无授权系统） |
| sidecar 保护 | 无 sidecar | bytenode + 混淆 |

**本方案已达商用级别基础保护**，如需进一步增强：
- 加 VMProtect / Themida 等加壳工具（Rust EXE 层）
- 加反逆向工具检测（参考 WindsurfGate 40+ 工具列表）
- 将 sidecar 核心逻辑迁移到 Rust（彻底消灭 JS 层）

## 已知限制

1. **bytenode 兼容性**: Node.js 版本必须与编译时一致（脚本用 `node22-win-x64`）
2. **调试模式**: 所有保护仅在 release 模式生效（`#[cfg(not(debug_assertions))]`）
3. **首次启动**: 完整性校验首次启动会建立基线，这不是 bug
4. **前端逻辑**: `ui/index.html` 中如有敏感逻辑，建议用 Vite/Rollup 构建时加入 obfuscator
