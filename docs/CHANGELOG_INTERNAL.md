# 内部变更记录

> 这是**对内**的技术流水账：根因、实现细节、涉及文件、验证方式。
> **对外**给用户看的更新说明在根目录 `CHANGELOG.md`——那份会被 CI 提取成
> Release notes，直接显示在客户端更新弹窗里，禁止出现代码标识符、文件路径、
> 日志级别、内部术语。
>
> 分工规则：
> - `CHANGELOG.md`：一屏能读完、用户能看懂、只讲"你会得到什么"。一个版本 2-4 条。
> - 本文件：可以写 `hudsucker=debug`、`passthroughParams`、栈追踪、判据与测试名。

## v1.0.17 - 2026-11-07

- 按用户决定 `git revert f66c989b`，撤销 v1.0.16 的托管供应商接管保护、`plugin_generate_config` 密钥合并、启动对账收敛；代码回到 `83f3996e`（v1.0.15）的行为。
- 撤销动机：v1.0.16 的修复由「把 Agent2API(3065) 误认为本插件服务」的误会触发，用户希望回到试用前的状态。修复本身与端口取值无关，但按用户决定回退。
- 数据层在 revert 之前已单独还原：`p-agent2api-3065` 条目删除（备份 `providers.json.bak-restore-20261107-045419`），托管条目保持 2048 + 插件密钥 + 73 个模型；代码回退不影响运行时数据。
- 版本号不降回 1.0.15（同版本 MSI 覆盖安装会被拒），递增到 1.0.17。
- 验证：`npm run verify`、`npm run check:features`、`check-release-config`、安装包产物验收。

## v1.0.15 - 2026-11-06

### AIStudio2API 插件（提交 6526b4c9）

- 新增 `src-tauri/resources/plugins/aistudio2api/{plugin.json,adapter.js,deploy.md,icon.svg}`：端口 2048、`-open-ui=false` 无窗启动、`/health` 探活、`.env` 只改写托管键、`auths/` 备份对齐卸载恢复、三平台 `stripComponents=1`。
- `plugin_asset.rs::asset_name(tag)`：先解析 release tag 再展开 `{tag}` / `{version}` / `{goos}` / `{goarch}` / `{archive_ext}`；`install()` 复用 `extensions::resolve_release_asset` + `download_asset_with`（与 CPA 同一条镜像测速链路），6 个 Rust 单测。
- `sidecar/plugin-loader.js::runDeploy`：合并 adapter `generateConfig` 回传的 `apiKey` / `adminToken` 进 `configValues`，登记供应商与网关用同一把钥匙。`plugin-aistudio2api.test.js` 10 项 + `plugin-loader.test.js` 1 项。
- `plugin-schema.json` 补齐 `deploy.asset` / `deploy.adapter` / `credentials` / `accent` 契约；`docs/capabilities.md` 登记资产模板能力。

### 插件供应商热插拔（提交 31330448）

- 事故：`providers.json` 已写入 `plugin-aistudio2api`，但前端 `providerStore` 是页面加载时的快照，界面停在旧数量且在旧快照上保存会整体覆盖抹掉新条目。坑点 `provider-store-stale-snapshot`（带 `source_contains` 判据）。
- 收敛：`upsert_plugin_provider` 为唯一写入点，部署登记 / 配置变更 / 启动对账共用；写盘后 emit `providers-changed`，`90-init.js` 监听后 `loadProviders()`（失败显式落日志，且不新增 JS 中文债）。
- 对称：部署登记 ↔ 卸载移除；启动 `reconcile_plugin_providers` 补齐被覆盖的登记、清理孤立 `plugin-*`、保留既有显示名；模型目录复用 `config::fetch_models`，服务就绪后写回 `models` / `defaultModel`（实测 73 个）。
- 判据：`sidecar/plugin-provider-hotplug.test.js` 5 项 + Rust `provider_hotplug_tests` 3 项。

### 验证与已知限制

- `npm run verify` 全绿（27 个单测文件）、`npm run check:features` 209 通过 0 失败；MSI / NSIS 包内 `plugins/aistudio2api/*` 四文件与源码字节一致。
- 端到端实测：9 账户 `ready`、生成服务 `RUNNING`、`POST /v1/chat/completions` HTTP 200。
- 已知：Chrome 157 的 App-Bound Encryption 让上游 v0.3.1 内嵌 ABE helper 报 `ERR decrypt`，「从 Chrome 导入」不可用；Cookie 导入账户是 `device_bound` 副本，约 2 小时失效，自动续签仍依赖 Chrome 材料，因此会周期性掉线。
- 恢复手段：`setup --cookie-file <file> --authuser N`（N=0..9，需 `PROXY=http://127.0.0.1:7897`，CLI 独立进程不继承系统代理）可挖出管理端 discover 看不到的 5..9 槽位账户，再经 `storage-state.json` → Netscape 文本 → `/api/accounts/import/cookies` 落地。本机 Chrome 的浏览器级 CDP WebSocket 可用（`Storage.getCookies`），但 `setup --cdp` 实测 `ListModels 403` / 连接超时，常驻全自动未落地。
- 版本一致性：package.json、package-lock.json ×2、sidecar/package.json、sidecar/package-lock.json ×2、Cargo.toml、Cargo.lock、tauri.conf.json 共 9 处同步到 1.0.15。

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

### 历史遗留自愈（启动时跑一次）

- 背景：实测一台机器安装目录攒了 271MB 死文件——`anybridge-proxy.exe.bak-20261003`(58MB)、`.bak-pre-fix`(58MB)、`anybridge-cursor-core.old.exe`(55MB)、`.prev.exe`(31MB)、旧品牌 `ide-byok-proxy.exe`(55MB) 与 `ide-byok.exe`(13MB)；配置目录另有未再写入的 `ag-requests.log` 与 5 份配置备份。
- 新增 `src-tauri/src/commands/housekeeping.rs`，在 `lib.rs` 的 `setup` 里经 `run_startup_housekeeping()` 后台执行（不阻塞窗口）：
  - 二进制：名字含 `.bak` / `.old` / `.prev` 或旧品牌前缀即清理；`CURRENT_BINARIES` 白名单（当前 exe / sidecar / cursor-core / uninstall）永不删。**旧品牌 sidecar 只在同目录存在 `anybridge-proxy*` 时才删**——它是 `resolve_sidecar_path` 的兼容兜底，老安装可能只有这一份。
  - 日志：`DEAD_LOGS`（`ag-requests.log`）删除；其余 `.log` 超过 64MB 兜底 `set_len(0)`。
  - 配置：`providers.json` / `proxy-routes.json` / `model-map.json` 解析失败 → 复制为 `.corrupt-<ts>` → 从最近的可解析备份恢复；**没有可用备份就保持原样让错误暴露**，不生成可能与当前版本不兼容的骨架。正常文件只裁剪各自超过 3 份的旧备份。
- 测试：6 个单测（清理与保留边界、旧 sidecar 保护、死日志+超大日志、从备份恢复且留损坏现场、无备份不动、备份保留份数）。坑点判据 `startup-housekeeping-self-heal`。

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
