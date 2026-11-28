# 内部变更记录

> 这是**对内**的技术流水账：根因、实现细节、涉及文件、验证方式。
> **对外**给用户看的更新说明在根目录 `CHANGELOG.md`——那份会被 CI 提取成
> Release notes，直接显示在客户端更新弹窗里，禁止出现代码标识符、文件路径、
> 日志级别、内部术语。
>
> 分工规则：
> - `CHANGELOG.md`：一屏能读完、用户能看懂、只讲"你会得到什么"。一个版本 2-4 条。
> - 本文件：可以写 `hudsucker=debug`、`passthroughParams`、栈追踪、判据与测试名。

## v1.1.19（增强插件 Windows 目录占用容错与非监听区暂存修复）

- **暂存区隔离与目录替换兜底（`src-tauri/src/commands/enhance.rs`、`src-tauri/src/commands/enhance/native_plugins.rs`）**：
  1. 实测定位到 `Antigravity` (`language_server.exe`) 与杀软过滤驱动（`360FsFlt` / `sysdiag`）对 `~/.gemini/config/plugins/` 持有目录监听与文件扫描锁，导致整目录 `MoveFileExW`（`fs::rename`）即使同盘也报 `os error 5`（`拒绝访问`），且刚写入的 77 个文件在立刻执行 `fs::remove_dir_all` 时会因空子目录句柄尚未释放短暂报 `os error 32`。
  2. 将 `install_native_plugin` 临时解压暂存区从 `plugins/.{dir}-staging-{pid}` 移出至外层 `cfg_dir/.{dir}-staging-{pid}`，完成完整树结构校验后再部署，避免解压阶段惊动客户端热加载监听；若外层跨卷 `EXDEV` 也统一由下层同步逻辑接管。
  3. 重构 `replace_dir_atomically` 并抽取共享 helper `retry_transient_fs` / `remove_dir_with_retry` / `copy_file_with_retry` / `prune_stale_entries` / `sync_dir_from_staging`：整目录 `rename` 遇 `os error 5/32/33/145` 先经 `RENAME_BACKOFF_MS` 短退避重试（`50/100ms`），仍受阻或跨卷时退化为 `sync_dir_from_staging`（清只读属性、逐文件覆盖并裁剪目标内过时旧项，全新安装中途失败自动清理，已备份场景失败自动回滚）；`uninstall_native_plugin` 与目录清理同步切至 `remove_dir_with_retry`（`IO_BACKOFF_MS` 累计至 4.5s）。
- **验证方式**：
  1. `src-tauri/src/commands/enhance/tests.rs` 新增 `replace_dir_atomically_and_dir_sync_handle_fresh_reinstall_readonly_and_stale_prune` 与 `native_plugin_zip_staging_and_reinstall_roundtrip_outside_plugins_dir`。
  2. 在运行中 `Antigravity.exe` + `language_server.exe` 真机环境下完成四款插件实测：`antigravity-usage-monitor` (`v1.5.6`) 在真机 `~/.gemini/config/plugins/` 临时目录连续 3 次完成解压/覆写更新/卸载全链路，`antigravity-context-viewer` (`v0.9.3`) 完成隔离 `app.asar` 安装/状态/还原及锁占用校验，`antigravity-codex-theme` (`v1.4.3`) 与 `chuanban-antigravity-theme-patch` (`v6.0.6`) 完成隔离沙箱安装与卸载，并通过全量 `npm run verify`。

## v1.1.18（增强插件百分比大图、多列截图表格与中文回退修复）

- **图片百分比宽度误截断修复（`ui/assets/scripts/platforms/antigravity_enhance_render.js`、`antigravity-enhance-detail.css`）**：
  1. 修复 `createCleanImageNode` 使用 `parseInt("100%", 10)` 将 `<img width="100%" />` 误截为 `width="100"` 像素导致 `antigravity-usage-monitor` 预览图及 `IDE 与 CLI` 截图被压成 100px 缩略图的问题；抽取统一尺寸解析器 `parseSafeDimension` 与 `buildSafeImageProps` 同时服务在线 DOM 清洗与降级 Markdown 渲染，严格区分百分比（`is-full-width` 或受控百分比样式）与纯像素尺寸（`<= 128px` 标为 `is-inline-logo` 去框）。
  2. 将 `star-history.com` 从 `isBadgeImageUrl` 移除，防止 Star History 趋势图表被误压成 20px 高徽章；扩展降级 Markdown URL 正则支持含成对括号的徽章链接（如 `node >=22.0.0 (22.13+ Full)`）。
  3. 保留 `td/th` 安全百分比列宽（如 `33.3%`）并为全百分比列表格加 `.is-fixed-layout`，同时在降级 Markdown 解析器抽取顶层 `<table>...</table>` 交由 `sanitizeEnhanceGithubHtml` 统一渲染并保留 `<sub>`/`<sup>`，使三栏面板截图在弹窗内等分并排且不横向溢出。
- **中文 README 在线抓包 504 兜底（`src-tauri/src/commands/enhance/github_detail.rs`）**：`fetch_github_blob_rendered_html` 增加 1 次重试并回退 `?plain=0` HTML `<article class="markdown-body">` 解析；若网页接口仍不可达但主页非中文且存在中文 `README`，自动切到镜像中文 Markdown 渲染，避免退回全英文页面。
- **验证方式**：红-绿回归单测（`scripts/antigravity-settings-and-enhance.test.mjs`）、真实 Chromium 加载 `yuhuan-dev/antigravity-usage-monitor` 实测像素与三图截图（Logo `84x84`、预览与 `IDE`/`CLI` 图 `795–821px` 满宽、三栏表格均分 `249x346px`、Star History 图表 `802x535px`）及全量 `npm run verify`。

## v1.1.17（增强插件 GitHub 详情叠层模态框与在线渲染重构）

- **GitHub 在线官方渲染 HTML 拉取与受控图片代理（`src-tauri/src/commands/enhance/github_detail.rs`、`enhance.rs`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`）**：
  1. 解决 `api.github.com` 匿名 60 次/小时限流与手写正则 Markdown 解析缺陷：并发抓取 `api.github.com/repos/{repo}` 与 `https://github.com/{repo}` 页面，直接提取 GitHub 官方服务端渲染的 `<article class="markdown-body">` 与基础元信息；首页非中文时自动通过 `GET /blob/{branch}/{README.zh-CN.md|README_zh.md|README_CN.md}` (`Accept: application/json`) 提取 `payload.codeViewBlobRoute.richText`；断网/不可达时自动降级到 `raw.githubusercontent.com` + 镜像链 Markdown。
  2. 更新 `tauri.conf.json` CSP 放开 `img-src 'self' data: https:` 与 `media-src 'self' https:`，根治 WebView2 拦截所有远程 GitHub 截图、徽章与演示视频的问题；新增白名单受控命令 `get_enhance_github_image`（仅放行 GitHub/shields/badgen 白名单域名、6 MB 上限、MIME/魔数校验、15 分钟内存缓存、复用系统代理与镜像链），供前端在直连受阻时无感切换 `data:` URI 兜底。
- **叠层二级模态框、DOM 白名单清洗器与滚动根因修复（`ui-src/partials/pages/platform-antigravity.html`、`ui/assets/scripts/platforms/antigravity_enhance_{catalog,render,detail}.js`、`antigravity_enhance.js`、`antigravity-enhance-detail.css`、`55-platforms.js`、`scripts/check-ui.mjs`、`ui/assets/i18n/{zh-CN,en-US}.js`）**：
  1. 将原内联替换式详情视图重构为独立叠层二级模态框 `#antigravityEnhanceDetailModal`（`z-index: 10020`）+ 截图放大灯箱 `#antigravityEnhanceImageLightbox`（`z-index: 10040`），打开详情时底层插件列表保持完整可见，按 Escape / 点击遮罩仅关闭当前顶层弹窗。
  2. 根治无法滚动问题：将 `.enhance-detail-scroll` 从 `display: flex; flex-direction: column` 改为 `display: block; flex: 1 1 auto; min-height: 0; overflow-y: auto`，且 `.enhance-detail-readme-card` 改 `overflow: visible`（消除 `flex-shrink: 1` 叠加 `overflow: hidden` 锁死高度导致 `scrollHeight === clientHeight`）。
  3. 抽出 `antigravity_enhance_render.js` 实现基于 `DOMParser` 的严格白名单 HTML 清洗器 `sanitizeEnhanceGithubHtml`（剥离 `script`/事件属性/危险协议/GitHub `.anchor` 图标，规范化 `/raw/` 相对图，支持 `<picture>` 主题适配、`<video controls>`、`<details>`、GitHub Alerts 与页内锚点平滑跳转），并同步修复降级 Markdown 解析器的 HTML `<h1>`/`<code>`、引号内 `>=` 截断与占位符泄漏问题。
- **验证方式**：Rust `enhance::tests`（14/14 含域名白名单与 HTML/MIME 提取单测）、Node `scripts/antigravity-settings-and-enhance.test.mjs`（叠层模态框、降级 Markdown、在线 HTML 安全清洗与 Escape 隔离测试）、真实 Chromium 加载 `nkjDSLcvanv/antigravity-codex-theme` 线上页面验收（18/18 图全出、`scrollHeight: 8217 / clientHeight: 635`、演示视频与亮色视觉截图核验）及全量 `npm run verify`。

## v1.1.16（Antigravity 增强插件体系与反代工具/MCP全链路修复）

- **Antigravity 反代工具与已安装插件/MCP 无法调用根因修复（`sidecar/lib/antigravity/{mocks-and-handshake,official-forwarder}.js`、`sidecar/lib/antigravity-handler.js`、`sidecar/local-proxy.js`、`sidecar/lib/local-proxy/{normalize,tool-name-codec,openai-anthropic-payload,upstream-payload,stream-attempt}.js`、`sidecar/lib/{gemini-schema,upstream-decoder,codec-registry}.js`）**：
  1. 真机抓包定位纯 BYOK 模式及混合模式回退对 `/v1internal:listExperiments` 返回空 `{}`，导致客户端关闭 `enable-agent-plugins-spec`、`mcp-lazy-load-tools`、`enable-customization-kind-*` 与 `agy-plugin-marketplaces`，抹除 `<mcp_servers>` 并砍掉 `call_mcp_tool`、`invoke_subagent`、`run_workflow`、`update_steps` 等 6 类核心工具；新增 `mockAntigravityListExperiments`（纯 BYOK 下自动令子代理继承活跃 BYOK 模型）与 `ensureAntigravityExperiments` 补齐实验开关基线。
  2. 修复 `normalizeGeminiTools`、`geminiTools` 与 `buildGeminiNativePassthroughPayload` 忽略 `parametersJsonSchema` / `parameters_json_schema` 导致 Eager MCP 与新版工具参数退化为空对象的问题；在 `normalizeToolParameters` 与 `sanitizeGeminiSchema` 中将 Protobuf JSON 序列化的字符串数值约束（如 `minLength: "1"`、`maxItems: "12"`）统一转为 `Number`，并为 `call_mcp_tool.Arguments` 等无 `type` 子属性补齐 `OBJECT`，根治严格校验上游返回 400。
  3. 新增 `buildCrossProtocolToolNameCodec` 为含 `:` / `.` 的工具名提供 OpenAI/Responses/Anthropic 出站无损编码与流式/非流式回包原名还原；修复 `messagesForNonGeminiUpstream` 无 `id` 同名并行工具调用 ID 碰撞、提取 `functionResponse.parts` 文本/图片并过滤纯 `thought` 空消息；加固 `forwardToOfficialAntigravity` 全分支 `res.headersSent || res.writableEnded` 守卫防止触发 `ERR_HTTP_HEADERS_SENT` 崩溃。
  4. 新增 `sidecar/antigravity-tools-and-plugins.test.js`（5 组端到端与单元回归测试）及 `docs/pitfalls.json` 两条判据（`ag-list-experiments-empty-disables-plugins-and-mcp`、`ag-tool-schema-jsonschema-string-ints-and-name-codec`），并通过本机 `agy.exe` 纯 BYOK 真机工具/MCP 实测验收。

- **CDP 零改包主题插件接入（`src-tauri/src/commands/enhance/cdp_themes.rs`、`system/restart.rs`）**：声明式接入 `antigravity-codex-theme`（`nkjDSLcvanv/antigravity-codex-theme`，Node >= 22.13.0，自动识别已装 `antigravity-context-viewer` 时传入 `--without i18n`）与 `chuanban-antigravity-theme-patch`（`Anarcadia/chuanban-antigravity-theme-patch`，Node >= 22.0.0，从 `core/manifest.json` 读取版本）；状态探测校验 `core/daemon.mjs` + `user/config.json` `enabled != false` + OS 服务注册物完整生效链；安装任一款前自动卸载互斥对端。
- **Antigravity 2.0 原生插件接入（`src-tauri/src/commands/enhance/native_plugins.rs`）**：声明式接入 `antigravity-usage-monitor`（`yuhuan-dev/antigravity-usage-monitor`），优先拉取预打包 Release 资产 `usage-monitor.zip`（失败回退 tag 源码包），保留 `assets/logo.svg` 并原子部署至 `~/.gemini/config/plugins/usage-monitor`，同时原位合并写入 `~/.gemini/config/config.json` 的 `plugins["usage-monitor"].enabled = true`（遇损坏 JSON 显式拒写）；对称卸载移除目录与注册项并保留 `~/.gemini/antigravity/sidecar_data/usage-monitor/` 历史数据；`has_active_hub_cdp_consumer()` 纳入原生 CDP 插件供 `restart_ide` 保留 `--remote-debugging-port=0`。
- **双级冲突检测矩阵、站内 GitHub 详情视图与弹窗视觉重构（`src-tauri/src/commands/enhance/{conflicts,github_detail}.rs`、`ui/assets/scripts/platforms/antigravity_enhance_{catalog,detail}.js`、`antigravity_enhance.js`、`antigravity-enhance.css`、`55-platforms.js`、`scripts/check-ui.mjs`）**：收敛单一声明式冲突矩阵（`Exclusive` 硬互斥自动替换 + `Overlap` 功能重叠共存建议）；新增白名单受控 `get_enhance_github_detail` 命令（`raw.githubusercontent.com` + `mirror_candidates` 镜像链 + 10 分钟缓存 + 安全 Markdown 渲染）实现弹窗内直览 GitHub README 与预览图；弹窗改为严格三段式 Flex（独立滚动容器 + 默认收起的底部执行日志抽屉），根治 `.antigravity-enhance-list` 因 `min-height` 触发 `flex-shrink` 与日志区穿模叠加、以及关闭按钮受 `.btn-ghost { min-width: 84px }` 拉宽的问题；卡片改紧凑单行元数据与降噪重叠提示。

## v1.1.15（Antigravity IDE 全链路汉化修复）

- **路径契约修复（`app_localization/{mod,lang_pack,apply_and_keeper}.rs`）**：Antigravity IDE 的 `dataFolderName` 为 `.antigravity-ide`，扩展目录与 `argv.json` 位于 `~/.antigravity-ide`，仅 `languagepacks.json` 留在 `%APPDATA%/Antigravity IDE`。新增 `ide_home_dot_dir` 与 `ide_argv_path` 统一映射；还原路径同步回滚此前误写入 `ide_state_dir/argv.json` 的残留。
- **语言包兼容降级与 `-universal` 注册（`app_localization/{workbench_checks,lang_pack}.rs`）**：Open VSX 官方简体中文语言包无 `1.107.0` 仅提供 `1.106.0`，新增 `parse_semver_prefix` / `is_lang_pack_compatible` / `pick_compatible_lang_pack_version` 支持同主版本向下兼容最多 5 个次版本；新增 `register_language_pack_at` 优先从 `package.json` 取真实版本算 MD5 并指向真实解压目录。
- **首屏 6 秒白屏与词条补齐（`windsurf-localization-baseline.js`、`devin-localization-baseline.js`、`antigravity-ide-dictionary-baseline.json`）**：隐藏首屏下 `_abWaitReady()` 原读 `innerText` 按 HTML 规范恒为空串导致 60 次轮询超时，改用 `textContent` 后 3 秒内即显现；补充欢迎页缺失的 3 条词条（总计 2537 条）。
- **CDP 本地回环绕过代理与重启保活（`antigravity_cdp.rs`、`system/restart.rs`、`ui/assets/scripts/platforms/antigravity_localization.js`）**：`http_client()` 增加 `.no_proxy()` 防止 Windows 系统代理劫持 `127.0.0.1` 探测；新增 `is_antigravity_ide_ua` 与 `merge_antigravity_ide_cdp_args`，普通重启保活 `--remote-debugging-port` 并清除 `ELECTRON_RUN_AS_NODE`；前端去掉错误的语言包触发词库下载分支，使用 `setLoading`/`clearLoading` 并在重启后后台轮询补调设置页/面板 CDP 注入。
- **验证方式**：`lang_pack_tests.rs` 新增 4 条、`antigravity_cdp.rs` 新增/扩展 2 条、`system/tests.rs` 新增 1 条回归测试；通过独立隔离探针（`--user-data-dir` 与 `--extensions-dir` 在系统临时目录）验证 3 秒内显示已翻译欢迎页及 `extensionView=true` iframe 注入。

### 全链路二次巡检修复（8 项问题）
- **CDP 动态端口父目录读取与 Kite 端口跟随（`antigravity_cdp.rs`、`system/restart.rs`）**：抽出 `read_devtools_active_port_from_dir` 优先读 `%APPDATA%/Antigravity IDE/DevToolsActivePort`（`User/` 的父目录，Chromium/Electron `--user-data-dir` 根），仅将 `User/DevToolsActivePort` 作回退；`restart_antigravity_ide_with_cdp` 改为调用 `preferred_launch_port()` + `build_cdp_restart_args(port)`，不再写死 `9333`。
- **增强插件安装对称恢复汉化（`enhance.rs`）**：抽出 `restore_hub_patches_if_lost` 统一服务 `install_antigravity_enhance` 与 `uninstall_antigravity_enhance`，在 `cli.js` 重写 `app.asar` 后同时保留 BYOK 与 Hub 汉化补丁。
- **老代汉化升级备份保护与 IDE 目录隔离（`antigravity_localization/hub_patch.rs`、`app_localization/mod.rs`）**：抽出唯一判据 `code_has_hub_localization`（覆盖三代标记），阻止前两代旧汉化升级时覆盖 `app.asar.lang.bak`；移除 `platform_meta("antigravity-ide")` 中回退 `"Antigravity"` 的候选名，防止误写桌面端 `%APPDATA%/Antigravity`。
- **接入策略弹窗全链路打通与交互并发保护（`config/types.rs`、`mocks-and-handshake.js`、`catalog-models.js`、`local-proxy.js`、`antigravity_{modals,add,enhance,localization}.js`、`i18n/{zh-CN,en-US}.js`）**：打通 `antigravitySettingsModal` 读写 `antigravityContextWindow` 与 `antigravityMockCredits`（同步现有与新增模型 `contextWindow`，并由 `resolveAntigravityQuotaPolicy` 控制 `retrieveUserQuota*` 配额伪装与模型目录默认窗口）；`loadAntigravityEnhanceData` 补齐 `loadSeq` 防切换乱序覆盖；重启日志改用精确 i18n 文案。
- **新增回归单测**：Rust 新增 5 组单元测试（`antigravity_cdp.rs`、`enhance.rs`、`antigravity_localization/tests.rs`、`app_localization/tests.rs`、`system/tests.rs`）；Node 新增 4 个用例（`sidecar/antigravity.test.js`、`scripts/antigravity-refresh-and-isolation.test.mjs`）；`docs/pitfalls.json` 补入 `ag-ide-devtools-port-parent-dir` 与 `ag-hub-enhance-and-legacy-backup-symmetry`。

### 增强插件弹窗独立化、GitHub 在线拉取与双端分离重构
- **消除硬编码路径与阻塞探测（`enhance.rs`、`plugin_asset.rs`、`extensions/`、`hygiene-and-portability.mjs`）**：移除开发机本地路径硬编码并扩充路径可移植守卫规则；改用直接读取 `app.asar` 头与 `dist/meter-manifest.json` 毫秒级探测，消除同步 Node 子进程阻塞；新增 `check_antigravity_enhance_update` 与 GitHub Release tag 压缩包自动拉取解压（经 `extract_zip_filtered` 过滤非运行期资源），子进程统一走 `HideWindow` 与 `env_remove("ELECTRON_RUN_AS_NODE")`。
- **剥离式还原共存保护（`antigravity_localization/hub_patch.rs`、`tests.rs`）**：抽取 `read_asar_header` / `read_asar_node_text` / `write_asar_preload` / `strip_hub_localization_code`，当 `app.asar` 存在第三方增强补丁或缺失 `.lang.bak` 时执行就地剥离而非覆盖还原；新增 `restore_hub_asar_strips_in_place_preserving_third_party_preload_and_utils` 等单测。
- **双端独立弹窗、导航高亮与原项目命名（`platform-antigravity.html`、`antigravity-enhance.css`、`antigravity_enhance.js`、`antigravity_console.js`、`platform-rail.js`、`cursor_add.js`、`hero_and_agents.js`、`i18n/{zh-CN,en-US}.js`、`scripts/antigravity-settings-and-enhance.test.mjs`）**：修复 `syncPlatformRailForPage` 与 `openPlatformPage` 点击 `Antigravity IDE` 后高亮被重置回桌面端的导航 Bug，移除回归的 `#antigravity-platform-subtitle` 并在版本切换时先清空旧 DOM；拆分为完全独立的 `#antigravityEnhanceModal` 与 `#antigravityIdeEnhanceModal`，桌面端聚焦内置汉化的 `antigravity-context-viewer` 单卡（移除冗余桌面汉化卡片与检测，启用 `is-single` 自适应窄宽），IDE 端保留 `Antigravity-Chinese-Localization` 与 CDP 注入卡，有上游原项目的插件一律显示原项目名并附仓库按钮。

## 未发版（v1.1.14 跨平台门控与 CI 全绿加固）

### 根因复盘：v1.1.14 连续 4 轮非 Windows 发布失败 + HEAD 三平台 CI 隐性全红
1. **5 处非 Windows 编译错误全部源自 `2f54ce25` 大文件拆分 + 本地守卫盲区**：
   - `cursor-core/src/local_app/ca/mod.rs`（`#[cfg(unix)]` 内 `from_mode` 缺 `PermissionsExt`）、`src-tauri/src/commands/system/ide_paths.rs`（`#[cfg(not(windows))]` 内裸写 `Command::new` 缺导入）；
   - `src-tauri/src/commands/version_probe/mod.rs` 与 `codex_desktop/launch_and_http.rs`（拆走函数遗留孤悬 `#[cfg(windows)]` + 空行吸附到下一个跨平台函数 `installed_version` / `kill_codex`）；
   - `src-tauri/src/commands/version_probe/gui_probe.rs`（`running_process_dir_matching` 丢 `#[cfg(windows)]`，旧 `runPlatformGuards` 往前盲扫 80 行命中前一个函数的 `#[cfg(windows)]` 假阳性放行，且未扫 `cursor-core`）。
2. **补修 HEAD 仍残留的 5 处同源问题**：
   - 清理 `codex_desktop/mod.rs`（挪回错位的 `http_get_local` 注释、消除孤悬 `#[cfg(target_os = "windows")]` 空行）与 `usage_scan/mod.rs`（消除 `#[cfg(test)]` 后空行）。
   - 修复 `scripts/check-antigravity-endpoint.mjs` 真执行未设置 `USERPROFILE`/`HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME` 导致 Linux/macOS CI 必红的缺陷。
   - 修复 `scripts/antigravity-refresh-and-isolation.test.mjs` 写死 TTY 专用 `ℹ pass 12` 导致 Windows CI（非 TTY TAP 输出）必红的缺陷，改用显式 `--test-reporter=tap`。
   - 修复 `.github/workflows/ci.yml` 把 `verify.log` 写到仓库根目录被自家 `runTempFileDiscipline` 自动搬进 `tmp/` 导致 `Verify report` 报错失明的问题；CI 与 `release.yml` 临时日志统一改写到 `$RUNNER_TEMP`，并将非 Windows `--release` 预检扩展到 **Linux + macOS** 且同时覆盖 `cursor-core` 与 `src-tauri`。
   - `scripts/check-release-gate.mjs --remote` 增加当前 HEAD 的远端三平台 CI 通过校验，防止 CI 未绿即推 tag。
3. **本地跨平台静态守卫升级与回归锁**：
   - `scripts/lib/key-features/hygiene-and-portability.mjs` 升级 `runPlatformGuards`（导出 `auditRustPlatformGuards` / `scanRustPlatformGuards`）：词法级大括号作用域 + 模块级 `#[cfg]`/`#[path]` 识别（覆盖 `src-tauri` + `cursor-core` 412 文件）、硬禁孤悬 `#[cfg(...)]`、硬检非 Windows 分支缺失 `PermissionsExt` / 裸 `Command::new`。
   - 新增 `scripts/platform-guards.test.mjs`（含 5 处事故精准复现 fixture + `win32`/`darwin`/`linux` 三平台注入真执行模拟 + CI/Release 门控断言），并沉淀 2 条结构化坑点进 `docs/pitfalls.json`（`rust-refactor-cfg-blindspot-and-window-guard`、`ci-verify-cross-platform-env-and-log-collision`，共 90 条）。

## v1.1.14 - 2026-11-19（全端架构重构与 Devin 3.14 适配发版）

### 第三波：Devin 3.14.30825 适配与边界加固

1. **Sidecar 协议改写与 TLS 诊断**：
   - `sidecar/lib/rename/proto-rewrite.js` 抽出 `unwrapModelPayload` 统一兼容 `plain` / `gzip` / `connect` / 裸 `application/proto`，`sidecar/rename-models.js` 的 `rewrapUserStatusPayload` 对裸 `proto` 原样输出不套 Connect 帧头。
   - `sidecar/lib/tls-diagnostics.js` 与 `sidecar/hybrid-server.js` 增加单次 `tlsSocket.on('secure')` 与 `isPreHandshakeDisconnect` 握手前断连诊断日志，证书未信任时显式记录断开原因。
2. **Rust 配置对称、无备份升级与重启超时**：
   - `src-tauri/src/commands/ide_config/mod.rs` 为 Devin 补齐 `http.proxySupport = "override"`、对称维护 `devin/config.json` 的 `process_model = "in-process"`（经 `parse_object_with_label` 精准报错文件名），新增 `strip_managed_proxy_for_backup` / `write_stripped_backup` 修复无 `.byok-bak` 升级污染。
   - `src-tauri/src/commands/system/restart.rs` 新增 `run_command_with_timeout`（50ms 轮询 + 4s 超时 `child.kill()`）保护 `stop_devin_daemon_if_running`。
3. **判据与回归**：
   - `docs/pitfalls.json` 新增 `devin-bare-proto-model-rewrite` 与 `devin-daemon-proxy-override-and-legacy-backup-strip`（共 88 条），回归测试覆盖 `sidecar/rename-models.test.js`、`sidecar/lib/tls-diagnostics.test.js`、`src-tauri/src/commands/ide_config/tests.rs` 与 `src-tauri/src/commands/system/tests.rs`。

### 第二波：全仓大文件清零、去冗余收敛与工作区净场

1. **Rust 后端与 `cursor-core` 全仓瘦身、单源预设收敛**：
   - `src-tauri/src/commands/platforms/model_context.rs` 的 `MODEL_CONTEXT_PRESETS_JSON` 改为编译期直接 `include_str!` 读取唯一源 `ui/assets/model-context-presets.json`，物理删除冗余副本 `src-tauri/resources/model-context-presets.json`。
   - 在 `cursor-core/src/cursor/prompting/assets.rs` 新增单测 `shared_mode_base_prompts_stay_identical_between_embedded_and_disk`，锁定 `cursor-core/prompt/cursor/{agent,debug,plan,subagent}/prompt.md` 四份基础提示词模板逐字节一致。
   - 完成 `cursor-core/` 全量 12 个 `>800` 行文件与 `local_app/account.rs` 语义拆分（覆盖 `plugin/{registry,worker}`、`cursor/conversation/{output,runtime}`、`control/service`、`run/engine`、`cursor/tools/tool_call_result/gate`、`cursor/services/model_catalog`、`crates/semble-core/src/search/engine` 以及集成测试 `tests/{interrupt,tool_round,error_lifecycle}_cases/`），同步拆分 `src-tauri/src/` 全部 7 个 `>=740` 行贴红线文件（`codex_session_visibility`、`platforms/tests/{pi,yaml_platforms}`、`platforms/managed_models_cmds`、`extensions/cpa_install_and_mirrors`、`proxy_routes`、`model_map`、`proxy/commands_and_cleanup`），实现主仓 `<= 730` 行、`cursor-core` `<= 672` 行。

2. **Sidecar 死模块清理、外层尝试调度收敛与大文件拆解**：
   - 物理删除零引用脏模块 `sidecar/inject-models.js`；新增 `sidecar/lib/attempt-runner.js`（及 `attempt-runner.test.js`）收敛 `local-proxy.js`、`handlers/chat.js`、`local-proxy/transport.js` 与 `local-proxy/count-tokens.js` 共用的候选密钥顺延、可重试判定及 `<2s` `Retry-After` 微退避逻辑。
   - 语义拆解 6 个 `>=710` 行文件（`tool-proto-builders.js`、`antigravity-handler.js`、`proto-parsers.js`、`upstream-payload.js`、`cursor-proxy.js`、`local-proxy.js`），全量 140 个 `.js` 均 `<= 689` 行，且从 `sidecar/proxy-entry.js` 依赖树 100% 可达、零死生产模块。

3. **前端空壳清理、Buddy 家族收敛与组件/模块拆解**：
   - 物理删除零引用空壳 `ui/assets/scripts/00-bridge.js`（`ui/README.md` 同步指向 `api/bridge.js`）；新增 `ui/assets/scripts/platforms/shared_buddy_add.js` 抽离 CodeBuddy / WorkBuddy / ZCode 添加页公共流程。
   - 将 `platform-cursor.html` 与 `model-slots.html` 拆分为 8 个 `ui-src/partials/components/*.html` 组件经 `@include` 组装（保持产物 `ui/index.html` 逐字节一致）；将 `antigravity_models.js`、`antigravity_console.js`、`grok_helpers.js`、`cursor_add.js` 及 `00-foundation.css`（提取 `foundation/tokens.css`）按业务职责拆解，全部非字典/非编译产物文件均 `<= 698` 行。

4. **工作区净场、构建自动化升级与全仓 800 行硬门禁**：
   - 清理纯编译缓存与 7 个已完成使命的一次性 UI 迁移脚本（同步移除 `.gitignore` 中的 `!scripts/verify-ui-baseline.mjs` 与索引残留）；将散落本地探针与历史遗留跟踪脚本无损归档至临时归档目录 `tmp/archived-probes/{untracked,tracked-legacy}/`。
   - 升级 `scripts/build/build_protected_sidecar.py` 为自动扫描 `JSC_DIR` 根目录模块（移除过时硬编码列表）；升级 `scripts/build-ui.mjs` 集成幂等 `syncSharedResources()`，构建时自动按字节比对单向同步 `windsurf-catalog.json`、`system-prompt.md` 与 `docs/assets/icons/` 同名图标。
   - 更新 `scripts/check-ui.mjs`（移除 `00-bridge.js` 并校验 `55-platforms.js` 导入序、样式子模块与 8 个 HTML 组件）与 `scripts/check-no-sensitive-files.mjs`（允许 `cursor-core/{src,tests,crates}/*.rs` 未跟踪源码）；升级 `scripts/lib/key-features/ui-guards-and-presets.mjs` 与 `scripts/arch-anti-regression.test.mjs`，正式把 `cursor-core/{src,crates,tests}` 全部 `.rs` 纳入 `<= 800` 行硬门禁，并加入死模块/冗余副本不复活、共享资源字节一致及 `scripts/` 净场防退化断言。

### 全端零技术债模块化重构与门禁升级

1. **Rust 后端：统一锁事务底座、全平台 SSOT 解析与保形还原转正**
   - 新增 `src-tauri/src/commands/store_io.rs` 与 `cursor-core/src/fs_atomic.rs`：`write_atomic` 升级为 PID + 纳秒时间戳 + 原子自增序数唯一临时文件，收口替换全仓 7 处重复实现及 `antigravity_patch.rs` / `hub_patch.rs` 对 `app.asar` 的裸 `fs::write`；基于规范化路径进程内 `Mutex` + 同目录 `.lock` 文件锁封装 `with_file_lock` / `update_provider_store` / `update_proxy_routes` / `update_codex_proxy_routes`，消除多路 RMW 丢更新与 `cursor_models/commands.rs` 写路由吞错假成功，并将 `write_provider_store` / `model_map.rs` 内 2s 同步 TCP 通知剥离为异步后台通知。
   - 在 `config/conversions.rs` 为 6 类平台配置（`AntigravityConfig` / `CodexConfig` / `ClaudeCodeConfig` / `OpenCodeConfig` / `GrokConfig` / `ClaudeDesktopConfig`）统一实现 `resolve_provider` 与 `validate_active_source`：实时继承主供应商端点、完整 `api_keys` 密钥池与启用状态，覆盖 `claude/mod.rs` / `opencode.rs` 的静态 `settings_config` 连接字段，并在 `codex/config_parse.rs` 与 `proxy_routes.rs::sync_provider_api_keys` 打通 `codex-proxy-routes.json` 密钥池同步，修复 `switch_and_update.rs` OpenCode 提前 return 死代码。
   - 默认开启 `ANYBRIDGE_FORMAT_PRESERVING_JSON`（`jsonc_edit/mod.rs` 新增 `Object`/`Array` 缩进对齐写入）与 `ANYBRIDGE_FIELD_RESTORE`（`field_restore.rs` 改用 `serde_json::Value` 转义语义比较；`platform_restore.rs` 还原后清理 `.byok-bak` 及伴生状态文件；`declared_apply.rs` 统一 `.byok-bak`）。
   - 清理 `platforms/` 25 个生产子模块顶部 `#[allow(unused_imports)]` prelude 块；核心配置/模型命令改 `async fn` + `spawn_blocking`；修复 `antigravity_patch.rs` / `antigravity.rs` `inject_lock()` 覆盖、`models_cache.rs` 非 Object 根 panic、锁中毒恢复、`google_gemini/mod.rs` 常量 `OnceLock<Regex>` 缓存，并合并 `version_probe` 重复 `HideWindow` trait。

2. **Sidecar 网关：标准 SSE、多协议 CodecRegistry、只读缓存与流尾账本结算**
   - 新增 `sidecar/lib/sse-parser.js`（`StringDecoder('utf8')`、多行 `data:`、`data:{...}` 无空格兼容、默认事件与 EOF `flush()`），替换各处碎片解析器并修复 `lib/cursor/common.js` / `plugin-loader.js` / `step-executor.js` UTF-8 分片截断乱码；删除 5 个全仓零引用死模块（`multimodal-middleware.js`、`handlers/{web-search,completions,embeddings}.js`、`retry.js`）。
   - 新增 `sidecar/lib/upstream-decoder.js` 与 `sidecar/lib/codec-registry.js`：重构 `sendGeminiStream`、`sendAntigravityStream` 与 `lib/cursor/streaming.js` 支持 4 类上游真流式解码，`runStreamPipeline` 绑定 `res.once('close')` 并在 `try/finally` 中 100% `destroy()` 上游释放 `providerInflightGate` 槽位；将 `local-proxy` / `cursor` 流式请求的 `tracker.finish()` 后置至流真实终结时写入真实 `usage`（提前 EOF/断连绝不补 `STOP`/`[DONE]` 或记为 `ok`）。
   - 修复多轮 `normalize.js`（合并 `tool`+`user`、保留文本+工具块、剔除空 `content`）、`responses-chat/to-chat.js` 对象输出、`reasoning_content` 回填、`gemini-thought-signature.js` 2000 条 LRU + host/model 隔离、`cache_creation_input_tokens` 透传；收口 `hybrid-server.js` 与 `mitm-and-cdp.js` 重复路由。
   - 重构 `config-cache.js` 与 `provider-pool.js`：移除 sidecar 对 `providers.json` 的一切写入；坏盘解析保留上次健康快照、`loadProxyRoutesEntry` 尊重 `entry.dirty`、联动 `clearAntigravityCache()`、`codexConfigs` 实时合并主供应商；新增 `sidecar/lib/http-retry.js` 与 `local-proxy/count-tokens.js`，复用 `system-proxy.js` 共享长连接池，补齐 401/429 `apiKeys` 轮换、`<2s` `Retry-After` 微退避、OAuth 并发单飞锁与有界缓存淘汰。

3. **前端架构：集中式事务 Store、消除 `57-pb-models.js` 裂脑与共享编辑器**
   - 新增 `ui/assets/scripts/state/provider-store.js`（`main.js` 紧接 `state/logs.js` 加载）：收口 `resolveBoundProviderView`、`persistProviders`、`mutateProviderStore`（串行队列、深拷贝快照、过滤虚拟内置供应商、失败 100% 自动回滚）；删除 `antigravityDrop` 中不存在的 `write_provider_store` 调用，同步修复 `saveProviderFromEditor` 与编辑器保存时的嵌套 `settingsConfig` 反咬漏洞。
   - 物理删除 `ui/assets/scripts/57-pb-models.js` 并收口 Pi / Hermes / DeepSeek Harness 到 `managed_models.js` + `models_table_factory.js` 7 列统一表格与计数/搜索/排序；新增 `ui/assets/scripts/platforms/shared_config_editor.js` 抽取四大配置式编辑器共用逻辑；为 `cursor_add.js` 切页补实时重探。
   - 消除 `proxy.html` 三重触发、`openPlatformPage` 双倍包装、统计页热力图 `panicPanel` 遗漏与 `refreshStats` 后台盲跑；全部异步操作补齐 `try/finally` + 标准 `setLoading` / `loadingHtml`；同步 i18n 字典并收紧 `js-cjk-baseline.json`（`3742 -> 3660`）。

4. **门禁升级与权威文档同步**
   - 升级 `scripts/lib/key-features/ui-guards-and-presets.mjs` 与 `scripts/check-ui.mjs`：`runActionReachability` 支持规范前缀动态注册解析并将 `KNOWN_MISSING` 清零至 0 项；扩充 `LOADING_WORDS` 拦截 `生成/重装/清理/复制/卸载/拉取/测速/验证/删除/重置` 静态加载文案；纳入跨端架构防退化硬校验并新增 `scripts/arch-anti-regression.test.mjs`。
   - 同步更新 `docs/capabilities.md`、`docs/pitfalls.json`（修正 `ag-source-provider-snapshot-drift` 并新增 4 条跨层防退化坑点）、`docs/ARCHITECTURE(_zh).md` 及 `docs/subsystems/*.md`。
   - 判据与回归：`scripts/arch-anti-regression.test.mjs`、`scripts/ui-store-and-pb-regression.test.mjs`、`sidecar/lib/{sse-parser,codec-registry}.test.js`、`sidecar/lib/local-proxy/api-keys-rotation.test.js`、`src-tauri/src/commands/{store_io.rs,config/tests.rs,platforms/tests/ssot_and_restore.rs}`。

## v1.1.13 - 2026-11-16

### 1. 测试宿主机环境彻底隔离（防清配置 / 防杀进程）
- 根因：本地/CI 执行 `cargo test`（如 `antigravity_official_writes_back_user_url`）与 `sidecar/antigravity.test.js` 时，测试会直接调用无隔离入口 `clear_antigravity_stale_managed_endpoints()`、`Self::kill_antigravity_language_server()`、`agent_stash_dir()` 以及未设 `BYOK_CONFIG_DIR` 的 `configDir()`，导致真实 `Antigravity/Antigravity IDE` 的 `settings.json` 被清除、运行中语言服务被终止触发自动整窗重载、`agent-stash.json` 写入测试 fixture、`ag-handshake.log` 污染。
- 修复：
  - `platforms.rs` 抽取 `clear_antigravity_stale_managed_endpoints_in_dirs` 供单测注入临时目录；`apply_antigravity*_with_stash` 宿主机全局副作用加上 `!cfg!(test)` 守卫；
  - `agent_stash_dir()`、`clear_antigravity_stale_managed_endpoints()`、`kill_antigravity_language_server()`、`patch_antigravity_ide_extension()`、`antigravity_endpoint_keeper_tick()` 增加 `#[cfg(test)] panic!` 强制拦截；
  - `platforms.rs` `mod tests` 全部 35 处调用改为传入临时 stash 的 `*_with_stash` 版本；
  - `sidecar/antigravity.test.js` 为 HTTP 模拟用例配置独立临时 `BYOK_CONFIG_DIR` 与测试 `byok-config.json` / `providers.json`。
- 判据与回归：`test-must-not-touch-real-host-state`；`platforms.rs::antigravity_clear_stale_managed_endpoints_only_touches_managed_dirs`、`scripts/antigravity-refresh-and-isolation.test.mjs`。

### 2. Antigravity 控制台 UI 实时状态探测与反馈
- 修复 `ui-src/partials/pages/platform-antigravity.html` 与 `55-platforms.js` 中刷新状态/模型按钮仅重绘旧内存缓存的问题：绑定 `antigravityRefreshConsoleAction(triggerEl)` 走 `force: true` 强扫 `detect_platforms` 并重载 `providers.json`，补齐 `setLoading`/`clearLoading`/`spinnerHtml` 动态指示与 15s 超时/失败 toast；`openPlatformPage` 与 `switchAntigravityClientTarget` 异步校对实时状态并在 `renderAntigravityPageStatus` 按目标过滤；文案收口进 `zh-CN.js` / `en-US.js` 维持 `js-cjk-baseline` 零增长。
- 判据与回归：`antigravity-ui-refresh-must-probe-live-state`；`scripts/antigravity-refresh-and-isolation.test.mjs`。

### 3. 网关协议与混合分桶增强
- `sidecar/lib/antigravity-handler.js` 新增 `antigravityAuthScopeKey` 按 Authorization 指纹隔离 hybrid 官方模型响应缓存桶，防止切号串联旧号目录；
- `sidecar/local-proxy.js` 与 `sidecar/lib/gemini-thought-signature.js` / `chat-sse-transform.js` 修复多轮工具调用转 Gemini 原生上游的 `functionCall`/`functionResponse` 与 `thoughtSignature` 签名回放与兜底链路（`openai-to-gemini-tool-history-dropped`）。

### 4. 全仓长文件重构收敛、Antigravity/Gemini 实时解析与透传闭环、编译器警告清零
- 结构重构与收敛：消除 `50-platforms.css` (`part-01..19`) 与 `windsurf-catalog-part-1..4` 机械分片，完成全仓 `>800` 行脚本/样式/Rust 模块语义化拆解并收拢 `windsurf-catalog.json` 单一事实源及平台添加页公共 HTML 组件；清除残余廉价 `border-left` 彩条装饰并升级 `check-key-features.mjs` 守卫（覆盖 `border-left-width`）；清理 `src-tauri` 166 条编译警告至零警告并保持 Unix/macOS `#[cfg]` 守卫完整。
- Gemini/Vertex/Antigravity 闭环修复：
  - `antigravity_models.js` (`resolveAntigravityConfigView`) 与 `models_table_factory.js` 拖拽导入禁止旧快照 `apiFormat` 压过主供应商端点推断与重复写入污染快照；
  - `sidecar/config-cache.js` 剥离 `sourceProviderId` 配置项上的过时能力/连接快照字段（`apiKeys`/`wireApi`/`capabilities`/`modelCaps` 等）；
  - `90-init.js` / `hero_and_agents.js` 在首屏渲染与平台检测前预加载 `loadAgentRegistry()` 消除冷启动期 `platformDef` 回退 `'openai'` 窗口；
  - `routes.js` (`buildAntigravityRouteFromCustomModel`) + `local-proxy.js` 修复内部依赖与 `countTokens` 在同名 `upstreamModel` 下绕过活跃配置路线、关联主供应商禁用时回落 `proxy-routes.json` 的缺陷；
  - `upstream-payload.js` (`buildGeminiNativePassthroughPayload`) 剥离 Antigravity/LS 内部包装字段（`sessionId`/`requestType`/`userAgent`/`project`/`metadata` 等）、统一 snake/camel 键并按需清理非法 JSON Schema 关键字；`thinking.js` 补齐 `function_call` 兜底签名；`probe_conn.rs` (`build_fetch_model_url`) 与 `eval/protocol_and_checks.rs` (`protocol_gemini_urls`) 消除 `fetch_models` 重复拼接 host 内嵌路径及评测自定义路径丢失问题。
- 判据与回归：`ag-internal-dependency-must-pin-active-route`、`gemini-fetch-models-no-duplicate-host-path`、`docs/capabilities.md`；`google-gemini.test.js`、`google-gemini-e2e.test.js`、`antigravity-refresh-and-isolation.test.mjs`、`config::tests::fetch_models_gemini_url_does_not_duplicate_embedded_host_path`、`eval::tests::gemini_protocol_checks_preserve_custom_gemini_path`。

## v1.1.12 - 2026-11-15

### 转发链路韧性

- 反重力官方转发三条路径（握手 Raw/Json、模型列表、对话转发）统一补第二轮退避重竞速（`handshakeRetryDelay` 700ms）：瞬时 DNS / 代理切换 / TLS 抖动消在网关侧。对话转发仅在未开始下发响应时重试，保持流式语义。
- 覆盖核查：`officialRequestOnce` 四个调用点全部具备两轮竞速，无遗漏孤岛。
- 判据：`antigravity-handshake-forward-single-attempt`；回归：`sidecar/antigravity.test.js`。
- 版本号对账：各声明文件同步到当前版本。

## v1.1.11 - 2026-11-15

### 通道与账号接管加固

- 新版客户端的 Agent 传输放行，消息载荷兼容二进制格式，修复接入后对话连接中断。
- 账号接管恢复混合语义：已有登录原样保留，仅未登录才注入本地账号。
- 接管快照与还原写入前增加一致性校验，异常状态不再注入、不再固化；还原后清理失效标记残留。
- 判据与回归：`cursor-account-profile-mismatch-skip-injection`（3 个新测试锁定）。
- 版本号对账：各声明文件同步到当前版本。

## v1.1.10 - 2026-11-15

- 同步组件来源说明，明确仅保留当前使用的部分。
- 版本号对账：各声明文件同步到当前版本。
- 统一公开处文字口径，减少实现细节外露。

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
