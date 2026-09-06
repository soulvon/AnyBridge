# Cursor Core Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用独立 Rust Cursor Core 替换 AnyBridge 当前脆弱的 Node.js Cursor BYOK 原型，并通过 AnyBridge 本地网关、安全生命周期和统一状态接口提供稳定的 Cursor 自定义模型能力。

**Architecture:** Cursor Core 作为 AnyBridge 管理的独立 sidecar，负责 Cursor Connect-RPC、Protobuf、会话状态机和工具桥接；AnyBridge 继续负责供应商、API Key、模型路由、重试、统计、证书和平台配置。保留 Cursor 用户真实账号，官方请求按路由策略透传，不伪造订阅权益。

**Tech Stack:** Rust 2021、Tokio、Axum、Hudsucker、Prost、Reqwest、Tauri 2、Node.js 本地兼容 API。

---

## 文件结构

- 新建 `cursor-core/`：独立 Rust workspace/package。
- 新建 `cursor-core/protocols/`：Cursor Proto 契约。
- 新建 `cursor-core/src/protocol/`：Connect 与 Protobuf 编解码。
- 新建 `cursor-core/src/transport/`：MITM、路由与官方透传。
- 新建 `cursor-core/src/conversation/`：每会话状态机和取消机制。
- 新建 `cursor-core/src/tools/`：Cursor 工具调用桥接。
- 新建 `cursor-core/src/upstream/`：AnyBridge Local Gateway 客户端。
- 新建 `cursor-core/src/control/`：健康检查、状态和诊断 API。
- 新建 `src-tauri/src/commands/cursor_core.rs`：sidecar 生命周期与 Tauri 命令。
- 修改 `src-tauri/src/lib.rs`：注册 Cursor Core 命令和退出清理。
- 修改 `src-tauri/tauri.conf.json`：打包 Cursor Core sidecar。
- 修改 `sidecar/hybrid-server.js`：移除 Cursor 业务处理，只保留 AnyBridge 本地模型 API。
- 保留 `sidecar/cursor-proxy.js` 一段迁移期，但不进入新运行路径；稳定后删除。

### Task 1: 建立 Cursor Core 可编译骨架

- [ ] 添加最小 `cursor-core/Cargo.toml`、`build.rs`、`src/main.rs`、`src/lib.rs`。
- [ ] 引入参考项目 MIT 许可声明与 Proto 来源说明。
- [ ] 复制并编译 Cursor Proto；对不能整体生成的协议采用经过 fixture 验证的最小 wire 子集。
- [ ] 添加 `cargo test --manifest-path cursor-core/Cargo.toml protocol` 测试。
- [ ] 验证二进制能监听随机本地端口并响应 `/health`。

### Task 2: 实现 AnyBridge 上游适配

- [ ] 定义只读 `RouteSnapshot`、`ModelRoute`、`ModelCapabilities` 数据结构。
- [ ] 从 AnyBridge 配置目录读取带 revision 的路由快照。
- [ ] 实现 OpenAI Responses、Chat Completions、Anthropic Messages 的本地网关客户端。
- [ ] 保证 Cursor Core 不读取和持久化 API Key。
- [ ] 添加路由快照热更新、无模型、模型禁用和网关不可达测试。

### Task 3: 实现 Cursor 服务路由与模型目录

- [ ] 使用 `(host, service, method)` 路由表代替巨大 switch。
- [ ] 实现 `Local`、`Passthrough`、`Blocked`、`Unsupported` 四种策略。
- [ ] 实现 AvailableModels 和默认模型目录响应。
- [ ] 保留官方账号与官方模型请求透传。
- [ ] 为 Connect unary、Connect-SSE、错误 envelope 添加 fixture 测试。

### Task 4: 实现文本对话与会话状态机

- [ ] 实现 BidiAppend 输入解析和 RunSSE 输出。
- [ ] 以 `conversation_id` 为聚合根管理 request、exec 和 interaction ID。
- [ ] 实现流式文本、思考事件、结束事件、取消与超时。
- [ ] 实现历史上限和敏感内容日志脱敏。
- [ ] 添加单轮、连续多轮、断流、取消、上游错误测试。

### Task 5: 实现核心 Agent 工具

- [ ] 定义统一 `CursorTool` 接口和 ToolRegistry。
- [ ] 迁移 Read、Glob、Grep、Write、StrReplace、Delete、Shell。
- [ ] 迁移 MCP、CreatePlan、Todo、SwitchMode。
- [ ] 对工具结果实施大小、类型、超时和取消限制。
- [ ] 添加每个工具的调用与结果 fixture 测试及一条多轮工具链集成测试。

### Task 6: Tauri 生命周期与配置恢复

- [ ] 新增 `cursor_get_status`、`cursor_preflight`、`cursor_enable`、`cursor_disable`、`cursor_repair`、`cursor_restart`、`cursor_export_diagnostics`。
- [ ] 启动 Cursor Core 时生成临时控制 token，并限制监听 `127.0.0.1`。
- [ ] 删除新路径中的 fake Pro JWT 写入；只修改必要的代理、本地模型可见性和兼容设置。
- [ ] 所有 Cursor 文件和 SQLite 修改使用备份、事务、失败回滚和显式恢复。
- [ ] AnyBridge 退出时优雅停止 Core；异常残留可在下次启动修复。

### Task 7: 迁移运行路径

- [ ] 从 `hybrid-server.js` 移除 `handleCursorRequest` 调用。
- [ ] 保留现有 Windsurf/Devin 行为不变。
- [ ] 让 Cursor Core 调用 AnyBridge 已有本地 API。
- [ ] 为旧 Cursor 配置和旧 auth 备份提供一次性迁移与恢复。
- [ ] 稳定后删除 `cursor-proxy.js` 和对应 Node smoke tests。

### Task 8: 后端验收

- [ ] 运行 Cursor Core 全部 Rust 单元与集成测试。
- [ ] 运行 AnyBridge `cargo test`、Cursor 配置测试和代理回归测试。
- [ ] 使用安装版 Cursor 完成 AvailableModels、流式文本、多轮和工具闭环 E2E。
- [ ] 验证真实 Cursor 账号未被覆盖，官方模型和本地模型可并存。
- [ ] 断开 Core 后验证还原直连和异常恢复。

### Task 9: Gemini 前端契约交付

- [ ] 固化统一 `CursorStatusSnapshot` JSON schema。
- [ ] 固化命令参数、返回值、错误码和 `availableActions`。
- [ ] 提供状态样例、首次接入流程和最近活动事件结构。
- [ ] 明确 Gemini 不应依赖旧 `cursorAuth` 字符串或旧四卡片拼装逻辑。
