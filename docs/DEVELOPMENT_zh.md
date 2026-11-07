# 开发指南

[English](DEVELOPMENT.md) • [简体中文](DEVELOPMENT_zh.md)

## 环境要求

- Node.js 20+
- Rust stable（通过 rustup 安装；需要 `cargo` 和 `rustc`）
- Tauri v2 CLI（通过 `@tauri-apps/cli`）
- 目标平台对应的 Tauri 原生依赖项

Linux 在运行 Tauri 前需要安装：WebKitGTK 4.1、GTK 3、AppIndicator、OpenSSL、librsvg、patchelf、pkg-config、libnm 和 xdg-utils。

macOS 需要 Xcode Command Line Tools。证书安装优先使用登录钥匙串（login keychain），系统信任设置可能需要交互授权。常见 TLS、证书信任及授权问题见 [macOS 排障指南](MACOS_TROUBLESHOOTING_zh.md)。

Windows 证书安装优先使用 CurrentUser\Root，仅当使用 LocalMachine\Root 路径时才会弹出 UAC 提权提示。

## 安装依赖

从 https://rustup.rs/ 安装 Rust stable，并重启终端使 PATH 生效。macOS 还需要 Xcode Command Line Tools；Windows 需要 Visual Studio C++ Build Tools 的 MSVC 工作负载。

```bash
npm install
cd sidecar
npm install
cd ..
```

运行 `npm run check:rust` 检查本机 Rust 工具链。Tauri 开发/打包和 cursor-core 构建/检查入口会在开始前自动执行此检查；sidecar 本身是 Node.js 程序，不依赖 Rust。

## 启动运行

运行桌面应用：

```bash
npm run tauri:dev
```

仅运行 sidecar 网关：

```bash
npm run start
```

运行 UI 静态检查：

```bash
npm run check:ui
```

## 构建 Sidecar

```bash
python scripts/build/build_sidecar_plain.py
```

输出文件位于 `src-tauri/binaries/`（已被 Git 忽略）。

为跨平台发布资源构建明确的目标平台：

```bash
python scripts/build/build_sidecar_plain.py --platform x86_64-pc-windows-msvc
python scripts/build/build_sidecar_plain.py --platform aarch64-apple-darwin
python scripts/build/build_sidecar_plain.py --platform x86_64-unknown-linux-gnu
```

## 本地归档 (.local-archive)

历史文档、临时脚本、私有探针、旧截图和遗留资产均保存在 `.local-archive/` 目录中。该目录已被明确忽略，严禁提交到代码库中。
