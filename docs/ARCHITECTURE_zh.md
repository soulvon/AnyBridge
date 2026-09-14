# 架构设计

[English](ARCHITECTURE.md) • [简体中文](ARCHITECTURE_zh.md)

AnyBridge 包含三个主要部分：

- `src-tauri/` 中的 Tauri 桌面外壳
- `ui/` 中的静态前端
- `sidecar/` 中的 Node.js sidecar 代理服务

```text
AI 编程工具
  -> 本地代理或生成的配置
  -> AnyBridge sidecar
  -> 已配置的供应商 API

AnyBridge 桌面端
  -> 平台检测
  -> 供应商配置
  -> 证书管理
  -> sidecar 生命周期
  -> 日志与指标统计
```

## 桌面端 (Desktop)

Tauri 桌面端负责原生系统集成：

- 读写应用配置。
- 检测所支持的目标工具。
- 管理代理模式所需的本地证书文件。
- 启动与停止 sidecar 进程。
- 向前端暴露系统命令 (IPC)。

## 前端 (Frontend)

UI 位于 `ui/` 目录下，属于静态应用。JavaScript 按职责分工拆分，并按固定顺序加载。在提交 UI 变更前，请运行：

```bash
npm run check:ui
```

## Sidecar 代理

Sidecar 是一个 Node.js 独立进程，负责处理本地代理流量、供应商路由、模型映射、日志记录以及请求/响应的协议转换。

Sidecar 在开发期间可独立运行：

```bash
npm run start
```

发布构建时，它会被打包为针对特定平台的独立可执行二进制供 Tauri 外部调用。

## 本地数据 (Local Data)

运行时配置存储在用户的应用数据目录 (`AppData` / `.config`) 中，不在代码仓库内。请勿将令牌、供应商密钥、证书以及抓取的网络流量提交到 Git。
