# 内部变更记录

> 这是**对内**的技术流水账：根因、实现细节、涉及文件、验证方式。
> **对外**给用户看的更新说明在根目录 `CHANGELOG.md`——那份会被 CI 提取成
> Release notes，直接显示在客户端更新弹窗里，禁止出现代码标识符、文件路径、
> 日志级别、内部术语。
>
> 分工规则：
> - `CHANGELOG.md`：一屏能读完、用户能看懂、只讲"你会得到什么"。一个版本 2-4 条。
> - 本文件：可以写 `hudsucker=debug`、`passthroughParams`、栈追踪、判据与测试名。

## v1.1.9 - 2026-11-14

### 反重力 2.32.1 端点补丁真机失效（JSONC 严格 parse + regex $1 展开，marker 挡自愈）

- 背景：2.32.1 把 `--cloud_code_endpoint` 常量搬进新增的 `dist/lsDefaults.js`
  （`exports.LS_CLOUD_CODE_ENDPOINT`，`baseLsArgs()` 只引用该常量）。节点选择抽成
  `hub_endpoint_node_name` 纯函数（lsDefaults 优先），汉化还原 `hub_has_byok_patch`
  与补丁器共用同一份规则，门控补 2.32.1 形态判据。
- **真机事故一（JSONC 严格 parse）**：真机 `settings.json` 是 JSONC（尾逗号合法），
  注入块严格 `JSON.parse` 抛错被 catch 静默吞掉 → 端点回退官方 → LS 直连官方。
  所有运行时测试此前都走 `ANYBRIDGE_ANTIGRAVITY_SETTINGS` 覆盖 + 严格 JSON fixture，
  默认候选路径从未在真实文件形状上验证——测试全绿、真机失效。
  修复：新增 `antigravity_settings_read_js()`（黑/白底共用）：严格 parse 失败后剥
  块注释/行注释（`[^:"']` 守卫不误伤 `https://`）/尾逗号重试一次；候选构建剥离
  `--user-data-dir` argv 元素内的引号（Electron 实测引号包在元素内）。
- **真机事故二（regex $1 展开毒化）**：`regex::Regex::replace` 的 &str 替换串会把
  注入模板里的 JS 字面量 `"$1"` 当捕获组展开成 `exports.LS_CLOUD_CODE_ENDPOINT = `，
  JSONC 读取全部失效；keeper 定时补打先把毒化 V4 写上真机 asar，V4 marker 完好使
  后续 connect 全部 early-Ok，坏补丁永不自愈。修复：两处替换点改闭包
  `|caps: &regex::Captures|`（结构上杜绝展开）；marker 升 V5 强制重打。
- **真机验证闭环**：dev 版 UI「一键接入」→ asar V5（`"$1"` 字面量完好）→
  restart_ide 重启客户端 → `language_server.exe` 命令行
  `--cloud_code_endpoint https://localhost:7452` → LS 日志
  `https://localhost:7452/v1internal:loadCodeAssist` × 3 + `fetchAvailableModels`，
  `ag-handshake.log` 出现网关回传响应（userTiers），不再「全部 host 失败/超时」。
- **测试隔离缺陷**：撤键腿曾因真机 settings.json 恰好无键而侥幸通过（候选扫描会
  穿透 env 覆盖继续扫 APPDATA）——on/off 腿补 APPDATA 隔离。
- **遗留观察（待蹲守取证）**：验证窗口内 `jetski.cloudCodeUrl` 被外部写者剥过一次
  （22:11 客户端带键启动 → 22:17 键消失，窗口与 dev 应用重启重合；60 秒空闲蹲守无
  动静=事件触发型）。antigravity-tools.exe（独立工具，非 Kite，兄弟已澄清并关闭）
  曾是头号嫌疑但未定案。keeper 目前只保 asar 补丁、不保 settings 键——定案后需评估
  keeper 是否顺带巡检键存活。修复本身不受影响：键在 + V5 在 → 任意重启 LS 必
  指 7452（已复验）。
- 判据：门控 58 项（新增 JSONC 真执行、读取片段共用、引号剥离 3 条）；
  Rust 单测 26 项（新增 `antigravity_injection_reads_jsonc_settings_default_path`：
  JSONC 默认候选路径 + 带引号 argv 优先命中）。坑点 `ag-settings-jsonc-strict-parse-silent-fallback`、
  `ag-regex-replacement-dollar-expansion-poisons-injection`。
- 测试基建顺手加固：`assert_valid_js` / lsDefaults 运行时校验 / 还原对称测试的
  node 执行全部改为重试 3 次 + 失败必 panic（35ef9897 政策收口），内联 node --check
  块收敛进 `assert_valid_js`。

## v1.1.8 - 2026-11-12

### Gemini 上游工具 Schema 兼容（$schema 400）

- 现象：CodeBuddy 经本地网关（OpenAI Chat 协议）调用 Vertex Gemini，带工具调用的消息返回
  `400 Invalid JSON payload received. Unknown name "$schema" at 'tools[0].function_declarations[0].parameters'`。
- 根因：`local-proxy.js` 的 `geminiTools()` 把客户端 tool 的 `parameters` 原样放进
  `functionDeclarations.parameters`（连 `normalizeToolParameters` 都没走）；标准 JSON Schema 的
  `$schema` / `additionalProperties` / `$defs` / `exclusiveMinimum` 等字段不在 Gemini Schema
  子集内，Vertex 直接 400。
- 顺带修复：`handlers/chat.js` 旧 `sanitizeJsonSchemaForGemini` 对 `properties` 直接递归，
  属性名被当非法字段整体过滤（properties 会被清空、工具参数静默丢失）。
- 修复：新增 `sidecar/lib/gemini-schema.js`（`sanitizeGeminiSchema` / `cleanGeminiToolParameters`）：
  白名单字段、`properties` 按「属性名 → schema」递归、`type: ["string","null"]` 折叠为单类型 +
  `nullable`、`oneOf` 降级 `anyOf`、`enum` 过滤 null、空壳补合法空对象。
  收敛点：`local-proxy.geminiTools` 与 `handlers/chat.normalizeToolSchema` 共用同一份实现。
  `shouldAutoEnableGeminiSchemaCompat` 的错误识别补充 `$schema` / `additionalProperties`。
- 测试：`sidecar/lib/gemini-schema.test.js`（5 用例）+ `local-proxy.test.js` 出站集成用例；
  `npm run test:unit` 315/315 通过。

### 附带（v1.1.6 之后累积未发布）

- Vertex AI 出站格式识别：`provider-pool.inferApiFormatFromPath/inferApiFormatFromHost` 支持
  `aiplatform.googleapis.com` 与 `/publishers/google/models`；`40-model-picker` 的
  `isGeneratedProviderApiPath` 收窄为仅 `/v1beta/models/...`，编辑保存不再清空自定义资源路径。
- 模板库新增可用的 Vertex AI 预设：`provider-presets.json` 的 `vertexai` 条目改为 Gemini 协议 +
  global 端点 + `/v1/projects/{project}/locations/global/publishers/google/models` 路径模板 +
  12 个实测模型；`35-provider-presets.js` 支持 `path`/`models` 预填，
  `40-model-picker.js` 暴露 `applyPresetModels`。

## v1.1.6 - 2026-11-11

### 注入块模板改显式占位符 + 旧注入就地剥离

- 背景：v1.1.5 发布后，排查「BYOK 模型不下发」时一度误判为
  `antigravity_settings_candidates_js` 里 `names={names}` 未被 `format!` 替换。
  最小复现（`rustc` 单文件）证明 `format!` 隐式捕获正常工作，
  **v1.1.5 的产品注入块本身没有占位符 bug**；现场看到的 `names={names}`
  字面量来自手工重打脚本（只替换 `{}`、不认 `{names}`）。
- 真因：`settings.json` 的 `jetski.cloudCodeUrl` 被测试脚本删除后未恢复，
  注入块读不到端点即回退官方，表现为下拉只剩官方模型。
- 仍然做的加固（防止同类事故再现）：
  1. 三个 JS 模板全部改为 `__AB_*__` 显式占位符 + `str.replace` 渲染，
     不再使用 `format!`（模板内花括号密集，一处转义错误就静默产出坏代码）；
  2. 新增 `strip_antigravity_extension_injection()`：旧注入可**就地正则剥离**
     再重打，不再依赖 `js.anybridge-bak`（客户端升级会删掉备份）；
  3. 注入块版本升到 v3，keeper 幂等判据只认 v3，旧版自动升级；
  4. 新增执行级单测 `antigravity_injection_actually_works_at_runtime`：
     造真实目录 + 真跑注入块 + 断言端点写进 env（语法检查抓不到运行时错误）；
  5. `check-antigravity-endpoint.mjs` 增加「渲染后无残留占位符」「真执行读出端点」
     判据，并修正旧的错误判据（曾把 `{names}` 当作正确特征，等于绿灯护 bug）。

### 发版流程门控（教训固化）

- 事故：脚本门控全绿就直接推 tag，跳过「dev 人工验收」「本地包验收」，
  把问题交给 CI 与线上用户。
- 新增 `scripts/release-flow.mjs`：三阶段凭证（verify / dev / local）
  **绑定当前 commit SHA**，代码一改即失效；`dev`/`local` 必须显式
  `--user-confirmed`，不允许自己给自己发合格证。
- 新增 `scripts/release-publish.mjs` 作为**唯一推 tag 入口**：
  先校验三阶段 → 再校验发版配置 → 建附注 tag → 推 main + tag。
- `check-release-gate.mjs` 增加凭证校验，缺任一阶段直接失败。

## v1.1.5 - 2026-11-11

> 版本号说明：仓库存在 2026-06-06 的历史 tag `v1.1.4`（HEAD 祖先、无 release 产物）。
> 为满足语义版本单调递增、避免更新器判定降级，本次取 `v1.1.5` 而非 1.1.1。

### 半还原留死端点：切号插件失效

- 现象：停止接入/退出 AnyBridge 后 Agent 面板回退「Continue with Google」，
  切号扩展失效；LS 日志刷 `Post https://localhost:7452/v1internal:loadCodeAssist
  dial tcp 127.0.0.1:7452: connectex: No connection could be made`，并出现
  `[AuthProvider] UpdateEndpointURL called with CLOUD_CODE_URL: https://localhost:7452`，
  而用户级/机器级 `CLOUD_CODE_URL` 都是空的。
- 三个叠加根因：
  1. 注入块只在 settings 有值时写入 `e.CLOUD_CODE_URL`、从不删除，而
     `buildServerEnv` 以 `{...process.env}` 起步，IDE 主进程继承的会话级
     `CLOUD_CODE_URL` 在撤键后仍被传给 `agy.exe`；
  2. 白底 `languageServer.js` 注入的 fallback 读 `process.env.CLOUD_CODE_URL`，
     把同一个脏值当端点；
  3. 黑底与白底共用一份 settings 候选目录，用户只还原黑底时，黑底 `agy.exe`
     仍读到白底残留的本地网关地址。
- 修复：注入块先 `delete e.CLOUD_CODE_URL` 再按需写入；白底 fallback 只回官方常量；
  候选按端隔离（`ANTIGRAVITY_IDE_SETTINGS_NAMES` / `ANTIGRAVITY_HUB_SETTINGS_NAMES`）；
  新增 `clear_antigravity_stale_managed_endpoints()` 成套清理两端残留托管端点
  （含字段级还原的早退分支）；`reg delete` 只改注册表，必须同时终止两个语言服务
  （`language_server.exe` 与 `~/.gemini/bin/agy.exe`，按路径白名单防误杀）促其以干净环境重建。
- 注入块引入版本号（`..._V2`）：keeper 幂等判据只认 v2，旧注入先从
  `js.anybridge-bak` 还原再重打，否则已接入用户升级后旧注入永远得不到修复。
- 判据：`antigravity_restore_clears_inherited_endpoint`（可执行：模拟 settings 无键
  + env 带 7452，断言注入块清掉端点）、`antigravity_legacy_injection_is_upgraded_not_skipped`。
- 坑点：`ag-half-restore-leaves-dead-endpoint`。

### Antigravity Kite 共存

- 冲突面（只读盘点 Kite 1.2.13）：CDP 端口双方默认 9333 但 Kite 可配
  `antigravityKite.cdpPort`（另有 9222 / `DevToolsActivePort` 兜底，并会改 `.lnk` 重启 IDE）；
  Kite 用 VS Code 配置 API 写 19 个 `antigravityKite.*` 键，AnyBridge 原来
  `to_string_pretty` 整体重写同一文件会在并发时静默丢弃；双方都杀 `agy.exe`。
  Kite 不碰 `jetski.cloudCodeUrl` / `app.asar` / `extension.js` / `CLOUD_CODE_URL`，
  两边注入块互不覆盖。
- 修复三条契约：
  1. `resolve_cdp_port()` 动态发现：已确认端口 → Kite 配置 → `DevToolsActivePort`
     → 9333 → 9222，缓存活跃端口，探测失败静默跳过；
  2. `restart_antigravity_ide_with_cdp` 改为「端口已就绪 → 直接补注入，不重启 IDE」，
     重启权与 `.lnk` 归 Kite；
  3. `upsert_settings_endpoint_text` 文本级最小替换 + 写入前重读 + 无变更不写，
     Kite 的键/注释/缩进/CRLF 逐字节保留。
- 判据：`scripts/check-kite-coexist.mjs`（24 项，含反向断言不碰 Kite 独占资源）
  挂进 `npm run verify`；单测 `antigravity_settings_write_preserves_kite_keys_and_format`、
  `antigravity_cdp_port_follows_kite_config`。
- 真机验证：真实 settings（23 键 / 19 个 Kite 键）接入→还原零丢失；
  Kite 状态栏 `池 8/9 · wn***w@*** ·Pro · Claude 100%/100% · Gemini 100%/97%`。
- 坑点：`ag-kite-coexist-contract`。

## v1.1.0 - 2026-11-10

> 发版说明：原计划以 v1.0.20 发布，该包因 `ag-injection-must-not-duplicate-return`
> 事故（还原 BYOK 后 Agent 面板永久卡加载）作废，未对外发布；修复并追加开发版实测后，
> 正式本地打包改为 v1.1.0。本文档下文保留「v1.0.20」字样处均指该次未发布的构建。

### Antigravity 端点接管：假接入根因与两端修复

- 根因：`jetski.cloudCodeUrl` 只被 IDE 主进程消费；Agent 面板的语言服务器是独立进程
  （黑底 `agy.exe --hub`、白底 `language_server.exe --standalone`），端点只认
  `--cloud_code_endpoint` 参数或 `CLOUD_CODE_URL` 环境变量。v0.5.8（4c16b733）删掉
  `setx CLOUD_CODE_URL` 后没有任何接管路径，LS 直连 `daily-cloudcode-pa.googleapis.com`。
  真机证据：`errorreport.go:273] failed to construct executor: unknown model key
  MODEL_PLACEHOLDER_M1: model not found`，界面却显示「已接入」。
- 黑底修复：`platforms.rs::patch_antigravity_ide_extension` 在
  `extensions/agy/vscode/extension.js` 的 `buildServerEnv` 注入自包含读取逻辑
  （自带 `require("os")`，不引用 minify 内部名 `Ia/fd/$c`），运行时从 settings.json 取
  `jetski.cloudCodeUrl` 写入 `serverEnv.CLOUD_CODE_URL`；幂等、带 `.anybridge-bak` 备份、
  锚点缺失报错中断接入。还原撤键后注入块读不到 URL 自动回退官方，行为对称，补丁无需剥离。
- 白底修复：`app-update.yml` 启动即自更新，`installer.exe` 整包覆盖 `app.asar`，
  无声冲掉 `dist/languageServer.js` 的 `--cloud_code_endpoint` 补丁（11/2 接入、11/3 升级
  即复现）。`patch_antigravity_hub_asar` 本身幂等且带自愈正则，缺的是升级后重新触发。
- 保活：`spawn_antigravity_endpoint_keeper` 每 30s 巡检，仅当配置仍指向本地网关时
  重打两端补丁，持 `inject_lock` 避免与汉化全量重写 asar 造成 lost update；未接入零开销。
- 附带：白底安装目录 ACL 只有具体 AppContainer SID、缺 `ALL APPLICATION PACKAGES`，
  Electron 沙箱拒绝读目录导致启动即退出，按官方报错做最小只读授权（本机系统级改动，
  未做进产品自动修复）。

### 跨协议工具历史：硬拒绝改为转换

- 根因：`upstreamBody` 检测到 `gemini_part`（Gemini 的 functionCall/functionResponse、
  非图片 inlineData）且上游非 Gemini 时直接抛 400「只能路由到 Gemini Native 上游」，
  把协议转换缺失伪装成配置错误。BYOK 上游全是 OpenAI 协议，带工具历史必炸。
- 修复：`messagesForNonGeminiUpstream` 把 functionCall→tool_use、
  functionResponse→tool_result（先收集全部调用 id，按 name 队列解析同名多次调用，
  显式 id 优先，最后按调用顺序兜底），非图片附件降级为带 MIME 说明的文本占位。
  返回新数组不改 `ctx.messages`（execute 会拿同一 ctx 重试多个上游），
  `thoughtSignature` 不泄漏到跨协议上游。
- 判据：`local-proxy.test.js::Gemini Native tool history converts to OpenAI tool_calls
  instead of 400` 等 4 例；坑点 `gemini-native-tool-history-must-cross-protocol`。

### 运行时枚举槽位耗尽：选 A 实跑 B

- 根因：11 个 BYOK 模型只有 9 个 `CLAUDE_4_*` 槽位（281/282/290/291/333/334/340/341/342），
  槽位用尽后 `allocateRuntimeModelId` 静默复用，341 同时给了 `sn-glm-5-3-flash` 与
  `sn-sensenova-6-8-flash-lite`；前端按数值反查命中第一个，点前者按钮显示后者，
  342 还与官方 GPT-OSS 120B 撞车。
- 修复：从前端 Model enum 表补 9 个合法且未被官方可见模型/内部依赖占用的
  `GOOGLE_GEMINI_*`（336/337/338/339/343/347/348/350/351），槽位扩到 18 个。
  禁止用前端已移除的 `CHAT_GPT_4/O3/O1/DEEPSEEK_R1`（proto 未知值触发渲染进程无限循环）、
  `MODEL_PLACEHOLDER_M<N>`（LS 内部模型，未注册报 unknown model key）、
  `GOOGLE_GEMINI_INTERNAL_BYOM`（需请求级 override）。
- 判据：`antigravity.test.js::every custom model gets a unique runtime enum slot`
  （14 个模型必须 14 个唯一槽位且与官方不重叠）；坑点 `ag-runtime-enum-slot-exhaustion`。

### 还原后永久卡加载：注入拼接生成两份 return（v1.0.20 打包版事故）

- 现象：用户点「还原 BYOK」后 Agent 面板一直转圈；`agy.exe` 进程 0 个、44363 无监听；
  IDE 主进程/认证正常（`auth.log` 为 `signedIn`），`renderer.log` 只有无关的
  `antigravity.handleAuthRefresh not found`。
- 根因：`patch_antigravity_extension_code` 的 `format!("{head}return (...)...")`
  用了整个 `head = &code[..anchor]`，它已包含原语句 `return c}`；再追加一份
  `return (...)` 后生成 `;return c}\r\n$creturn ((function(e){...}))(c)}`，
  多一份 return 与多余花括号 → `node --check` 报 `SyntaxError: Unexpected token '}'`。
  `agy.exe` 加载 `extensions/agy/vscode/extension.js` 失败 → webview 服务不启动 → 永久卡加载。
- 为何此前没发现：所有真机验证用的都是手工 Node 脚本打的正确补丁；
  「还原 BYOK」触发 LS 重启，才是打包版第一次真正执行 `patch_antigravity_ide_extension`。
  手工路径验证通过 ≠ 产品路径正确，接入/还原后的重启链路必须单独测。
- 修复：`prefix = &head[..ret_idx]`（只取 `return ` 之前）；单测增加
  「补丁后不残留 `return c}`」「`return ` 恰好 2 次」以及**把生成结果交给
  `node --check` 真解析**，并用红-绿确认旧实现会被抓住。另对真机 4MB 文件
  生成补丁预览做语法校验（退出码 0），白底 asar 内 `languageServer.js` 同样校验为 OK。
- 现场处置：从 `tmp/ide-backup/agy-vscode-extension.js`（官方原版、无 marker）还原，
  损坏文件留档为 `agy-vscode-extension.BROKEN.js`；用户当前处于还原（未接入）状态，
  黑底 settings.json 已无 `jetski.cloudCodeUrl`、用户级 `CLOUD_CODE_URL` 为空。
- 坑点：`ag-injection-must-not-duplicate-return`（severity critical）。

### v1.1.0 固化：兼容老版本 / 多用户 / 自定义路径 / 三平台 / 门控

- 注入块：`antigravity_settings_candidates_js()` 抽成共享 JS 片段，黑底 IDE 与白底 Hub
  共用。用户名由 `os.homedir()` + `APPDATA` / `LOCALAPPDATA` / `XDG_CONFIG_HOME` /
  `XDG_DATA_HOME` 推导；产品目录名覆盖 `Antigravity IDE` / `Antigravity` /
  `antigravity-ide` / `antigravity` / `Antigravity-IDE`；支持便携版
  `--user-data-dir=<path>` 与 `--user-data-dir <path>` 两种写法，以及显式覆盖
  `ANYBRIDGE_ANTIGRAVITY_SETTINGS`。绝不硬编码任何具体用户的主目录或盘符。
- 黑底锚点：`antigravity_extension_anchor()` 覆盖 `.buildServerEnvironment`、
  `["buildServerEnvironment"]` / `['...']`、`buildServerEnvironment=` / `:`；
  `patch_antigravity_extension_code` 用 `return\s+([A-Za-z_$][A-Za-z0-9_$]*)`
  正则取锚点前最后一个 return，并**原地替换表达式本身**，后缀（`;}`、CRLF 等）
  原样保留，天然只有一份 return；拒绝 `return new/function/...` 之类误匹配。
- 白底端点串：`patch_hub_language_server_code` 抽成纯函数，正则兼容单/双引号、
  任意缩进与换行、任意官方端点域名、以及历史版本注入的 IIFE（自愈）；
  预检只认当前 marker `/*ANYBRIDGE_CLOUD_CODE_ENDPOINT*/`，旧注入会继续走全量
  路径升级为新注入，而不是被误判为「已打补丁」。
- 路径发现：`antigravity_install_app_dirs()` 统一扫描常见安装父目录里名字含
  antigravity 的子目录，覆盖 Windows `Programs`/`ProgramFiles`、macOS
  `/Applications` 与 `~/Applications`、Linux `/opt`/`/usr/share`/`~/.local`，
  并支持 `ANYBRIDGE_ANTIGRAVITY_IDE_APP_DIR` / `HUB_APP_DIR` / `HUB_ASAR` 显式覆盖；
  `antigravity_localization::hub_asar_path()` 改为复用同一份候选，消除两处漂移。
- 门控：`scripts/check-antigravity-endpoint.mjs`（32 项，含提取真实注入 JS 交
  `node --check`、5 种黑底旧形态 + 4 种白底旧形态 fixture、三平台 cfg、keeper
  与还原对称性）与 `scripts/check-no-sensitive-files.mjs`（已跟踪名单、待提交
  新增行私钥/token/凭据/本机绝对路径扫描、.gitignore 规则）均挂进 `npm run verify`。
  Rust 单测新增 `assert_valid_js` 与多形态用例，共 14 项全绿。
- 坑点：`ag-endpoint-patch-version-and-platform-compat`。

### 真机验证与事故澄清

- 黑底：`CLOUD_CODE_URL` 会话级生效（`Overriding CloudCodeServerURL`），干净重启且
  无任何会话级变量时纯补丁仍生效；下拉 17 条（11 自定义 + 6 官方），
  `sn-deepseek-v4-1-flash-1017` 两轮会话成功（轮次 1/2 上下文正确接续），
  LS 零 `unknown model key`、零 400/429/terminated。
- 白底：LS 参数变为 `--cloud_code_endpoint https://localhost:7452`，下拉 11 个自定义模型，
  真实会话 `Thought for 4s | OK`；`app.asar.official.bak` 已重建为当前官方版。
- 曾经的 `Agent2API HTTP 400（上游返回空响应）` 不是代码 bug：短时间密集探测触发上游限流，
  上游明确回 429「所有候选账号均已限额或禁用，最早 18:57:05 恢复」；解冻后完全相同
  的 64KB 流式请求体直打上游 200。同一 body 的 `stream:false` 200、`stream:true` 短请求
  200，长请求在限流期超时。诊断代码与临时产物已全部清除。
- 遗留：`anybridge.exe` 主程序需重新打包发版后，keeper 与端点补丁才会随「一键接入」
  自动生效；本机此前跑的是手工替换的 sidecar + 手工补丁。

## v1.0.19 - 2026-11-08

### Cursor 3.29+ 门禁摁回 RunSSE 运行时（移植 haxsd #8 真机验证口径）

- 根因：Cursor 3.29+ 登录官方账号后 BootstrapStatsig 下发 `nal_websocket_client` /
  `run_inference_websocket_client` / `cursor_agent_host` / `agent_host_local_loop` 为开，
  Agent Run 改走 `wss://api2.cursor.sh/agent/v1/run` 绕过本地接管（聊天永久 Reconnecting），
  或 RunInference 本地循环 payload 砸进 BidiAppend 被 400；仅摁第一个门禁客户端每轮仍重试 WS（churn）。
- 修复：`analytics.rs apply_gate_overrides` 每次 Bootstrap 强制覆写 5 门禁
  （nal_agent_retries=true，其余四个=false，gate key 按 hash_used 走 djb2/sha256）；
  `proxy.rs` 对残留的 GET /agent/v1/run 升级请求回 501+Connection:close
  （原 401 会被客户端当鉴权失败重试）。
- 判据：`analytics.rs::upstream_patch_forces_legacy_runsse_runtime`（红绿闭环）、
  `proxy.rs::agent_run_websocket_upgrade_is_detected_and_rejected_with_501`；
  坑点库 `cursor-329-websocket-agent-host-bypass`。
- 真机：Cursor 3.27.22 + 新构建 E2E 通过（MITM→RunSSE/BidiAppend→上游 200 回复渲染，
  日志零 /agent/v1/run 尝试）；3.29.x 登录态待升级后验证。

## v1.0.18 - 2026-11-08

### 探针输出上限提到 OpenAI 最小 16（issue #42）

- 根因：`test_connection` 三路探针体写死 `max_output_tokens`/`max_tokens: 5`。
  OpenAI Responses 语义要求 `>= 16`，CPA（CLIProxyAPI）把 chat 的 max_tokens 映射成
  Responses 的 max_output_tokens 后做同值校验，400 拒绝 → 正常渠道被测成「连接失败」
  （issue #42 报错原文：`Invalid 'max_output_tokens': Expected a value >= 16, but got 5 instead`）。
- 修复：三路探针体收敛到唯一构造点 `probe_request_body()`（config.rs），常量
  `PROBE_MAX_TOKENS = 16`（OpenAI 最小合法值；探针只验连通与鉴权，不关心回复长度）。
- 判据：`commands::config::tests::probe_body_output_limit_meets_openai_minimum_16`，
  红绿闭环：旧值 5 上 FAILED，恢复 16 后绿。

## v1.0.17 - 2026-11-07

### 术语统一：代理 → 网关 / 内置供应商

- 界面与后端用户可见文案按语义改名：服务本体=本地网关，暴露的模型清单=内置模型（列表），
  AnyBridge 作为供应商身份=内置供应商（platforms.rs AGENTS 条目与 JS 平台 def.name 已同步，
  metadata_snapshot 断言同步更新）。
- 刻意保留：子代理（subagent）、系统代理/上游代理（system-proxy.js、65-extensions.js CPA、
  plugin_asset/plugins.rs 下载链路）、汉化包里 agent→「代理」的译法。
- 词面耦合同步：cert_install.rs「请先停止代理」/proxy.rs「代理已在运行」→ 网关叫法，
  55-platforms.js includes() 与 20-runtime.js includes() 匹配串同步。
- sidecar 错误消息与 local-proxy.test.js 测试名同步；en-US 词典 key 与 Rust/HTML/JS 源串对齐
  （check-i18n 正向覆盖 + 反向准入 + 后端主句门控全绿）。
- 验证：npm run verify 全绿（cargo check/test、Node 单测、check:i18n、check:ui）。

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
