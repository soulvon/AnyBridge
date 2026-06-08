# Tauri 打包时间和误判问题

## 问题现象

运行 `npm run tauri:build:local` 后，过早检查 `src-tauri/target/release/bundle` 目录，发现不存在或为空，误以为打包失败。

## 根本原因

Tauri 完整打包流程耗时较长，包括：

1. **Rust 代码编译**（如有改动）
2. **前端资源嵌入**
3. **NSIS 安装包生成**（使用 makensis.exe）
4. **MSI 安装包生成**（使用 WiX toolset：candle.exe + light.exe）

**时间参考**：
- 首次完整构建（clean build）：5-8 分钟
- 增量构建（Rust 已编译）：2-3 分钟
- 只重新打包：1-2 分钟

## 常见误判

### 误判 1：以为缺少打包工具

**症状**：bundle 目录未生成，认为是 WiX 或 NSIS 未安装。

**真相**：如果之前能正常打包，说明工具是齐全的。只是构建还在进行中。

**验证工具是否存在**：
```powershell
Get-Command makensis.exe  # NSIS
Get-Command candle.exe     # WiX
```

### 误判 2：以为命令卡住

**症状**：命令执行后长时间无输出，以为卡死。

**真相**：NSIS 和 WiX 打包过程默认输出较少，看起来"卡住"实际在正常工作。

**检查进程**：
```powershell
Get-Process -Name node,cargo,makensis,candle,light -ErrorAction SilentlyContinue
```

如果能看到这些进程，说明正在打包中。

### 误判 3：提前中断命令

**症状**：等待 1-2 分钟后以为失败，按 Ctrl+C 中断。

**后果**：真正中断了构建过程，导致 bundle 不完整。

## 正确做法

### 1. 完整运行，不要中断

```powershell
# 运行命令并等待完成
npm run tauri:build:local

# 或捕获完整输出
$output = & npm run tauri:build:local 2>&1 | Out-String
Write-Host $output
```

### 2. 等待 PowerShell 提示符返回

不要在命令还在运行时就检查输出目录。等到 `PS E:\project\IDE-BYOK>` 提示符重新出现。

### 3. 验证构建成功

```powershell
# 检查最终产物
Get-ChildItem "src-tauri\target\release\bundle" -Recurse -Include "*.exe","*.msi" | 
    Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,2)}}
```

**预期输出**：
```
Name                            MB
----                            --
IDE BYOK_1.2.1_x64-setup.exe  17.67
IDE BYOK_1.2.1_x64_en-US.msi  25.24
```

## 关键教训

> ⚠️ **如果之前能正常打包，现在也一定能打包（假设代码和环境没变）。**
>
> 不要因为"看起来卡住"或"等了 1-2 分钟没反应"就怀疑工具缺失或环境有问题。
>
> **90% 的"打包失败"都是因为没有耐心等待构建完成。**

## 加速打包的方法

### 方法 1：只重新编译 Rust

如果只改了 Rust 代码，前端未改：

```powershell
# 先编译 Rust
cargo build --release --manifest-path src-tauri/Cargo.toml

# 再打包（Rust 编译已完成，会更快）
npm run tauri:build:local
```

### 方法 2：跳过打包，只编译

快速验证 Rust 编译是否通过：

```powershell
npm run tauri build -- --no-bundle
```

只生成 `ide-byok.exe`，不生成安装包。用于快速测试。

### 方法 3：增量构建

不要每次都 `cargo clean`。Cargo 的增量编译能显著加速。

只有在遇到奇怪的编译错误时才需要 clean：

```powershell
# 清理后重新构建
cargo clean --manifest-path src-tauri/Cargo.toml
npm run tauri:build:local
```

## 相关文档

- `spec/09-打包发布指南-BuildAndReleaseGuide.md` — 完整打包流程
- Tauri 官方文档：https://v2.tauri.app/distribute/windows-installer/

## 记录时间

2026-06-08 — 在实际打包过程中发现并总结此问题
