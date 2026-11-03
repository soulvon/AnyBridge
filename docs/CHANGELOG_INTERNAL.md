# 内部变更记录

> 这是**对内**的技术流水账：根因、实现细节、涉及文件、验证方式。
> **对外**给用户看的更新说明在根目录 `CHANGELOG.md`——那份会被 CI 提取成
> Release notes，直接显示在客户端更新弹窗里，禁止出现代码标识符、文件路径、
> 日志级别、内部术语。
>
> 分工规则：
> - `CHANGELOG.md`：一屏能读完、用户能看懂、只讲"你会得到什么"。一个版本 2-4 条。
> - 本文件：可以写 `hudsucker=debug`、`passthroughParams`、栈追踪、判据与测试名。

## v1.0.14 - 2026-11-03

### 日志膨胀（用户目录 37GB）

- 现象：用户报告 `%APPDATA%\anybridge` 达 37.3GB，其中 `cursor-core.log` 占 37.2GB。
- 根因：`cursor-core/src/bin/cursor-server.rs` 用 `OpenOptions::new().create(true).append(true)` 打开日志文件，**永不切分**；同时默认过滤指令带 `hudsucker=debug`。Cursor 的 MITM 链路每建连打 3-5 行（`hudsucker::certificate_authority::rcgen_authority` 的 "Using cached server config" + `cursor_relay` 的 connect / tls / http 三条打点），心跳与遥测让日志每天增长数 GB。
- 修复：
  - 新增 `cursor-core/src/logging.rs::RotatingLog`：单文件 20MB 切 `.1`（保留一份历史），`write_bytes` 内按累计字节判断；Windows 上轮转前必须先 drop 句柄才能改名。
  - `RESET_ON_START_BYTES = 64MB`：启动时存量超限直接 `truncate`（几十 GB 历史日志没人会读，改名保留只会继续白占盘）。这是用户升级后自动释放空间的唯一路径。
  - 默认过滤指令 `hudsucker` 从 `debug` 降到 `warn`（其 TLS / 连接错误本身是 ERROR 级，仍然保留）；`ANYBRIDGE_LOG_LEVEL=debug` 可整体覆盖，排障能力不变。
  - `sidecar/lib/antigravity-handler.js::logHandshake`：`ag-handshake.log` 超 5MB 写前 `truncateSync`（握手端点被 IDE 周期调用）。
  - `src-tauri/src/commands/plugins.rs::open_plugin_log`：插件 `stdout.log` / `stderr.log` 超 5MB 启动时轮转为 `.1`；子进程持有句柄期间无法中途切分，所以只在 spawn 前判定。
- 测试：`cargo test --manifest-path cursor-core/Cargo.toml --lib logging`（3 个：轮转保留一份、启动截断不产生备份、默认级别与覆盖）。坑点判据 `unbounded-log-growth`。

## v1.0.13 - 2026-11-03

### Cursor 思考等级不生效（issue #40）

- 根因：`sidecar/local-proxy.js::passthroughParams` 把 `reasoning` / `thinking` 整体丢弃，而档位重建 `sidecar/lib/thinking-effort.js` 只服务 Devin/Windsurf 的 modelUid 后缀编码；Cursor 的 modelUid 不带后缀，丢弃后没有任何重建来源。
- 请求侧修复：
  - 三条上游出口（responses 直连 / chat 直连 / anthropic）统一收敛三类客户端来源（`reasoning.effort`、`reasoning_effort`、`thinking`），跨协议按目标族词表钳制；`thinking.type=adaptive` → `high`，`none` 在 anthropic 出口转 `thinking:{type:'disabled'}`。
  - `upstreamBody` 的 responses 分支：原生 Responses 客户端的 `input` 原样透传（原实现用 messages 重建，丢掉带 `encrypted_content` 的 reasoning items，导致每轮从零推理）。
  - `cursor-proxy.js::parseRequestedModel`：解析 `RequestedModel.parameters`（proto field 3），`cursorReasoningFromSession` 注入 `rawBody.reasoning`；`effort=none` 与 cursor-core 同口径（不注入）。
- 响应侧修复：
  - `extractText` 只取 message 的 `output_text`（原本把 reasoning item 的思考文本与 Gemini `thought:true` 片段拼进正文）。
  - `responseReasoningItems`：有 `encrypted_content` 原样回传，只有可读文本时构造不带 id 的摘要项（带查不到的 id 会在下轮回放时触发 upstream item not found）。
  - `sendOpenAIResponses` 假流式按 item 类型分发事件（reasoning 先于 message，`output_index` 顺延）。
- 其他平台：`thinking-effort.js::serviceTierFromUid` 统一 `-priority` / `-fast` 两种加速后缀（`swe-1-6-fast` 是模型名，不误判），下划线风格等价。
- 测试：`sidecar/local-proxy.test.js` 新增 9 场景（含 mock 上游的端到端：档位与回放项到达请求体）、`sidecar/cursor-proxy.test.js` 5 场景、`thinking-effort.test.js` 3 组；反向验证过未修复实现下 3 个测试会红。坑点判据 `client-reasoning-effort-dropped`、`reasoning-content-must-not-leak-into-text`、`fast-variant-service-tier`。
