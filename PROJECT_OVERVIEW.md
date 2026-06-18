# AnyBridge 项目介绍说明

## 项目概述

AnyBridge 是一个基于 Tauri v2、Rust 和 Node.js 构建的多平台 BYOK（Bring Your Own Key）桥接客户端。项目面向使用 AI 编程工具的个人和团队，提供统一的本地配置、供应商管理和平台接入能力，让用户可以将 Windsurf、Devin、Codex、Claude Code、CodeBuddy、OpenCode 等工具接入自己配置的 Anthropic / OpenAI 兼容 API 服务。

项目的核心目标是：在尽量保留原工具登录、补全、代码库索引和原生体验的前提下，把聊天、模型映射和供应商路由交给用户自己的 API Key 管理。

当前版本：`1.2.17`

## 核心能力

### 多平台 AI 工具接入

AnyBridge 支持两类平台接入方式：

- 代理型接入：Windsurf、Devin。通过本地 MITM / CONNECT 代理接管 Cascade 聊天链路，并对非目标流量保持透传。
- 配置切换型接入：Codex、Claude Code、CodeBuddy、OpenCode。通过写入或切换目标工具配置，将其请求路由到用户选择的供应商。

### BYOK 供应商管理

用户可以在客户端中维护多个 AI 供应商配置，包括：

- Anthropic 兼容接口
- OpenAI 兼容接口
- 自建中转服务
- 支持 Gemini 等非标准 OpenAI 兼容层的 Schema 兼容修复

每个供应商可配置 API Host、API Key、默认模型、模型列表和能力标记，并可进行连通性检测、模型拉取和能力探测。

### 模型映射与注入

针对 Windsurf / Devin，AnyBridge 可以读取 IDE 可见模型列表，并将 IDE 中的模型槽位映射到用户配置的真实供应商模型。该能力用于：

- 将官方模型入口改写为自定义模型
- 解锁或改写模型显示状态
- 注入自定义模型项
- 保持 IDE 原有交互入口不变

### 本地代理与流量治理

代理端默认启动两个本地端口：

- `7450`：主代理端口，用于聊天、模型、能力和 CONNECT 流量处理
- `7451`：推理 / 补全透传入口

代理会按请求类型进行分流：

- 聊天请求转发到用户配置的供应商
- 登录、索引、补全等非目标流量保持直连或透传
- 遥测类请求可按策略屏蔽
- 限流和能力探测请求可按本地策略改写

### 桌面端管理界面

AnyBridge 提供桌面客户端用于管理完整工作流：

- 仪表盘：查看请求量、Token、错误数和运行状态
- 供应商：添加、编辑、测试和管理 API 供应商
- 平台：切换 Windsurf、Devin、Codex、Claude Code、CodeBuddy、OpenCode 等目标工具
- 模型映射：管理 IDE 模型与真实供应商模型之间的关系
- 日志：查看代理运行日志和排障信息
- 模型检测：检测供应商连通性、Vision、Tools、流式响应等能力
- 设置：管理通用行为、更新和安全选项

## 技术架构

项目由桌面主程序、Node.js sidecar 代理和静态 UI 三部分组成。

```text
AnyBridge Desktop (Tauri + Rust)
├─ UI 静态前端
├─ Rust 命令层
│  ├─ 配置读写
│  ├─ 平台检测
│  ├─ 证书生成与安装
│  ├─ IDE 配置写入与还原
│  └─ sidecar 生命周期管理
└─ Node.js Sidecar
   ├─ Hybrid Proxy
   ├─ Inference Proxy
   ├─ Provider Router
   ├─ Model Map Rewriter
   └─ MITM / RPC Audit Logger
```

### 技术栈

| 模块 | 技术 |
| :--- | :--- |
| 桌面端 | Tauri v2 |
| 系统能力 | Rust |
| 代理 sidecar | Node.js 20+ |
| sidecar 打包 | `@yao-pkg/pkg` |
| 保护构建 | bytenode + pkg |
| 数据格式 | JSON / JSON5 / Protobuf |
| 网络请求 | reqwest / Node.js http、https、tls、net |
| 自动更新 | Tauri Updater |
| CI 构建 | GitHub Actions |

## 支持平台

AnyBridge 目标支持以下桌面平台：

| 平台 | 架构 | 状态 |
| :--- | :--- | :--- |
| Windows | x86_64 | 已支持 |
| macOS | Apple Silicon / Intel | CI 构建适配中 |
| Linux | x86_64 | CI 构建适配中 |

发布流程使用 GitHub Actions 矩阵构建，sidecar 文件名会按 Tauri `externalBin` 要求生成对应 target triple，例如：

```text
anybridge-proxy-x86_64-pc-windows-msvc.exe
anybridge-proxy-aarch64-apple-darwin
anybridge-proxy-x86_64-apple-darwin
anybridge-proxy-x86_64-unknown-linux-gnu
```

## 目录结构

```text
.
├─ .github/workflows/          GitHub Actions 发布流程
├─ docs/                       项目设计、打包、排障和复盘文档
├─ scripts/                    构建、发布、检查和诊断脚本
├─ sidecar/                    Node.js 本地代理服务
├─ src-tauri/                  Tauri / Rust 桌面端工程
│  ├─ binaries/                Tauri externalBin sidecar 输出目录
│  ├─ resources/               打包资源
│  └─ src/                     Rust 命令与应用入口
├─ ui/                         静态前端界面
├─ package.json                根项目脚本与依赖
└─ README.md                   快速介绍与基础使用说明
```

## 配置与数据目录

AnyBridge 会在用户配置目录中保存运行数据。

Windows：

```text
%APPDATA%\anybridge\
```

macOS：

```text
~/Library/Application Support/anybridge/
```

Linux：

```text
$XDG_CONFIG_HOME/anybridge/
```

如果 `XDG_CONFIG_HOME` 未设置，则使用：

```text
~/.config/anybridge/
```

主要文件包括：

- `byok-config.json`：通用配置
- `providers.json`：供应商配置
- `model-map.json`：模型映射配置
- `ide-models.json`：IDE 模型缓存
- `certs/`：本地 MITM 证书
- `mitm-logs/`、`rpc-audit/`：排障日志目录

## 本地开发

### 环境要求

- Node.js 20+
- Rust stable
- Tauri CLI
- 对应平台的 Tauri 原生依赖
- Windows 构建需要 Visual Studio Build Tools
- Linux 构建需要 WebKitGTK、GTK、libsoup、AppIndicator 等依赖

### 安装依赖

```bash
npm install
cd sidecar
npm install
cd ..
```

### 启动 sidecar

```bash
npm run start
```

### 启动 Tauri 开发环境

```bash
npm run tauri:dev
```

### 检查 UI 脚本

```bash
npm run check:ui
```

### 构建当前平台 sidecar

普通构建：

```bash
python scripts/build/build_sidecar_plain.py
```

指定平台：

```bash
python scripts/build/build_sidecar_plain.py --platform macos-arm64
python scripts/build/build_sidecar_plain.py --platform x86_64-unknown-linux-gnu
```

保护构建：

```bash
python scripts/build/build_protected_sidecar.py
```

## 打包与发布

正式发布采用私有源码仓库构建、公开 Release 仓库分发的模式：

- 私有源码仓库：保存源码、CI 配置、Tauri 配置和签名公钥
- 公开发布仓库：只保存安装包、签名文件和 `latest.json`
- Tauri Updater：只信任配置中的签名公钥

发布流程详见：

```text
docs/03-打包与更新发布指南-PackagingAndUpdateGuide.md
```

## 安全与边界

AnyBridge 会在本地修改目标工具配置，并在代理型平台中处理 MITM 证书和本地代理流量。因此使用时应注意：

- API Key 仅应保存在本机用户配置目录，不应提交到仓库
- Tauri updater 私钥、发布 token、代码签名证书不得进入源码仓库
- MITM 完整日志默认关闭，只有排障时才建议开启
- 停止代理或退出应用时会尝试还原 IDE 代理配置和前端注入
- 用户应自行确认目标工具条款和所在环境合规要求

## 适用场景

AnyBridge 适合以下场景：

- 想在 AI 编程工具中统一使用自己的 API Key
- 需要管理多个 OpenAI / Anthropic 兼容供应商
- 需要在 Windsurf / Devin 中进行模型映射和模型能力调试
- 需要在多个 AI 编程工具之间快速切换供应商配置
- 需要本地化、可观察、可回滚的代理管理流程

## 开源协议

本项目使用 MIT License。详见：

```text
LICENSE
```

