---
description: 分析第三方开源项目并生成 AnyBridge 插件文件（plugin.json + adapter.js + deploy.md）
---

## 输入
用户提供以下之一：
- GitHub 仓库 URL（如 https://github.com/chenyme/grok2api）
- 本地项目路径
- 项目名称（AI 自行搜索）

## 前置条件
- AnyBridge 项目在当前工作区
- `src-tauri/resources/plugins/` 目录存在（如不存在则创建）

## 执行步骤

### 1. 分析项目
1.1 如果是 GitHub URL，先 clone 到临时目录
1.2 读取：README.md / package.json / go.mod / requirements.txt / Cargo.toml / Makefile / Dockerfile / config.example.*
1.3 确定：语言、构建方式、启动命令、配置格式、HTTP API、管理界面、账号系统、健康检查方式、默认端口、数据存储

### 2. 生成 plugin.json
2.1 填写所有元信息字段（含 apiVersion: 1）
2.2 configSchema：读取配置示例文件，密钥设为 hidden+generate，端口设为 number+default
2.3 capabilities：有HTTP→health-check，有账号API→account-management，有Key管理→client-keys
2.4 panels：所有插件有 overview，根据 capabilities 添加对应面板
2.5 deploy.strategies：默认 ["source"]，有 Dockerfile 且用户选择→["source","docker"]

### 3. 生成 adapter.js
3.1 必须实现：checkEnvironment(ctx) / generateConfig(ctx, configValues, installPath)
3.2 如果有管理 API 需要认证，实现 authenticate(ctx, port, configValues)
3.3 根据 capabilities 实现可选方法，所有方法第一个参数为 ctx
3.4 阅读项目源码确认 API 端点和请求/响应格式
3.5 使用 process.platform 处理平台差异

### 4. 生成 deploy.md
4.1 优先添加 `## Strategy: Source` 段（Windows 友好，无需 Docker）
4.2 如果项目有 Dockerfile/docker-compose，添加 `## Strategy: Docker` 段作为备选
4.3 每个策略必须包含：Prerequisites / Steps / Notes / Uninstall
4.4 国内网络适配：GOPROXY=goproxy.cn / npm registry.npmmirror.com / GitHub gh-proxy.com
4.5 每步有验证条件（`**验证**:` 行）
4.6 使用 {installPath} / {config.xxx} 变量占位符

### 5. 生成 icon
优先使用项目 logo，没有则生成默认 SVG 图标，128x128

### 6. 创建插件目录
`src-tauri/resources/plugins/{plugin-id}/` 下放入 plugin.json / adapter.js / deploy.md / icon.svg

### 7. 验证
7.1 JSON Schema 校验 plugin.json
7.2 Node.js import 测试 adapter.js
7.3 检查 deploy.md 包含所有必需章节
7.4 检查 capabilities 声明的方法都在 adapter.js 中实现

## 输出
生成 `src-tauri/resources/plugins/{plugin-id}/` 下的所有文件，并在对话中总结插件信息
