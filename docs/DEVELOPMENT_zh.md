# 开发指南

[English](DEVELOPMENT.md) • [简体中文](DEVELOPMENT_zh.md)

## 环境要求

- Node.js 20+
- Rust stable
- Tauri v2 CLI（通过 `@tauri-apps/cli`）
- 目标平台对应的 Tauri 原生依赖项

Linux 在运行 Tauri 前需要安装：WebKitGTK 4.1、GTK 3、AppIndicator、OpenSSL、librsvg、patchelf、pkg-config、libnm 和 xdg-utils。

macOS 需要 Xcode Command Line Tools。证书安装优先使用登录钥匙串（login keychain），仅当使用系统钥匙串路径时才会请求管理员授权。

Windows 证书安装优先使用 CurrentUser\Root，仅当使用 LocalMachine\Root 路径时才会弹出 UAC 提权提示。

## 安装依赖

```bash
npm install
cd sidecar
npm install
cd ..
```

## 启动运行

运行桌面应用：

```bash
npm run tauri:dev
```

仅运行 sidecar 代理：

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
