# Changelog

All notable changes to AnyBridge will be documented in this file.

## v0.5.10 - 2026-09-11

- 修复 macOS 版代理无法启动：sidecar 启动瞬间被系统以信号 5（SIGTRAP）终止，界面报「代理主端口 7450 未监听」。
  - 根因：Tauri 2 的 `bundle.macOS.hardenedRuntime` 默认为 `true`，签名时会以 Hardened Runtime 签署 bundle 内全部可执行文件（含 externalBin）；项目此前未配置 entitlements，pkg 打在 Node.js 运行时上的 `anybridge-proxy` 缺少 `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory`，V8 初始化时无法申请 JIT 可执行内存而被 trap。
  - 修复：新增 `src-tauri/entitlements.plist` 并在 `tauri.conf.json` 的 `bundle.macOS.entitlements` 引用，只声明 JIT 必需项，不额外放宽库校验（`disable-library-validation`）。
  - 发布门禁：移除会被 Tauri 覆盖的打包前预签名，改为在打包后校验最终 `AnyBridge.app`——整包 `codesign --verify --deep --strict`、断言 sidecar 的 Hardened Runtime 标记与两项 JIT entitlement，并用独立配置目录做 5 秒启动冒烟，被信号终止即中断发布。
- 诊断增强：sidecar 退出状态为信号 5 时，日志按平台给出可读说明（macOS 指向 JIT entitlement，其他 Unix 指向通用断点/陷阱）。
- 发布门禁修正：Hardened Runtime 断言此前按孤立的 `(runtime)` 精确匹配，而实际 flags 为 `0x10002(adhoc,runtime)`，导致 v0.5.9 的 macOS 构建被误判为「未启用 Hardened Runtime」而失败；该版本未发布，签名链路本身是正常的。

## v0.5.8 - 2026-09-11

- 优化 Antigravity 稳定性与对话体验：
  - 内部依赖模型（checkpoint / fast model）现在跟随用户**当前正在使用**的 BYOK 模型，而不是平台默认 provider；默认 provider（如冷却中的 CPA）不再拖累内部请求。
  - 内部依赖模型失败时静默返回空响应，错误只写入诊断日志，不再把 `[AnyBridge] 上游请求失败` 提示条插入对话。
  - `v1internal:streamGenerateContent` 改为**真流式透传**：直接 pipe 上游 SSE 并逐块转换为 Gemini 帧（中间帧 `OTHER`，工具调用 `TOOL_CALL`，末尾补空 `STOP`），避免缓冲导致长回复时 Language Server 等待超时；上游不支持时自动回退到缓冲模式。
  - 新增回归测试（流式转换、内部模型跟随），`local-proxy` 与 `antigravity` 共 31 项全部通过。
- 修复 Antigravity 流式响应缺少 Cloud Code 信封导致 Language Server 空指针崩溃的根本问题：
  - 根因：`v1internal:generateContent` / `v1internal:streamGenerateContent` 的正确响应格式是 Cloud Code 信封 `{ response, traceId, metadata }`；此前返回裸 `candidates`，LS 解析时取 `envelope.Response` 得到 nil，在 `generation.go:680` / `stream_helpers.go:181` 空指针崩溃（进程 `exit code 2`，界面永久卡在 "Working."）。参考开源实现 `vahapogut/antigravity-add-model` 的 `{ response: { candidates: [...] }, traceId: '', metadata: {} }` 格式修正。
  - 修复：两个生成端点统一包信封；流式先发内容帧（`finishReason` 用 `OTHER` / `TOOL_CALL`），随后补一个空 `parts` 的 `STOP` 终止帧；工具调用时标记 `TOOL_CALL`。
- 修复 Antigravity Agent 卡在 "Working." 不回复的致命问题：
  - 根因：`/v1internal:streamGenerateContent` 在上游失败（如商汤 `HTTP 429: inference exceeds tpm/rpm limit` 或 `HTTP 400: inference request is invalid`）时，代理返回的是 HTTP 错误 + `application/json`；Antigravity Language Server 2.5.5 的流式解析器把该响应当流处理，触发空指针崩溃（`panic: runtime error: invalid memory address or nil pointer dereference`，`generation.go:680` / `stream_helpers.go:181`），进程 `exit code 2`，界面永久停留在 "Working."。
  - 修复：Antigravity `streamGenerateContent` 分支捕获上游异常后统一降级为协议合法的 SSE 快照（HTTP 200 + `text/event-stream`），把错误信息作为模型文本回复返回，Agent 不再崩溃或卡死，用户能直接看到上游失败原因。
  - 新增回归测试，`local-proxy` 与 `antigravity` 共 28 项全部通过。
  - 说明：商汤通道当前存在 `tpm/rpm` 限流，`gpt-5.6-luna(CPA)` 的 codex 额度仍在冷却；本次修复解决的是“上游报错时代理导致 LS 崩溃”，不改变上游配额本身。

- 修复 Antigravity 自定义模型能显示、但 Agent 对话被上游拒绝的问题：
  - 根因是 Antigravity 发送 Gemini / Google 风格工具声明，参数 schema 使用 protobuf 大写枚举（`type: "OBJECT"` / `"STRING"`）；代理原样透传给 OpenAI 兼容上游，导致 CPA 返回 `HTTP 400: Invalid schema for function 'browser_subagent': 'STRING' is not valid under any of the given schemas.`，界面表现为 `Agent execution terminated due to error`。
  - 新增工具 schema 递归归一化：将 `STRING/NUMBER/INTEGER/BOOLEAN/ARRAY/OBJECT`（含 protobuf 数字枚举 1–6）转换为小写 JSON Schema，并递归处理 `properties` / `items` / `anyOf|oneOf|allOf`；仅在输出到 OpenAI / Anthropic 上游时生效，`normalizeGeminiTools` 保持不变，Gemini 上游仍收到 Google 大写枚举，避免反向破坏。
  - 补充 3 条回归测试：OpenAI / Anthropic 必须收到小写 schema、Gemini 上游必须保留大写枚举；`local-proxy` 与 `antigravity` 测试共 27 项全部通过。

- 修复 Antigravity 自定义 API 模型可显示但无法对话的问题：
  - 根因是纯 BYOK 模型目录丢失了 Language Server 构建 Cascade 所需的内部模型注册，导致请求发往上游前即报 `unknown model key MODEL_PLACEHOLDER_M36/M50/M318: model not found`；同时自定义模型的运行枚举、`modelProvider` 与 `apiProvider` 协议族不一致，生成的 ModelInfo 无法稳定注册。
  - 新增 M36、M50、M318 隐藏依赖模型，仅供 Language Server 内部使用，不加入模型下拉列表；这些内部生成请求统一路由到当前启用的 Antigravity BYOK 默认模型。
  - 自定义模型按运行枚举同步生成匹配的 Anthropic/OpenAI/Gemini Provider 字段，并携带真实 `vertexModelId`，保证模型目录、执行器与上游路由一致。
  - 使用真实 Antigravity Language Server 重启验证：模型解析错误清零；自定义主模型及 M36/M50/M318 内部模型均可经本地代理返回有效响应。
- 修复 Antigravity 混合模式启动期网络卡死：使用 `AbortController` 硬超时覆盖 DNS、代理 CONNECT、TLS 与响应全生命周期，避免官方服务不可达时阻塞 IDE 状态刷新。
- 完善 Antigravity 账号握手、模型目录、Token 计数、推理响应和遥测旁路处理，并补充协议三元组、隐藏依赖和内部路由回归测试。

## v0.5.7 - 2026-09-09

- 紧急修复前端致命崩溃：`55-platforms.js` 引入 Antigravity 平台时 `openAntigravityAddPage` 未定义，模块加载链在挂载阶段抛出 ReferenceError 整体中断，导致「添加模型」按钮无响应、代理状态不刷新、CPA 套件状态不显示；已补齐函数定义（保留 `openAntigravityAddModal` 别名兼容），并在 `check:ui` 中新增 `mirrorFns` 挂载符号静态防呆检查，此类错误今后在打包前直接拦截。
- 新增模型目录：内置 GPT-6 Astra 全思考档位、GPT-5.6 Sol/Luna/Terra、Claude Opus 5 / Sonnet 5 / Fable 5 系列、Grok 4.6、DeepSeek V4 Pro/Flash、GLM-5.3、Kimi K3、Gemini 3.7/3.8 Flash 等新旗舰模型；配套更新 Windsurf 模型目录与上下文预设（GPT-6 Astra / Claude Opus 5 按 1M 上下文识别）。
- 新增 Claude Desktop 平台支持（重大功能）：
  - 全新「Claude Desktop」平台页：通过官方企业级部署通道接管桌面版推理网关，将 Sonnet / Opus / Haiku（可选 Fable）四档角色映射到任意本地代理模型；
  - Codex / Claude Code 同款卡片化配置管理：多配置预设池、一键切换、编辑/删除、搜索过滤、切回官方默认配置，写入前自动快照、失败整体回滚；
  - 网关链路完整支持 1M 上下文：自动识别 `[1m]` 标记模型并转换为官方 `supports1m` 声明，上游转发自动剥离/还原标记；
  - 本地代理新增 `/claude-desktop` 路由前缀，复用现有协议转换、重试与故障转移能力。
- Windsurf / Devin 模型映射健壮性大加固：
  - 修复前端启动竞态导致 `model-map.json` 槽位被空对象覆盖的严重隐患：为模型映射、供应商总表、代理模型路由三大模块加装「加载状态锁」，未就绪前禁止任何写盘；
  - 后端写盘前自动备份 `model-map.json.bak`，双重保险防数据丢失；
  - `renderModelMap` 渲染链路全量 try-catch 隔离，单行异常不再导致整表空白；
  - Codex / Claude Code 原生重试保存后同步内存状态，杜绝状态倒退。
- Claude Code 1M 模型标记规范化：`ANTHROPIC_DEFAULT_*_MODEL` 保留 `[1m]` 真实请求名，`*_NAME` 显示名自动剥离标记，兼容 AnyRouter 等特殊供应商。
- 图标与文案优化：
  - Claude Desktop 采用官方陶土橙圆角背景 + 白色 12 瓣星芒图标；
  - CodeBuddy / WorkBuddy 图标去除透明边距满版重绘，与整体视觉对齐；
  - 全平台官方卡片统一命名为「官方默认配置」；平台二级标题统一简化为「模型列表」；
  - 界面全面去术语化：3P/1P 等内部概念统一改为「本地路由模式」「官方默认配置」。
- 前端渲染加载时机修复：应用初始化与平台切页时主动触发模型列表渲染，彻底解决切页后列表空白问题。

## v0.5.6 - 2026-09-08

- 新增运行时插件 Jimeng2API：接入 zhizinan1997/jimeng-free-api-all（即梦 2API 网关），支持即梦 5.x/4.x 图像与 Seedance 视频模型，OpenAI 兼容接口，内置账号池与可视化管理控制台。
- 插件系统架构重大增强与 Bug 修复：
  - 修复打包环境下动态适配器加载失败问题：针对 pkg 二进制环境下缺少 V8 动态 import 回调（抛出 `A dynamic import callback was not specified`）的缺陷，重构为沙箱解析加载器，保证在任何打包运行环境下 100% 稳定运行。
  - 扩展中心「已安装」Tab 升级：所有已安装运行的插件自动在已安装 Tab 渲染为完整大卡片（对齐 CPA 套件规格），卡片集成 Logo、版本、端口、目录、状态徽章、操作栏及访问凭证（包含 OpenAI Base URL 与 Web 控制台地址，支持一键复制与直达）。
  - 新增插件更新管理能力：实现前后端 `plugin_check_update` 与 `plugin_upgrade` 链路，支持在线对比最新提交，卡片实时亮起「有更新」徽章并支持一键拉取代码、更新依赖与自动重新构建。
  - 卸载流程与体验优化：卸载操作增加 `uninstalling` 状态，卡片展开平滑进度条与操作禁用保护，彻底解决卸载无进度反馈的问题。
  - Jimeng2API 本地免密直达升级：借鉴 CPA 套件的免密设计，自动绕过控制台初始化设置与账号密码登录界面，点击「打开面板」直接进入控制台管理，彻底消除密码记忆与登录心智负担。
  - 部署与配置收敛：Jimeng2API 统一纯源码构建（Node.js >= 22），自动生成 AES-256 账号池加密密钥，启动参数多层锁定端口，健康检查对接 `/v1/models`。

## v0.5.5 - 2026-09-08

- 更新弹窗链路修复：新增每 10 分钟周期轮询与防重入保护，应用长期运行也能及时收到更新提示，彻底解决"过了很久都收不到更新弹窗"的问题。
- 更新调度升级（借鉴 Cherry Studio）：自动检查间隔增加 ±15% 随机抖动，避免大量客户端同时请求更新源；连续失败按 5/10/20/40 分钟指数退避。
- 配置容灾升级（借鉴 Cockpit-Tools）：更新配置保存前自动备份 `.bak`，损坏时优先从备份自动回滚用户设置，回滚失败才隔离重置，设置彻底不丢。
- 版本比较修复：更新版本号比较由字符串字典序改为数值分段比较，杜绝 `0.10.0` 无法超过 `0.9.0` 导致更新被静默漏掉的重大隐患。
- 发布流程加固（借鉴 Cockpit-Tools）：发布清单生成后校验全平台键与签名完整性，残缺清单绝不进入发布流程；下载失败识别 404/503 发布窗口期并给出明确提示。

## v0.5.4 - 2026-09-08

- macOS 签名修复：为整个 App 配置 Tauri 官方 `signingIdentity: "-"`（ad-hoc）签名，按 Apple 规范由内到外签署 sidecar、主程序与 App Bundle，解决部分 Mac 用户浏览器下载后提示「App 已损坏，无法打开」的问题。
- 说明：ad-hoc 签名不改变 Gatekeeper 对未公证软件的信任策略，个别系统仍可能提示无法验证开发者，可在「系统设置 → 隐私与安全性」中放行，或执行 `xattr -rd com.apple.quarantine /Applications/AnyBridge.app` 后打开。

## v0.5.3 - 2026-09-07

- 本地代理增强：完善 local-proxy 路由处理逻辑，提升请求转发稳定性与覆盖场景。
- 供应商池优化：provider-pool 行为修正，配套新增单元测试覆盖关键路径。
- 代理页面与运行时联动优化：精简代理页结构、更新运行时脚本与样式，整体交互体验更顺滑。
- 更新弹窗纯文本渲染：更新成功弹窗的更新内容改为纯文本显示，彻底移除多余圆点与叠字问题。

## v0.5.2 - 2026-09-07

- Cursor 平台供应商前缀样式弹窗结构修复：移除冗余的重复关闭容器与底部操作栏节点，恢复弹窗正常渲染与点击交互。

## v0.5.1 - 2026-09-07

- Cursor 平台模型前缀/后缀样式体验优化：
  - 重构模型供应商前缀设置弹窗，支持徽章分组模式、前缀模式（标准方括号、圆括号、书名号及自定义括号）与无前缀模式；
  - 增强预设选择器交互态，高亮与聚焦表现更加细腻现代；
  - 完善本地回环测试与跨架构构建兼容性。
- CI 与发布流加固：
  - 补充 `cursor-core` 多架构交叉编译与 CI 检查支持，确保各平台自动构建畅通。

## v0.5.0 - 2026-09-07

- 自动更新机制全面升级（对齐 Cockpit Tools 架构）：
  - 双通道更新分流：配置 `latest-{{target}}.json` 目标平台专属端点及全量备用端点，多架构矩阵发布互不阻塞。
  - 配置损坏隔离容灾：读取更新配置遇断电损坏自动隔离备份并重置为安全默认值，杜绝因配置损坏导致应用卡死在启动流程。
  - 增量设置更新与日志链路：实现 `patch_update_settings` 增量修改与 `update_log` 全程日志追踪。
  - 自动静默安装闭环：下载前自动清理 sidecar 避免 Windows 文件占用；修复更新就绪后“点击立即重启引发二次联网下载”的严重缺陷，实现平滑静默自动安装重启。
- 更新界面与视觉现代重构：
  - 发现新版本与下载弹窗：集成细胶囊进度条、一键取消下载、实时居中百分比、重试回退与手动下载兜底。
  - 升级成功（Version Jump）弹窗：去除重复图标徽章，保留简洁典雅的“🎉 更新成功！”与版本演进说明。
  - 视觉样式统一：更新主按钮全面统一为 AnyBridge 湖蓝到青绿微光渐变玻璃拟态质感，完美融入软件主色调。
- 接口协议与表单极简优化：
  - 字段标题全盘统一：全面替代生硬的「协议后端 (API Backend)」和「上游协议」，统一为规范标准的「接口协议」。
  - 选项文案告别代码变量：去除 `chat_completions` / `responses` / `messages` 等底层变量名，精简为「OpenAI 兼容（默认）」、「Responses」、「Anthropic」。
  - 请求重试卡片重构：精简 Claude Code 与 Codex 冗长的重试解释文案，优化为紧凑优雅的左右行内排版。
  - 本地代理徽章修复：补齐 `.codex-config-badge.local` 胶囊样式，修复「本地」纯文本未套用标签框的视觉问题。
- CI/CD 发布构建流强化：
  - 自动生成各 Target 平台独立清单及全平台 `SHA256SUMS.txt` 校验和文件。
  - 发布时一并上传全局清单、分平台清单与校验和文件。

## v0.4.8 - 2026-09-07

- 全局设置模态化重构：设置项全面升级为全局大尺寸模态弹窗，无需跳转页面即可随时调起设置。
- 平台设置统一架构：Cursor、Windsurf、Devin 设置界面完全统一为 Master-Detail 宽屏大模态框架构（960px 宽度与自适应视口高度）。
- Cursor 设置功能增强：新增状态诊断（Core 存活、CA 根证书受信、本地代理密钥、生效模型实时预检）、Core 服务控制、Local CA 根证书管理及环境路径自动探测保存。
- 视觉与交互体验优化：操作按钮文案精简为「设置」，路径输入框自适应整行撑满，环境检测提示去除冗余边框与底色，还原语义色彩体系。

## v0.4.6 - 2026-09-06

- 扩展中心架构重构：完全对齐独立 Tab 规范，将「扩展服务」、「插件列表」、「日志」划分为完全独立的互斥功能页面。
- 插件列表统合：将所有扩展与插件（CPA 套件、sub2api、free 即梦及运行时扫描插件）整合为平等的卡片网格，支持一键安装与按需启停。
- CPA 套件管理增强：增加「重启」生命周期按钮，服务凭证与组件状态模块化展示。

## v0.4.4 - 2026-09-06

- 模型图标库与分类对齐：完整同步 Cherry Studio 官方 168+ 款模型高清图标库与 118+ 条精准匹配规则，全面支持 `gpt-6-astra`、`gpt-image-2`、`gpt-5.6-luna`、`grok` 等最新型号自动归类。
- 供应商模型选择器全面对齐 Cherry Studio：重构右侧分类栏，支持「全部 / 文本 / 图片 / 嵌入 / 音频 / 视频 / 重排」多模态分类过滤、实时动态数字 Badge 统计以及 A-Z 快速排序。
- 添加映射页面秒开优化：解耦模态框打开时的远程网络同步阻塞，优先使用本地槽位模型实现 0 延时毫秒级秒开，远程账号同步转入后台静默执行，并增加 6 秒请求超时保护。
- 模型映射与槽位列表图标优化：
  - 待选映射模型列表项全面呈现真实高清模型图标；
  - IDE 槽位模型列表告别灰色通用魔方立方体，全面呈现真实品牌 Logo，并支持选中态高亮角标对号；
  - SWE / Devin 系列模型精准绑定专属彩色点阵螺旋图标并平衡视觉留白；
  - 未收录及自定义模型未命中时，全面升级为极简 AI 晶体算力星芒核心（Sparkle Core），告别粗糙单字头像。

## v0.4.3 - 2026-09-05

- Codex 切换链路性能优化：消除切换与切回官方时重复的全量数据重绘与模型映射分析，避免密集 DOM 渲染阻塞 WebView 消息循环。
- 平台状态检测异步化：将 `detect_platforms` 与 `restore_codex_official_config` 全面改为后台阻塞线程池执行，彻底防止 Windows 任务栏在切换时出现「未响应」。
- 切换进度平滑化：新增「正在刷新 Codex 状态…」阶段，保证 UI 界面状态更新连贯无卡顿。

## v0.4.2 - 2026-09-04

- Codex Desktop 注入优化：将平台切换与 Codex 重启注入中的重型进程探测、COM 激活和长连接等待全面切入后台工作线程池（`spawn_blocking`），彻底解决注入过程导致 AnyBridge 任务栏出现「未响应」的问题。
- Codex CDP 探测与超时改进：优化 CDP `/json` 探测超时粒度（1500ms），并将渲染进程就绪等待超时放宽至 25s，完美适配冷启动慢场景，避免误报「未就绪」。
- 提升注入连接稳定性与重试响应速度。

## v0.4.1 - 2026-09-04

- CPA Manager Plus: 修复更新/切换版本后提示「数据库升级维护尚未完成」的问题。启动、部署、更新前自动执行 `cleanup-derived` 离线完成新版本索引创建与派生数据清理。
- 修复 sidecar 模块打包兼容性问题：移除 top-level await，修复打包安装后代理启动失败的异常。
- 供应商模型列表自然排序：已选模型列表及模型分组内支持按名称自然字母数字升序排列（Natural Sort）。
- 平台与供应商页面交互与视觉优化。

## v0.4.0 - 2026-08-03

- Claude Code Unlock: payload 完全对齐 Claude Code CLI v2.1.220 真实抓包（beta 9→6，去掉 context_management 和 thinking.display）
- Claude Code Unlock: 内嵌 21 个 Claude Code 原生 tools 指纹，AnyRouter 端点校验通过
- unlock 逻辑优化：供应商未开启解锁时自动降级为普通协议，不再报错
- 移除按槽位名自动写入 unlock/apiFormat 的逻辑，避免 glm-5.2 等模型被误判
- 修复错误码语义：上游网络错误使用 unavailable，参数错误使用 invalid_argument
- 修复 sidecar 构建脚本：使用本地 @yao-pkg/pkg，避免调用全局旧版 pkg@5.8.1
- 协议推断回滚原有逻辑，跨平台 CLI 查找兼容 Windows/macOS/Linux
- 版本号同步所有 package.json、lockfile、Cargo.toml

## v0.3.23 - 2026-08-02

- Claude Code unlock: UA 升级到 2.1.220，payload 改用内置 CLI tools 列表（自动发现 + bundled fallback），不再透传 IDE 的 tools/systemPrompt，避免上游校验失败。
- 新增 `claude-code-cli-tools.js` 模块：从 CLI 二进制自动提取 tool names，版本不匹配时触发发现，失败回退 bundled 列表。
- NODE_EXTRA_CA_CERTS 管理：代理启动时自动设置环境变量（Windows setx / macOS launchctl / Linux environment.d），停止时清除，解决 Node.js gRPC TLS 不信任 MITM CA 导致 `bad_certificate` 问题。
- 内置模型目录新增 Claude Opus 5 全系列（low/medium/high/xhigh/max × fast）。
- model-map 自动迁移：新增内置模型后，已有 `model-map.json` 缺失 unlock 的槽位/注入项自动按 `builtin_models()` 的 provider 字段补全，无需用户手动重建映射。
- CONNECT 代理错误降级：非关键 host（feature flags、telemetry）的 ECONNRESET/EPIPE 降级为 debug 日志，减少噪音。

## v0.3.21 - 2026-08-01

- sidecar: 插件部署改为 NDJSON 流式输出实时进度；新增 `/__byok/invalidate-models` 端点，model-map 保存后立即清除 sidecar 缓存。
- sidecar: 运行时模型族与解锁类型匹配校验（GPT 模型不应使用 Claude Code 解锁，反之亦然），避免路由到错误端点导致 404。
- sidecar: 新增 Claude Opus 5 全系列模型目录（high/low/medium/max/xhigh × fast）。
- sidecar: `execCommand` 从 `new Promise(async)` 重构为 `async/await`，修复短命令多余省略号。
- 后端: 平台管理命令大幅扩展（+342 行），插件部署/停止/状态查询增强，支持 Docker 策略 `prepareStop`。
- 后端: 模型映射保存后调用 sidecar `invalidate-models` 清除缓存，使下次 Windsurf 心跳立即生效。
- 插件: grok2api 支持 Docker 部署策略（`docker compose up -d` / `down`），自动复制 `docker-compose.yml` 并替换端口。
- 插件: 新增 `plugin-schema.json` 插件元数据 schema 定义，grok2api 图标改为 `icon.svg`。
- 前端: 插件部署弹窗适配 NDJSON 流式进度展示；平台页、插件管理页、样式大幅增强。
- 工具: 新增辅助脚本（Cassia 油猴脚本、SSO 转 CPA 工具、Devin Workbench checksum 探针）与 Devin 工作流定义。

## v0.3.19 - 2026-07-27

- 修复百炼 TokenPlan 等非 `dashscope.aliyuncs.com` 域名使用 `/compatible-mode` 路径时，`normalizeOpenAIApiPath` 未补全为 `/compatible-mode/v1/chat/completions` 导致上游 404 的问题。通用 compatible-mode 路径补全不再依赖 host 白名单匹配。

## v0.3.18 - 2026-07-27

- 修复 Windsurf 等 Claude 槽位映射到 OpenAI 兼容供应商（如阿里云百炼、DashScope）时，`apiFormat` 被硬编码为 `anthropic` 导致请求路径错误（`/compatible-mode/v1/messages`）和上游 `Invalid argument` 错误。根因是 `preferredRouteForSlotTarget` 在供应商未开启解锁时硬编码协议格式，现改为运行时根据供应商 apiPath/host 自动推断。
- `inferApiFormatFromPath` 兼容 `/compatible-mode`（无尾部斜杠）路径识别，避免 DashScope 标准端点被遗漏。
- 新增 Codex / Claude Code 原生重试配置：从 `model-map.json` 的 `enhancement` 读取 `codexRequestMaxRetries` / `codexStreamMaxRetries` / `claudeMaxRetries`，写入对应配置文件（config.toml / settings.json），平台页 UI 支持直接修改并即时生效。

## v0.3.16 - 2026-07-20

- MITM 证书架构升级 — CA 与叶子证书分离：CA（`server.codeium.com.pem`）仅作信任根装入系统证书库，新增由 CA 签发的 end-entity 叶子证书（`mitm-leaf.pem` + `mitm-leaf-key.pem`）用于 MITM 呈现。严格 TLS 客户端（rustls/webpki）拒绝 CA 证书当服务器证书（CaUsedAsEndEntity），叶子证书彻底解决此问题。
- sidecar 证书加载优先叶子证书：hybrid-server.js 优先加载 `mitm-leaf.pem`，兼容旧布局降级。增加叶子证书链校验（非 CA 标志 + 由本地 CA 签发）。
- TLS 探针 `probe_mitm_tls` 重写：弃用 reqwest（经 HTTP 代理不应用自定义根证书，导致 UnknownIssuer），改用手动 CONNECT 隧道 + rustls TLS 握手，直接以磁盘 CA 严格校验叶子证书链，覆盖 CONNECT→MITM→mitm-health 全链路。
- MITM 运行时自检分级修复：sidecar 报告 MITM 未启用（证书加载失败）才强制重生证书；TLS 实链路探测失败仅静默重装当前用户 CA 并只重试一次，不再弹 UAC。
- `generate_certs_ex` 证书安装改走 `install_ca_with_options`：用户显式操作时提权装 LocalMachine\Root（UAC 授权后静默无安全警告），提权失败再降级 CurrentUser\Root。

## v0.3.15 - 2026-07-19

- 修复 Codex 第三方模型在选择器显示为「自定义」而不显示模型名：模型目录（`anybridge-model-catalog.json`）的模板克隆分支未覆盖模板的 `visibility: "hide"`，导致自定义模型被 Codex 模型白名单过滤（官方模型在内置白名单故正常）。按 spec 既有结论（CC-Switch 调研 4.11）在目录生成时强制 `visibility: "list"` + `supported_in_api: true`。
- 证书安装改回「提权优先」：安装 CA 时优先用 UAC 提权装到 `LocalMachine\Root`（提权进程安装根证书 Windows 不弹「安全警告」，实现自动提权 + 静默无感），提权失败再降级 `CurrentUser\Root`。修复 v0.3.12 改为 CurrentUser 优先后每次新装证书都弹 Windows「安全警告」对话框的问题（启动自检、生成证书、体检修复三条路径统一）。
- 修复代理启动失败「CONNECT/TLS 握手失败（CaUsedAsEndEntity）」：MITM 改为呈现由本地 CA 签发的独立 end-entity 叶子证书（`mitm-leaf.pem`），CA 仅作为信任根。严格 TLS 客户端（rustls/webpki）拒绝把 CA 证书当作服务器证书，旧版直接呈现 CA 证书导致启动实链路自检握手失败；升级后自动补齐叶子证书。
- 重写 MITM 实链路自检探针 `probe_mitm_tls`：改用手动 CONNECT 隧道 + rustls TLS 握手。reqwest 对「HTTPS 经 HTTP 代理」连接不会应用 `add_root_certificate` 自定义根证书（实测直连可验证、经代理报 UnknownIssuer），导致即使证书正确自检仍失败；新探针直接用磁盘 CA 严格校验叶子证书链并覆盖 CONNECT→MITM→mitm-health 全链路。
- 修复潜在「装证循环」：仅当证书文件本身损坏（PEM/私钥不匹配、写盘失败等）才强制重生；信任库安装失败（GPO/权限）不再触发重生，避免 fingerprint 变更导致的反复重装。
- 运行时 MITM 自检修复分级：sidecar 报告 MITM 未启用（证书加载失败）才强制重生；TLS 实链路探测失败只提权重装 CA 并仅重试一次。
- 补齐 `ui/index.html` 构建产物：IDE 模型清单来源（captured/api/builtin）徽章与提示在 v0.3.14 漏构建，本版同步。

## v0.3.14 - 2026-07-19

- Responses API 上游强制 `store: false`：`local-proxy` 在 extras 合并后硬写，`applyCodexUnlockRequiredFields` 同步强制，避免 `preserveExtraParams`/客户端把 `store: true` 透传到三方网关落盘。
- 补充回归测试：Codex unlock 与 `preserveExtraParams` 路径均断言 `store: false`。
- MITM 证书校验增强：证书/私钥匹配、有效期、CA 标志与 SAN 检查；启动前 `ensure_proxy_mitm_ready`，失败时明确 503 而非静默隧道。
- 代理健康检查：`/__byok/stats` 上报 MITM 状态，新增 `/__byok/mitm-health` 与 CONNECT/TLS 实链路探测；MITM 失败可自动重生证书并仅重试启动一次。
- Codex 桌面：`preserveOfficialAuth` 与 `injectModels` 互斥（preserve 优先），前后端 CDP watcher/restart 逻辑对齐。
- 模型映射 UI：展示 IDE 模型清单来源（captured/api/builtin）徽章与提示，降低「刷新 API 仍不等于 IDE 下拉」的误解。

## v0.3.13 - 2026-07-19

- CPA 套件更新健壮化：下载超时 15s→300s，增加停滞检测与文件大小校验。
- 下载镜像每源重试 2 次（指数退避 4s→8s），避免偶发网络抖动导致整源放弃。
- 服务停止改为两阶段：先优雅关闭（WM_CLOSE/SIGTERM），等 2s 后才强制 kill。
- 健康检查改为指数退避（1s→2s→4s→8s→cap 10s），CPA 重试 30 次、CPAMP 20 次。
- 端口释放等待 10→20s，解压前清理目标目录残留。
- 证书生成命令 `generate_certs` 增加 60s 超时保护，避免 UI 阻塞。
- 证书安装优先 CurrentUser\Root 静默安装，失败回退 LocalMachine\Root。

## v0.3.12 - 2026-07-19

- 证书生成命令 `generate_certs` 增加 60s 超时保护，避免 UI 阻塞与 "Step is still running"。
- 证书安装优先使用 CurrentUser\Root 静默安装（无需 UAC），失败时回退 LocalMachine\Root 并提示管理员权限。
- 清理遗留证书与过期指纹，避免冲突。
- 健壮化首次安装 / 多用户 / 路径探测逻辑。
- UI 样式与健康检查流程优化。

## v0.3.10 - 2026-07-18

- CPA 套件支持出站代理配置：跟随系统代理 / 自定义 URL / 直连。
- 扩展设置面板可查看生效代理，并支持保存或保存并重启 CPA。
- 启动与写入 `config.yaml` 时自动同步 `proxy-url`。

## v0.3.9 - 2026-07-18

- 修复新机切换 Codex 供应商失败：`models_cache.json` 缺失时回退到内嵌 `gpt-5.5` 完整模型模板。
- `read_codex_model_template` / `generate_model_catalog_json` / `write_models_cache` 统一缓存优先、bundled 兜底，不再要求先启动 Codex CLI。

## v0.3.8 - 2026-07-18

- 修复 WorkBuddy / CodeBuddy 自定义模型展示名：`name` 改为供应商名（如 `CPA`），不再与 `id`（模型 ID）重复；客户端并排展示为 `CPA · grok-4.5`。
- 修复新版 WorkBuddy / CodeBuddy 自定义模型识别：`vendor` 固定写为 `user`（此前写成供应商名会被归到第三方模型并可能覆盖官方同名模型）；加载/保存时自动迁移历史配置。
- 同步调整 Rust `buddy_display_name` 与前端 `cbBuildModelEntry` 的生成逻辑。

## v0.3.7 - 2026-07-16

- 新增 per-provider 上游并发闸门（`providerInflightGate`）：按 `provider|host|model` 限制 inflight 请求（默认 8，`BYOK_MAX_INFLIGHT=0` 关闭）。
- Chat 全路径接入：buffered 走 `run()`，streaming 走 `acquire()` + 幂等 `freeOnce()`，并在 end/close/error/重试前释放槽位。
- local-proxy 同步接入并发闸门与 `attachUpstreamWatchdog`，流式槽位保持到响应体结束，避免长流打爆上游。
- 统一上游超时策略（TTFB / idle / hard），替换原先单一 `setTimeout`。
- 修复 WorkBuddy 模型 id/展示名与 `useCustomProtocol` 同步逻辑，避免 `model=byok-xxx` 与路径拼接错误。

## v0.3.6 - 2026-07-15

- 修复 Codex 三方供应商 auth 模式冲突：`requires_openai_auth` 与 `experimental_bearer_token` / `env_key` / `auth` 互斥写入，避免残留 OAuth 导致 bearer 无效。
- 新增 `apply_codex_provider_auth`，统一 `apply_codex` / `apply_codex_official` 的 auth 写入与清理逻辑，并补齐回归测试。
- 修复 Codex 历史会话可见性：同步修复 rollout / archived_sessions 与 official state sqlite 中的 `model_provider`，避免重启后索引回滚。
- 平台页增加「修复会话历史」操作与切换提示，说明统一会话历史与索引修复行为。
- 修复 Devin/Windsurf BYOK 上游失败时错误 HTML/原始 body 被当作 assistant 正文写入会话上下文的问题。
- 恢复默认使用 Connect-RPC 原生流错误帧（`BYOK_NATIVE_ERRORS=true`），避免错误进入聊天上下文与会话标题。
- 清洗 Cloudflare/HTML 错误页：只提取短可读摘要，不再透传整页 HTML。
- 增强扩展中心 CPA Suite 更新稳定性：GitHub Release 获取重试、更新失败回滚旧服务。

## v0.3.3 - 2026-07-14

- 统一 Codex 路径解析：移除脚本与错误消息中的机器相关硬编码路径，改为优先读取 `CODEX_HOME`，否则回退到 `~/.codex`。
- 新增 sidecar 共享模块 `codex-home.js`，对齐 Rust `codex_home()`，供 catalog 读写、auth.json 定位与 CDP 注入复用。
- 修复 `gen-catalog`、`platforms`、`codex_desktop` 与 sidecar 注入逻辑在非默认 Codex 目录下的路径解析问题。
- 错误提示改为展示实际解析路径，便于排查缺失的 `models_cache.json` / `anybridge-model-catalog.json`。

## v0.3.2 - 2026-07-13

- 修复 CPA Manager Plus 登录失败问题：确保 `secrets.json` 中的 `admin_key` 与 CPAMP 数据库密钥同步。
- 新增 `reset_cpamp_admin_key` 函数，在启动/部署/更新/切换版本前自动执行 `reset-admin-key` 同步数据库密钥。
- 修复每次更新 CPA Suite 时密钥丢失的问题：部署前检查 `secrets.json` 是否已存在，存在则复用旧密钥。
- 修复 CPAMP 内部数据（反代凭据、面板历史、OAuth token、usage.sqlite、data.key 等）在更新或切换版本时丢失的问题。
- 新增共享数据目录 `cpamp-data/`，将 `dataDir` 从版本目录内的 `./data` 改为 CPA Suite 根目录下的共享路径。
- 新增 `migrate_cpamp_data` 函数，首次使用共享目录时自动从旧版本 `data/` 迁移全部文件。
- 通过环境变量 `USAGE_DATA_DIR`、`USAGE_DB_PATH`、`CPA_MANAGER_DATA_KEY_PATH` 确保所有路径一致。
- 优化模型映射编辑器 UI：将"映射自定义显示名"和"上下文窗口"配置区从底部移到右列顶部，简化为一行布局。
- 精简上下文窗口预设按钮：仅保留推荐、200K、1M，移除 32K/128K/清除。
- Windows 平台调用子进程时加入 `CREATE_NO_WINDOW` 标志防止黑窗。

## v0.3.1 - 2026-07-12

- 修复 CPA Manager Plus 1.10+ 登录失败：`admin_key` 在首次启动后被持久化到 SQLite，后续启动不再读取环境变量，新增 `reset_cpamp_admin_key` 函数在启动前同步密钥。
- 部署时复用已有 `secrets.json` 避免每次更新生成新密钥。

## v0.3.0 - 2026-07-11

- 重构前端架构：将 `index.html` 拆分为 partials 模板，引入轻量 HTML 构建流程（`scripts/build-ui.mjs`）。
- 迁移内联事件处理器为 `data-action` 事件总线模式，前端脚本改为 ES Module 加载（`main.js`）。
- 提取共享 API/UI/State 模块（P4 架构 slice），改善代码组织与可维护性。
- 新增 model-context-presets 模型上下文预设功能，支持自定义模型上下文窗口配置。
- 增强 Rust 后端命令模块：codex_desktop、platforms、extensions、system 命令全面升级。
- 优化 local-proxy 代理逻辑，提升请求转发稳定性。
- 更新平台页面与弹窗模板（CodeBuddy/Codex/Proxy/WorkBuddy/ZCode），改进 UI 交互体验。
- 增强前端脚本：platforms、extensions、shell、runtime、providers-eval 等模块功能扩展。
- 更新页面、弹窗、平台样式，优化视觉一致性。
- 更新 gen-catalog 目录生成脚本，扩展目录构建能力。
- 重构 CPA 凭证面板：将 CPA API（API Key、API 地址）与 CPA 管理面板（管理面板、管理密钥、面板地址）分区显示，新增 API 地址行，提升可读性。
- 更换模型筛选「推理」Tab 图标为大脑（brain）图标，更贴合思考/推理语义。
- 优化平台页面样式与代理页面交互细节。
- 引入按钮颜色变体系统（accent/secondary/danger/success/warn），统一全站按钮视觉语义。

## v0.2.8 - 2026-07-09

- 新增扩展中心（Extensions Center）UI：统一浏览、检测、更新 CPA Suite 等本地 AI Gateway 组件状态。
- 后端新增 `extensions` 命令集与相关依赖，支持本地套件版本检测、端口健康探测与 GitHub Release 元数据查询。
- 同步前端样式与交互资源，改进 UI 细节与扩展页面体验。

## v0.2.7 - 2026-06-30

- 修复 Windows 自动更新安装时可能被后台代理进程占用，导致无法覆盖安装的问题。
- 更新安装前会自动暂停本地代理服务，减少需要手动退出或结束进程的情况。
- 优化安装包升级流程，提升从旧版本升级到新版时的稳定性。

## v0.2.6 - 2026-06-30

- 完善项目说明与截图展示，帮助新用户更快了解 AnyBridge 的使用场景和主要能力。
- 补充 Kite 插件介绍，支持配合 Devin / Windsurf 使用，提供号池、界面汉化和体验增强等扩展能力。
- 优化多平台安装包发布信息，Windows、macOS、Linux 用户可通过自动更新或下载页获取新版。
- 改进更新弹窗展示文案，公开更新说明仅保留面向用户的功能变化。

## v0.2.5 - 2026-06-30

- Synchronized release version across npm, sidecar, Cargo and Tauri metadata from `0.2.4` to `0.2.5`.

## v0.2.4 - 2026-06-30

- Synchronized release version across npm, sidecar, Cargo and Tauri metadata from `0.2.3` to `0.2.4`.

## v0.2.3 - 2026-06-30

- Prepared a new packaged build and synchronized the release version across npm, sidecar, Cargo and Tauri metadata from `0.2.1` to `0.2.3`.

## v0.2.1 - 2026-06-29

- Fixed third-party image understanding being bypassed under the Codex/Responses protocol so the Codex desktop, Codex CLI, OpenAI Chat, Anthropic and Cursor/Windsurf paths now all reach the image-understanding provider as expected.
- Added an upstream self-heal retry module (`sidecar/lib/self-heal.js`) with three rectifiers (thinking signature, thinking budget, unsupported image), wired behind the existing `local-proxy` execution path; aligned with the cc-switch rectifier behavior.
- Added an experimental Cursor MITM proxy (`sidecar/cursor-proxy.js`) plus `cursor_auth` state backup / restore (`src-tauri/src/commands/cursor_auth.rs`) to support the Cursor BYOK flow.
- Added regression tests for `codex-unlock`, `config-cache` and `self-heal`, and a `scripts/check-cursor-proxy.mjs` diagnostic for the new Cursor handler.
- Bumped the synchronized version (`package.json`, `package-lock.json`, `sidecar/package.json`, `sidecar/package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) from `0.2.0` to `0.2.1`.

## v0.2.0 - 2026-06-28

- Added Codex desktop integration: CDP-based unlock, local proxy routes, Chat mode support, and custom model entry through the new `codex-desktop` command family.
- Refactored the proxy routing layer to a platform-driven architecture, with `proxy_routes` / `platforms` / `model_map` command modules and per-platform model picking.
- Improved platform submenu and shell layout behavior; cleaned up the legacy `99-handle-tuner.js` script.
- Strengthened configuration and IDE configuration flows, including platform raw config editors, custom model mapping UI, and provider evaluation reports.
- Added new script tooling: `check-providers`, `check-opencode`, `check-cursor-proxy`, `find-codex-format`, `show-codex-configs`, `list-providers`, `test-upstream`, `check-mitm-logs`, and `add-opencode-codex-config` for the open-source baseline.
- Hardened the release flow with the protected sidecar builder, MITM log checks, self-heal module, and `codex-unlock` regression tests.
- Fixed legacy version-line migration so the open-source `0.x` line can replace the historical `1.x` line through the updater.

## v0.1.6 - 2026-06-25

- Fixed vision capability evaluation falsely reporting "unsupported" for reasoning vision models (e.g. GLM-4.5V) by increasing `max_tokens` from 64 to 1024 in the eval test request, allowing reasoning models to complete their chain-of-thought before producing the actual answer.

## v0.1.5 - 2026-06-24

- Changed Devin/Windsurf stream failures to surface upstream error text by default instead of relying on IDE-native generic provider error UI.
- Reclassified upstream load-limit and `get_channel_failed` responses as rate-limit errors for OpenAI/Anthropic-compatible local proxy calls while preserving the original upstream body.

## v0.1.4 - 2026-06-23

- Fixed upstream proxy handling on Windows so AnyBridge follows the live system proxy switch instead of a stale startup snapshot.
- Added loopback proxy compatibility for local proxy cores that listen on IPv6 `::1` while Windows stores `127.0.0.1`.

## v0.1.3 - 2026-06-23

- Fixed provider sorting controls on CodeBuddy, WorkBuddy, and ZCode add-model pages.
- Improved provider routing, unlock compatibility, cache usage reporting, and certificate setup flows.

## v0.1.0 - 2026-06-21

- Reset the open-source project line to `0.1.0`.
- Cleaned historical notes, private diagnostics, temporary probes, screenshots, and legacy brand files out of the public tree.
- Added standard open-source project files, GitHub templates, CI, security policy, and public documentation.
