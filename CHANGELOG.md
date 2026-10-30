# Changelog

All notable changes to AnyBridge will be documented in this file.

## Unreleased

- 修复：系统代理注册表残留指向死端口时（代理软件退出但 ProxyEnable 未清，如 FlClash 残留 7897），sidecar 上游请求全部 `proxyconnect ECONNREFUSED`；新增代理端口健康探测（5s 周期 / 1.5s 超时），死端口自动降级直连、恢复后自动切回，无需重启服务。
- 改进：Cursor 接管配置 `http.proxySupport` 由 `on` 改为 `override`——`on` 的语义是「使用代理设置」，系统代理存在时 Cursor 可能优先走系统代理导致流量绕开本地代理且无日志；`override` 强制 `http.proxy` 覆盖系统代理（旧值为 on 的机器在下次启用时自动重写）。
- 改进：Cursor 3.27+ 的云端命令通道 `GET /agent/v1/run` 本地短路返回 401（携带本地注入 token 官方必然 401，本地 agent 主链路不依赖该通道），消除每次启动的 tunnel ERROR 并减少一次出站连接；fallback 透传未命中路径开始留痕（去重限 256 条），新版新增端点将从日志冒出。

## v1.0.3 - 2026-10-30

- 新增：Antigravity IDE 设置页与 Agent 面板支持汉化——这两块界面由客户端内嵌的本地网页渲染（扩展 iframe + 编译进 agy.exe 的资源），改文件够不到，改为以调试端口启动后经 CDP 运行期注入，页面刷新自动补注入。
- 新增：汉化面板增加「设置页与 Agent 面板」状态卡与「以汉化模式重启 IDE / 立即注入当前界面」按钮，是否开放调试端口由用户显式点击决定。
- 修复：Antigravity IDE 的独立引导窗口（workbench-jetski-agent.html）此前未注入，导致设置页仍是英文；汉化/还原/状态判定/保活改为覆盖全部界面入口。
- 修复：辅助窗口没有 workbench 根节点时会先隐藏首屏、等 6 秒超时才开扫，表现为汉化生效却白屏数秒。
- 修复：热更新词库此前整体替代内置基线，导致新加的内置词条在更新过在线词库的机器上完全不生效；改为基线打底、缓存同名词条覆盖、缓存独有词条追加。
- 改进：汉化词典补齐 20 条设置页与对话面板文案（全局权限、排队消息、浏览器子智能体、对话步骤等）。
- 修复：Agent 声明快照测试只认 opencode.json，安装了 opencode.jsonc 的机器会被误判失败。

## v1.0.4 - 2026-10-30

- 修复：本地代理服务未运行时切换 Codex 配置，此前会先把 Codex 桌面版重启一遍、再抛出「无法连接 7450 … os error 10061」，用户窗口没了、模型也没解锁；改为注入前先确保代理服务可用，不可用时直接返回可执行提示且不重启客户端。代理可用性检查统一收敛到 `proxy::ensure_proxy_service_ready`（端口连通性优先），Cursor Core 复用同一入口。
- 修复：本地探测的错误信息此前只保留最后一个回环地址（`[::1]`）的失败原因，把真正的 IPv4 拒绝原因盖掉，排障被误导成 IPv6 问题；改为逐条保留两个地址的失败原因。
- 修复：Codex 进程判定把 npm CLI 的 `codex.exe` 当成桌面版宿主——开着 CLI 时点「启动 Codex」会回「已在运行」，切换配置还会杀掉 CLI 会话；改为按路径排除 CLI 目录（node_modules / vendor/bin / cargo target），判定矩阵纳入门控。
- 修复：新版 Codex Desktop 把 CDP 绑在 `::1`，IPv4 回环可能被别的 Electron 应用占用同号端口，旧的「取第一个 page」会把补丁注入到别人的界面（实测打进过 Antigravity IDE）。改为优先选含 Codex 页面的响应组，且注入前必须自证目标是 Codex（`app://-/` 或含 codex），否则拒绝注入并报错。
- 修复：Cursor 免登录（本地账号注入）在升级过新版 Cursor（3.27+）的机器上失效——新版登录后会把 token 升级成 safe-storage 加密格式，注入逻辑只判「值非空」误判为已有真实登录而跳过，回退旧版本后 Auth init timeout、agent 请求一次都不发。跳过条件排除该前缀并自动重新注入，同时补齐会员/订阅状态等 7 键与 4 个单测（覆盖降级自愈/幂等/真实登录保留）。
- 改进：cursor-core 日志落盘到 `$ANYBRIDGE_CONFIG_DIR/cursor-core.log`，新增 connect/tls/http 三段阶段打点——此前 stdout 被桌面端收走，接入故障只能黑箱猜，现在可离线定位断在哪一层。
- 修复：「极简扁平」风格 × 深色主题（工作台深色/霓虹 EVA）下顶部 Tab 与顶栏糊成一片——minimal 的 Tab 配色按浅色底设计（选中态是 `--bg-card` 深灰药丸，在深色顶栏上零对比）；深色场景改为扁平中性胶囊（参照极简墨黑的既有做法），浅色主题与极简墨黑不受影响。

## v1.0.0 - 2026-10-30

- 新增：主题系统全面重构——「亮色/深色 × 主题色 × 界面风格」三维正交，6 套配色（工作台浅/深、暖沙 Claude、霓虹 EVA、极简云白、极简墨黑）可任意搭配轻拟物或极简扁平质感，老用户升级视觉无感迁移。
- 新增：顶栏主题菜单三分区重做——主题两列预览卡、风格分段开关、导航栏图标与语言快捷设置直入面板，支持边缘自动避让居中。
- 新增：i18n 全量补齐并新增双语门控（check-i18n）——漏翻/未翻/占位符/空值/文档双语 5 项自动拦截，中英切换不再出现残留。
- 修复：切换语言后部分文本卡在英文不再恢复的问题（i18n 引擎新增英文值反向索引恢复机制）。
- 改进：EVA 主题重调色为初号机紫罗兰 × 霓虹青，底盘与边框带紫调氛围。
- 改进：极简扁平风格全站去立体——阴影 token 归零、状态语义色统一（绿=运行中、橙黄=已停止、红=异常），容器中性只染文字。

## v0.6.2 - 2026-10-29

- 新增：平台卡片显示「配置漂移」——接管期间配置被外部改动时标出并统计处数，不再静默失效。
- 改进：首屏平台检测改为异步 + 骨架占位，不再阻塞其他初始化步骤。
- 改进：版本探测对被杀软拦截/挂起的 CLI 记住失败，二进制未变时不重复启动子进程。
- 修复：使用功能完整的第三方中文语言包时，不再误报「汉化未生效」。
- 新增：用量统计页重做——ECharts 走势图、KPI 环比与迷你趋势线、时间粒度自适应（今日按 24 小时）、骨架屏、最近请求的「请求模型 → 实际模型」链路。
- 新增：本地用量来源扩展到 5 个——Claude Code、Cursor、CPA 套件（账号维度）、Pi、ZCode；每个来源可单独启停，未安装的来源入口自动隐藏。
- 新增：跨账本去重——客户端经自家网关/CPA 转发过的调用按上游标识剔除并在卡片标注「已去重 N 次」，同一请求不再被计两遍。
- 新增：请求级落账出口（tracker），失败/被拒请求计入请求数，错误率不再可能超过 100%；Chat 主链路补上此前完全不进统计的 12 处终态。
- 新增：按模型计价（输入/输出/缓存分别计）与 per-request 明细账本（`usage/*.jsonl`，白名单字段，正文不入账）。
- 修复：「今日」在本地 00:00–08:00 恒为 0——旁路数据曾按 UTC 日分桶而界面按本地日筛选，现已统一为本地日并重建索引。

## v0.6.1 - 2026-10-26

- 新增：供应商编辑器的「测试连接」与「拉取模型」结果常驻展示（成功/失败两态，离开页面自动清除）。
- 新增：本地代理重试支持 `Retry-After`（限流时按上游建议等待），统计新增上游请求数口径。
- 改进：平台更新链路加固——命令超时保护、更新后校验可启动、失败自动回滚、同平台防重复点击。
- 改进：grok 等自更新平台的一键更新可用（修复安装方式误判）；更新完成后按钮不再残留。
- 改进：全界面加载态改为动态 spinner。
- 修复：停止汉化不再影响 BYOK 接入（Windsurf / Devin / Antigravity 异常路径隔离）。
- 修复：已使用第三方完整中文语言包时，不再误报「汉化未生效」。

## v0.5.41 - 2026-10-25

- 主题体系升级：从明暗双主题扩展为四主题（工作台浅色 / 工作台深色 / 暖沙 Claude / 霓虹 EVA）。CSS 明暗语义抽取为独立的 `data-scheme` 属性（248 处组件特化选择器统一迁移），`data-theme` 只负责色板覆盖，新增主题只需声明一组 token。
- 新增「暖沙 Claude」浅色主题：米白暖调底盘 + 珊瑚橙强调色 + 橄榄绿辅色，顶栏/侧边栏/图标底座全套暖色适配。
- 新增「霓虹 EVA」深色主题：深空曜黑底盘 + 电光靛紫主色 + 赛博薄荷青翠点睛（运行状态、成功指标），图标底座为冷陶瓷柔白悬浮晶片。
- 主题管理改造：
  - 顶栏主题按钮改为调色盘下拉菜单（居中弹出，含各主题迷你窗口缩略图），设置页外观面板改为四张主题卡片（迷你窗口预览 + 主题名 + 副标题）。
  - head 内联防闪脚本：启动首帧直接应用上次主题，不再闪浅色。
  - 旧 `byok-theme` 存储值（light/dark）天然兼容，原生滚动条 `color-scheme` 跟随主题。
- 品牌强调色全面 token 化：蓝/青绿/teal 三族共 300+ 处硬编码颜色（主按钮渐变、扩展图标徽章、模型映射状态标签、更新日志、协议徽章等）映射到 `--accent-rgb` / `--accent-secondary-rgb` / `--accent-bright-rgb` 主题变量，所有强调色跟随主题。默认浅/深主题取值与原硬编码一致，视觉零变化。
- 顶栏与状态指示精修：
  - 顶栏背景、分段组件、logo 外框、品牌 logo 三节点全部主题化（Claude 暖白暖棕、EVA 深空紫黑），新增 `--topbar-*` token 体系。
  - 「代理运行中」pill 配色按主题定义（工作台绿 / Claude 橙 / EVA 薄荷翠），未运行统一中性灰；深色下收敛玻璃白高光，消除发白发雾。
  - 主题色卡改为「迷你窗口缩略图」（红黄绿窗控点 + 侧边栏 + 内容区微缩示意），下拉与设置卡片视觉统一。
- 深色主题玻璃拟态收敛：主按钮、激活 tab、状态 pill 的白色高光/描边/inset 高光按深色 scheme 降档，关闭深色下无意义的 backdrop 毛玻璃，解决「发白不通透」。
- 侧边栏主题化：背景、分割线、图标底座、激活胶囊全部走 `--sidebar-*` token，四主题各自定义；激活项为整块圆角胶囊微光，无侧边彩条与外发光。

## v0.5.40 - 2026-10-24

- Claude Desktop 汉化改为真正生效的方案：此前走的「合并 en-US.json」是被证伪的路线——react-intl 的默认语言直接用组件内联的 defaultMessage，根本不读该文件。现在改为向 Claude 的 i18n 目录写入简体中文词库（30,600+ 条），并在页面内声明 zh-Hans 语言、调用语言 store 切换显示语言，实测设置面板等界面全部中文。
- 语言 store 模块与导出别名改为运行时扫描：Claude 每次升级都会重新混淆打包（1.49585 → 3.6556 的模块名与导出名都变了），硬编码必然失效，现在按特征自动定位。
- MSIX 商店版自动授权：写入受保护目录前自动 takeown + icacls，并在授权后仍不可写时给出可操作提示（以管理员身份运行或改用官网版）。
- 修复重启 Claude 却杀掉 Windsurf：配置 key 映射表漏了 Claude 分支，导致 `claude-desktop` 落到 Windsurf 的 key 并读到其安装路径。三个平台的 key 映射补齐，并新增回归测试保证各平台 key 互不相同。
- 五个平台汉化面板文案与交互统一：副标题、说明文字、执行流程（统一 4 步）、检查更新提示、结果提示、状态徽章配色（未汉化改为中性灰），以及 Antigravity 面板补齐缺失的「中文语言包」信息行。
- 汉化弹窗视觉修复：日志区固定高度占位（不再随日志增多撑大弹窗），底部按钮统一高度与内边距，消除一大一小与塌陷。
- 全平台支持一键重启客户端：底层补齐 Claude Desktop 的杀进程与启动（商店版走 AppsFolder 激活，官网版直接拉起）。

## v0.5.39 - 2026-10-24

- 修复 Windows 端 Cursor 多任务（Multitask）子代理起不来：子代理的启动消息不带 `message_id`，且 `x-parent-request-id` / `x-parent-agent-tool-call-id` 是分别发送的，此前这两类请求在调用模型之前就被判为非法，表现为主对话一切正常、子代理却永远停在「Planning next moves」。现在缺失 `message_id` 时从消息内容派生稳定身份（同一条消息重试仍落到同一次请求，幂等），两个父头各自独立可选。
- Cursor Core 的运行日志接入应用「代理日志」面板：此前 core 进程的 stdout / stderr 被直接丢弃，协议层面的报错在界面上完全看不到，排查只能靠猜。现在以 `[cursor-core]` 前缀逐行输出到日志面板，分级规则与 sidecar 日志一致。
- 上游目标全部处于冷却期时直接报错，不再挂起等待：原本会把冷却中的目标按解冻顺序照旧返回，请求长时间无响应，日志里也看不出是在等冷却。现在直接返回失败并给出最短剩余解冻秒数（对话入口报资源耗尽，本地代理返回 503）。
- 增强参数面板改为逐字段重置：去掉顶部的「重置默认」总按钮，改为每个参数旁独立的重置入口，且仅在该项与默认值不同时才显示，避免一次误点清空整组调优参数。

## v0.5.38 - 2026-10-19

- 模型推荐上下文预设体系升级（v7）：
  - 阶跃星辰（StepFun）全系原生支持：全面接入 Step-5-Preview / Step-5 / Step-5-Mini 旗舰长上下文（1M 输入 / 128K 输出），以及 Step-3.7-Flash（256K / 64K）、Step-2 系列（256K / 32K）、Step-1 系列（256K / 16K）。
  - 补充 2026 年最新主流模型：Claude Haiku 5.5（1M / 128K）、Gemini 4 / Argon（1M / 64K）、Mistral Large 4（1M / 128K）、NVIDIA Nemotron 3.5 / Super VL（1M / 64K）、阿里 Qwen3-Coder / Qwen3.8-Coder（256K / 64K）。
  - 同步补充主流模型新变体别名匹配：DeepSeek v4.1-1017、智谱 GLM 5.3 Prime / FlashX、通义千问 Qwen 3.8 Max Prime / Omni Flash、OpenAI GPT-6.1 Sol Pro / Luna Pro 等。
  - 默认未知模型保底上下文由 128K 提升至 256K（输出 16K），契合现代前沿开发与大上下文模型普遍现状，历史遗留的 128K 默认值在配置与加载时自动平滑升级。
- Windsurf Catalog 与 Codex 预设目录同步录入 Step 5 Preview、Claude Haiku 5.5、Mistral Large 4。

## v0.5.37 - 2026-10-18

- 新增 Multi2API 插件：把 WorkBuddy / CodeBuddy 等平台账号转成标准 OpenAI 接口，内置账号池轮询、定时签到保活与故障自愈，聚合支持 WorkBuddy、字节 Trae、智谱 Z.ai、MiniMax、华为云平台。
- 插件发布包改由主程序统一获取，与 CPA（CLIProxyAPI / CPA Manager Plus）安装部署走完全同一条链路：
  - 并发测速所有 GitHub 镜像、按速度从快到慢逐个尝试，单源失败自动重试换源；请求跟随 Windows 系统代理。
  - 插件在 `plugin.json` 的 `deploy.asset` 里声明仓库与产物名即可，adaptor 不再自己实现下载。
  - 移除 adaptor 里基于 `curl` 的直连下载：`curl.exe` 用自带 CA 包，在开着本机代理或企业中间证书的环境里会直接 `curl: (60)` 证书校验失败，而在这些环境里主程序的下载链路一直是通的。
  - 只替换可执行文件：`config`、凭证目录 `auths/`、运行状态 `data/` 一概不动。
- 修复「重新安装会清空安装目录」：部署前置检查原本对所有策略都执行 `rm -rf`（只要目录非空且没有 `.git`），导致重装时把已下载好的二进制、以及上一轮登录留下的 `auths/` 账号凭证一并删掉 —— 表现为装完报「缺少 xxx.exe」、账号凭空消失。现在只有真正要跑 shell 命令的策略（源码克隆、Docker 构建）才清理目录，由 adaptor 接管的策略保留现有文件。
- 修复「卸载假成功」：卸载时若服务进程不在 `status.json` 的 pid 记录里（例如服务是在 AnyBridge 之外被启动的），进程杀不掉，被占用的可执行文件会让目录删除失败，而错误被吞掉后仍返回成功 —— 表现为提示已卸载、卡片却以「已停止」复活。现在卸载前按监听端口找出进程杀掉，目录删除失败如实报错。
- 修复打开插件主页 / 管理控制台时 Windows 上闪一下 cmd 黑窗：`open_url` 补上 `CREATE_NO_WINDOW`；sidecar 一侧的 `exec` / `commandExists` 全部强制 `windowsHide`。
- 本地服务未启动时拉取模型列表只报 `HTTP 502`，看不出原因。现在目标地址是本机（127.0.0.1 / localhost）且拉取失败时，直接提示「本地服务可能未启动，请先启动对应插件」。
- 插件部署弹窗：终端日志改为与其余界面一致的白色主题（跟随深色主题），进度收敛为固定 4 阶段（环境检测 → 获取组件 → 生成配置 → 就绪完成）单行展示，去掉嵌套滚动条与「无 shell 命令，跳过」这类内部噪声，下载进度使用后端真实百分比。
- 插件部署成功后自动登记为本地供应商（有 API 密钥时），卸载时一并撤销，避免留下指向已删服务的死条目。
- grok2api 插件默认端口由 8000 调整为 8700：8000 是大量开发服务器的默认端口，容易被用户的日常开发占用。
- 卸载重装后自动恢复账号数据：卸载时插件已把凭证目录 `auths/` 与运行状态 `data/` 备份到 `~/.anybridge/<pluginId>-backup-<时间戳>/`，再次安装时若安装目录里还没有这些目录就自动放回去，并在进度里说明恢复了什么、来自哪份备份；已有数据一律不覆盖。升级（只换二进制）同样不动这两处。
- 供应商密钥不再可能出现「与插件网关不是同一把」的情况：插件适配器的 `generateConfig` 现在把真正写进插件配置文件的密钥回传给主程序，登记本地供应商时以它为准，而不是用本地缓存的那一份。此前两者一旦出现偏差，拉取模型列表就会 401，而界面上只显示「拉取不到模型」，看不出原因。
- Multi2API 的密钥默认改用固定值（`anybridge-local` / `anybridge-admin`）：网关只监听 127.0.0.1，本机之外不可达，钥匙不承担真实鉴权；随机生成反而让每次安装或重新生成配置都换一把新钥匙，埋下上面这条失配隐患。用户在表单里显式填写时仍以其为准。
- 本机地址拉取模型失败时给出可行动的原因：服务没起（端口无人监听）、或本地供应商里的密钥与插件网关不是同一把（401），不再只报笼统的失败。
- 供应商编辑页拉取模型失败的原因直接显示在模型面板上：此前失败详情只进扩展中心日志，编辑页上只剩「暂无模型」，无法判断是服务没启动还是密钥不对。
- 修复供应商编辑器模型计数在列表清空时不刷新，导致上一次的「N 个」残留在页面上，与「暂无模型」并存的矛盾状态。

## v0.5.34 - 2026-10-14

- 修复客户端报「响应数据无效 / Expected 'id' to be a string」（错误码 10014）的问题：
  - 成因：官方 API 的 `id` 一定是字符串，所以客户端（CodeBuddy/ZCode/WorkBuddy/OpenCode 等）的 schema 校验从不报错；一旦经 AnyBridge 中转到第三方供应商，上游可能返回数字 id、null 或干脆不带 id，而我们原先**原样透传**，客户端校验就失败了。
  - Chat SSE 透传路径现在会规范化 `id`（非字符串就补一个 `chatcmpl-<uuid>`，同一条流内保持稳定）、`object` 固定为 `chat.completion.chunk`、`created` 兜底为数字。合规上游的字段原样保留，不做任何改写。
  - Anthropic 出口的 `message.id` 同样收敛为字符串（数字也转成字符串，缺失才自己生成）。
  - 补充单元测试覆盖：数字 id、缺失 id、id 稳定性、object/created 兜底。

## v0.5.33 - 2026-10-14

- 修复 Responses 请求中**省略 `type` 的 input 项被静默丢弃**：`responsesToChatCompletions` 只按 `item.type` 分支匹配，而 Responses API 允许 message 项只写 `role` / `content`（`type` 可省略）。这类项会掉进"谁都不认识"的分支被丢弃，最终上游收到**空 messages**（Gemini 系直接报 `contents is not specified` 400），客户端看到的是莫名其妙的 400。
  - 修复：没有 `type` 但带 `role` 或 `content` 的项按 message 处理。
  - 触发面：`wireApi: chat` 的供应商（走 Responses→Chat 转换）会命中；Cursor 自身请求带 `type: "message"`，不受影响。

## v0.5.32 - 2026-10-14

- 修复 Cursor 接管后「发消息一直转圈 / 无任何回复」：本地代理对**全路由表**构建「对外模型 ID → 路由」查找表时，只要有一条路由配置打架就整体抛错，导致**所有模型**（包括与该冲突毫无关系的模型）全部 502。
  - 根因一（放大器）：`buildExposedIdLookup` 遇到冲突直接 throw，而查找表是所有模型共享的。已改为**两段式构建**：字面 ID 是路由的权威身份，优先登记；命名规则渲染出的别名是二级别名，与已有条目冲突时**让位并告警**。只有两条路由的字面 ID 真重复才报错。
  - 根因二（冲突本身）：`model-map.json` 的命名规则 `suffix: "({provider})"` 会把路由 `gpt-6-astra` 渲染出别名 `gpt-6-astra(AnyRouter)`，而与「给 Cursor 添加本地代理模型」自动创建的字面同名路由撞车。
  - 现在的保障：即使以后再出现一条撞名配置，也只影响那一条，不会拖垮整个代理。诊断时会明确打印 `暴露别名冲突已跳过` 并指出归属路由。

- 修复 Cursor（Agent 模式）**带工具调用的消息没有任何回复**：纯文本对话正常，一旦模型需要调用工具（例如让它读文件再改）就表现为"模型不回复"。
  - 根因：`/v1/responses` 对未配置 `wireApi: chat` 的 OpenAI 上游（如 CPA 本地网关）走「非流式/假流式」路径，这条路径只把 message 项放进 `output`，`result.toolCalls` 被丢弃；假流式 SSE 也只发 message 事件，不发 `function_call` 的 `output_item` 事件。
  - 修复：`responseObject()` 把工具调用转成 Responses 协议的 `function_call` 项；假流式分支补发对应的 `output_item.added/done` 事件。工具调用链路恢复正常，连续对话不再中断。

- 修复「指向本地代理自身的路由」形成自环：`providerId = anybridge-local-proxy` 的目标会让请求打到网关自己（`请求→本路由→网关→本路由`）。现在这类目标在进程内解析一层换成真实上游目标；若解析回本路由（说明没有真实上游）则**显式报错**，不再靠自环请求硬扛。

## v0.5.31 - 2026-10-13

- 修复 macOS 上「安装证书 / 清理并重装」必须管理员授权、授权失败后把可用状态搞坏的问题：
  - 根因一：macOS 的 `security add-trusted-cert` 带了 `-d`，那是「写入**管理员**信任设置」，会让本该免密的用户级安装也要求管理员密码。已去掉 `-d`，用户级安装恢复为真正的免密路径。
  - 根因二：允许提权时会跳过用户级直接要管理员授权，而这个「跳过」的理由是 Windows 专属的（避免 Windows 安全警告弹窗），在 macOS 上并不成立。现在 macOS 上**先试用户级（login keychain），失败才提权**，多数用户不再需要输入管理员密码。
  - 提权被拒时（常见原因是没看到系统弹窗）不再只回一句原始错误，而是：说清当前状态（证书已重生但信任库没有、IDE 会报 bad certificate），并给出**本平台可直接复制的手动安装命令**（macOS: 钥匙串访问设为「始终信任」或 `sudo security add-trusted-cert ...`；Windows: `certutil -addstore Root`；Linux: `update-ca-certificates`）。
  - 提权前先提示「接下来会弹系统授权窗口，可能被其它窗口挡住或在另一个桌面」，减少「没看到弹窗」。

## v0.5.30 - 2026-10-13

- 修复「IDE 里看不到自备模型」最常被卡住的一环：IDE 写入代理配置后必须重启才生效，但产品没有把这件事闭环。
  - 新增**接管心跳**：代理把「最近一次收到目标 IDE 模型请求的时间」落盘（`anybridge-takeover-state.json`）。这是「模型下拉框会不会被改写」的唯一可靠判据——配置已写入（patched）**不等于**生效。
  - 环境检测新增**「接管状态」**分组，直接给出结论与下一步，不再只列现象：
    - 生效：显示"X 秒前收到 Devin 的模型请求"；
    - 未生效：明确说明"代理启动后没有收到 Devin 的模型请求，下拉框不会被改写"，并指出原因是 IDE 没重启（macOS 必须 Cmd+Q 完全退出）。
  - 「接管未生效」按**错误**计，环境检测顶部不再出现"检测通过（全部检测项正常）"的误导性结论。
  - 环境检测面板新增**「重启 IDE」**按钮（此前只有 Cursor 平台页有），Windsurf / Devin 用户错过接入后的重启弹窗也能随时补救。
  - 已接入状态下再点「一键接入」，改为按接管心跳判定：流量没进代理时照样提示重启，不再只弹一个"已接入"就结束。
- 修复 macOS 上重启 IDE 可能"假成功"的问题：
  - 旧实现在进程名/路径启发式匹配落空时，会同时漏掉「杀进程」与「是否已退出」两件事，于是判定已退出、`open -a` 仅仅是激活了仍在运行的实例，最后仍返回"已重启"。
  - 现在改为按 `.app` 安装路径直接扫描进程，杀进程后复查 PID 必须清零，并确认新进程确实被拉起；任一步不满足就返回明确错误（附残留 PID）。
- 修复 macOS / Linux 上 Antigravity HTTPS 端点（7452）永远不启动的问题：证书目录原先硬编码 Windows 的 `process.env.APPDATA`，非 Windows 上该变量不存在，会在证书明明存在时误报"证书缺失"并跳过端点。已改为统一走跨平台解析。
- 修复 macOS / Linux 上 Antigravity 握手日志被写到进程当前目录的问题，改为写入配置目录。
- 修复证书状态在 macOS / Linux 上显示 Windows 专属字样（`LocalMachine\Root` / `CurrentUser\Root`）的问题，改为按平台显示（macOS: System keychain / login keychain，Linux: system CA trust store）。
- 环境检测里"模型清单"相关提示不再暴露内部文件名 `ide-models.json`，改为描述实际含义。

## v0.5.29 - 2026-10-12

- 修复本地代理「模型列表」保存被静默丢弃的问题：
  - 启动时模型列表加载失败（配置文件损坏、ID/UID 重复、启用了但没有上游目标等）会让保存被一道守卫拦下，界面完全没有提示，表现为"点了添加模型但存不进去"。
  - 现在加载失败会自动修复：先把原配置隔离备份为 `proxy-routes.json.corrupt.<时间戳>`，再抢救出可用条目（按 ID 去重、停用没有上游目标的条目、清掉非法的接口格式/解锁组合）重写，修复后立刻恢复可用，只给一条"已自动修复"的提示，不再弹错误框。
  - 只有自动修复也失败（例如配置目录不可写）才显示错误并暂停保存，界面给出真实原因与「重试加载」入口。
  - 保存时若列表仍未加载成功，明确报出真实原因，不再静默返回。
- 「从供应商添加模型」时如果一个都没加进去，会逐个列出被跳过的模型和真实原因（已在列表中 / 供应商模型列表里查不到 / 模型 ID 冲突），不再统一提示"所选模型均已在列表中"。
- 修复本地代理配置多个上游模型做故障转移时，下游只收到一个没有任何信息的 `403 (empty response body)` 的问题：
  - 「显示供应商原始错误」原来会把上游响应原样透传，遇到中转站/风控常见的「403 + 空 body（或 HTML 拦截页）」时，客户端只能看到空响应，既不知道是哪个上游目标失败，也看不到备用目标的结果。
  - 现在上游响应体为空、是拦截页、或没有可读 message 时不再透传，改为返回聚合错误：写明是哪个模型、每个上游目标（含备用）分别返回了什么，并给出「换渠道 / 核对上游模型名」的建议。
  - 上游响应带真实错误信息时行为不变，仍然原样透传。
- 修复「测试连接」的几处设计问题：
  - 去掉 `gpt-4o-mini` / `claude-3-haiku-20240307` 这类硬编码兜底模型：只卖国模的中转站根本没有这些模型，会把一个正常的渠道测成 "Invalid model id: gpt-4o-mini"（假阴性）。现在没指定模型时改用该供应商自己配置的模型；该供应商连一个模型都没有就直接提示先添加模型，不再发无意义的请求。
  - 空白模型名一律当"没选模型"处理，不再把空 ID 发进请求体或 gemini 路径（此前会换来上游一句 `Invalid model id: `）。
  - gzip 重发收窄为"疑似 WAF 拦截明文 body"才做：状态码 403/406 且响应不是标准 JSON 错误（空响应 / HTML 拦截页）。像 "Invalid model id" 这类明确的业务错误不再白试第二次。
  - 测试失败的报错补齐上下文：写明本次用的测试模型、目标地址和协议，并把原来的 `HTTP 403 / Gzip HTTP 400` 改成「上游返回错误：HTTP 403：{上游原文}」，一眼能看出是上游拒绝而不是 AnyBridge 故障。
- 修复 Antigravity（桌面端）接入后斜杠命令面板缺少 `boost` / `teamwork-preview` / `browser` / `plan` 的问题：
  - 语言服务器的「实验配置」请求（`listExperiments`）被本地代理误当作遥测请求拦截并返回空数据，boost、teamwork-preview 等 preview 功能因此被隐藏。现在该请求会透传官方，与直连官方的行为一致。
  - Antigravity 现在通过本地 HTTPS 端点接入（与官方直连同为 https），语言服务器对明文 HTTP 端点会降级部分高级能力。
  - 修正账号套餐（tier）数据的格式兼容性，避免客户端把账号当作无套餐处理。
  - 本地代理对官方握手请求改用多通道竞速，修好后此前「接入后语言服务器反复重试登录握手」的不稳定现象。

- 修复 MITM 证书被新版客户端判为不合规（TLS alert 42 bad certificate，表现为「模型代理失败、还是原模型」）的问题：
  - 此前生成的证书有效期是 1975-01-01 ~ 4096-01-01（2121 年，来自 rcgen 默认值），违反 Apple / Chromium「TLS 服务器证书有效期 ≤ 825 天」策略。老客户端不校验所以一直能用，新系统 / 新版客户端开始严格校验后直接拒绝握手，MITM 断开导致模型改写不生效。
  - 现在显式设置有效期 365 天（含 1 天时钟偏差容错），并补上 Authority Key Identifier 扩展（openssl `-x509_strict` 链校验通过）。
  - 证书结构版本号 2 → 3：启动代理时会自动换新证书并重装信任库，存量用户升级后无需手动操作（换新时连带重装，避免"同 CN 旧指纹验不了新链"把正在用的人搞挂）。
  - 新增临近到期自动换证（文件生成超过 300 天即换新），避免一年后证书过期再次静默失效。
  - MITM 握手出现「客户端拒绝证书」时，日志直接给出排查指引，不再只甩 OpenSSL 内部错误。

## v0.5.28 - 2026-10-05

- 新增 Hermes Agent 与 DeepSeek Harness 平台支持：
  - Hermes：写入 `~/.hermes/config.yaml`（Windows 为 `%LOCALAPPDATA%\hermes\config.yaml`）的 custom_providers，每条模型独立条目、可单独配置端点与密钥，并把首条启用模型设为默认模型。
  - DeepSeek Harness：写入 `~/.dsh/settings.yaml` 的 llm-pi-ai.providers，密钥按 apiKeyEnv 引用存入 `~/.dsh/.credentials.yaml` 的 refs。
  - 两者都只维护 `anybridge-` 前缀条目，用户手写的 provider、凭据记录与配置注释原样保留；首次写入前自动备份，可一键还原。
  - Hermes 的 config.yaml 常带有上千行文档注释，因此采用保留原文的增量写入（只替换受管的顶层键块），不再整体重写文件。
- Pi / Hermes / DeepSeek Harness 写入逻辑统一改为按供应商分组（与 ZCode 一致）：
  - 同供应商（名称、端点、密钥相同）的模型收敛为一个渠道，选择器里按供应商分组、模型按 ID 展示，不再出现一长串重复的渠道名。
  - Hermes 受管条目识别改为状态快照（`anybridge-models-state.json`）+ 旧 `anybridge-` 前缀自动迁移；DeepSeek Harness 中文供应商名自动生成合法的环境变量引用名。
- 界面优化：
  - 顶部主导航「平台」更名为「智能体」。
  - 各智能体页面底部的「编辑查看」实体按钮改为轻量行内「查看配置」链接，紧随配置文件路径展示，不再打断说明文字。

- 新增 Pi（Pi Coding Agent）平台支持：
  - 「平台」页可管理 Pi 的自定义渠道模型：保存后写入 `~/.pi/agent/models.json` 的 providers（每条模型独立条目、可单独配地址与密钥），并把首条启用模型设为 Pi 默认模型（`~/.pi/agent/settings.json`）。
  - 支持模型单独启停：停用的模型不再出现在 Pi 中，停用状态保留在 `anybridge-disabled-models.json`，随时可再启用。
  - 只维护 `anybridge-` 前缀的 provider，用户手写的渠道（如 local）与 settings.json 的其它设置原样保留；首次写入前自动备份，可一键还原。
  - 模型来源支持直连渠道，也可从「AnyBridge 本地代理」导入（走 `127.0.0.1:7450/v1`，享受看图备用与请求日志）。

## v0.5.27 - 2026-10-03

- 本地代理接入 CodeBuddy / ZCode / WorkBuddy / OpenCode 启用真流式转发：长回复首字节从分钟级降到秒级，带打字机效果；生成超长内容不再因等待整包而中途失败。
- 修复工具调用链路的一批问题：
  - 修复工具定义发送格式错误导致上游拒绝（520 / 503）的问题。
  - 补齐多轮对话中助手历史消息与工具结果回传的格式处理，第二轮起不再中断。
  - 下游现在可以完整接收流式工具调用（增量参数拼接）。
- 上游偶发瞬时故障（520~524、连接超时）纳入自动重试，缓解中转站间歇性抽风带来的失败。
- 长内容生成的首字节等待上限由 90 秒放宽到 180 秒，避免生成到一半的请求被误判超时。
- 上游流内错误现在会明确返回给客户端，不再出现“空回复”式的假成功。

## v0.5.26 - 2026-10-03

- CodeBuddy / WorkBuddy 模型配置能力补全：
  - 新增思考档位白名单（`reasoning.supportedEfforts` + `defaultEffort`）：只勾选上游实际支持的档位，白名单外的请求档位自动回落到默认档，避免中转站因不认某个档位报 400。
  - 新增「实际请求 ID」：列表 ID 带括号等修饰后缀时，可分离填写上游实际识别的模型名。
  - 新增图片数量上限（默认 20）与「禁用多模态输入」开关。
- 修复三处用户个性化配置被冲掉的问题：
  - 编辑模型弹窗保存时不再重建条目，用户配置的思考档位等字段与启用状态完整保留。
  - 从供应商重新添加已有模型时，迁移全部个性化字段（此前只迁移温度等 4 项）。
  - 点「应用供应商配置」时：同一供应商保留用户字段与手工调整的上下文/输出上限；更换供应商则写入全新配置。
- 模型推荐配置升级到 v6：
  - grok-4.7 推荐最大输出从 500,000 修正为 64,000：官方标称 500K 输出，但实测多数中转站上游渠道超 64K 即返回 400 invalid_parameter（CodeBuddy 会按上限自动计算 max_tokens，直接触发）。
  - deepseek-v4.1 推荐最大输出从 393,216 修正为 384,000：官方 384K 按 1024 换算，但商汤等渠道按十进制的 384,000 校验 max_tokens，393,216 会直接 400（field MaxTokens invalid）。
- 编辑模型弹窗布局优化：新增字段整行占位，消除网格右侧留白。

## v0.5.25 - 2026-10-02

- 修复 Antigravity 混合模式下官方模型完全不显示、官方模型无法对话的问题：
  - 修复语言服务崩溃循环：客户端升级后内部模块变化，接入补丁引用的依赖已不存在，导致模型列表与对话全部失效。现在补丁自带依赖，并支持自动修复历史写入的旧补丁，无需重装客户端。
  - 修复官方模型列表无法读取：转发官方请求时沿用了压缩协商，返回的压缩内容无法解析，33 个官方模型被整块丢弃。现在改为请求明文响应，官方模型正常合并显示。
  - 修复官方请求经系统代理时延迟波动导致超时、以及流式回复被中途掐断的问题，混合模式下官方模型可正常对话。
- Antigravity（独立桌面端）汉化升级：
  - 之前内置词库条目太少，设置页、模型与用量、限额等界面仍是英文。
  - 现已内置社区完整汉化引擎与词库，覆盖设置页、面板、对话框与动态提示，代码区、输入框与模型思考过程依然保持原文不被误译。
  - 若仍有零星英文，可在汉化面板点「检查汉化更新」同步上游最新词库，无需升级 AnyBridge。
- Grok 模型注册增强：
  - 支持按模型设置上下文窗口（token），避免小上下文模型按默认值 200,000 处理，几轮对话就溢出。
  - 支持一次注册多个模型，在 Grok 中用 /model 或 Ctrl+M 直接切换，不用回 AnyBridge 重新保存。
  - 支持配置子代理模型，并自动清理 AnyBridge 写入的过期条目。

## v0.5.24 - 2026-10-01

- 修复 Antigravity（独立桌面端）在开启汉化后重新启动**无法打开**的严重问题：
  - 之前写入汉化补丁时未正确处理客户端内部资源文件的字节对齐，在某些情况下会损坏启动所需文件，导致客户端完全无法启动，手动打开也一样。
  - 现已修正该写入逻辑，汉化与还原官方英文后重启均可正常打开客户端。
  - 若你的客户端已受此问题影响无法启动，请重新安装官方客户端，或联系我们从备份恢复。
- 修复部分 Windows 机器上 Antigravity 重启后打不开的问题：
  - 少数环境会因 Chromium 沙箱初始化失败，导致客户端启动数秒后自动退出（官方原版同样会出现，与 AnyBridge 无关）。
  - 现在点击「重启客户端」时会自动检测这种情况，并改用兼容模式重新启动，无需手动处理。
- 移除 Antigravity IDE（编程编辑器）的界面汉化功能：
  - 该能力需要改写 IDE 安装包内部资源并清空校验和，官方升级后会失效，甚至影响 IDE 启动，整体风险高于收益。
  - 独立桌面端（Antigravity）的「一键汉化」不受影响，仍可正常使用。
  - 已汉化过的 IDE 可通过「还原官方英文」一键清理，恢复为官方原版。

## v0.5.23 - 2026-09-30

- 反重力双端独立拆分，可分别管理：
  - 侧边栏现在分别展示「Antigravity」（独立桌面端 Agent）与「Antigravity IDE」（编程编辑器），各自显示安装状态、配置文件路径与接入状态，互不干扰。
  - 两个客户端共用同一套模型池与运行模式，添加一次模型即可同时生效；接入与停止接入也可分别独立操作。
  - 修复 macOS 与 Linux 上独立桌面端接管后不生效的问题，现在 Windows、macOS、Linux 三个平台均可正常接入。
- 新增反重力界面一键汉化：
  - 控制台标题右侧提供「一键汉化」，弹出管理面板并显示实时执行日志，支持一键还原官方英文原版，随时可来回切换。
  - 汉化只作用于界面菜单、设置项与提示文案；代码编辑区、输入内容与模型的思考过程保持原样，不会被误译。
  - 支持在线检查并同步最新汉化词库，无需升级 AnyBridge 就能用上最新翻译。
  - 汉化或还原后需要重启客户端生效，弹窗会提示先保存未保存的工作。
- 修复点击重启客户端后长时间无响应的问题，现在重启数秒内即可完成并自动重新打开客户端。

## v0.5.22 - 2026-09-22

- 修复 ZCode (v0.21.0+) 自定义模型图片理解完全失效问题：
  - 根因：ZCode v0.21+ 桌面版核心运行时不再消费 `~/.zcode/v2/config.json`，仅将其作为单向遗留导入源；首次启动迁移至 `~/.zcode/v2/provider_config.json` 时仅复制 `contextWindow` 字段，丢弃了 `modalities`（图片能力），导致未命中官方预置正则的模型（如 gemini-3.x 系列、自定义别名等）全部被默认置为 `supportsImage: false`，模型丧失视觉理解能力。
  - 修复：新增 `sync_zcode_personal_config` 核心同步逻辑，写入遗留文件的同时无缝同步权威配置文件 `provider_config.json`，正确写入各模型 `inputFormat.supportsImage`、`contextWindow`、`maxOutputTokens.max`；同时完整保留用户在 ZCode 客户端内手动勾选的视频、PDF、原生联网搜索等扩展字段，增量合并互不干扰。
  - 链路贯通：在供应商切换生效 (`apply_zcode`)、模型列表保存 (`save_codebuddy_models`) 以及配置还原 (`restore`) 完整生命周期闭环同步与备份。
- 新增 ZCode 思考档位 (Reasoning Level) 配置与双向同步：
  - ZCode 模型编辑中引入思考档位支持（`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`），提供「常用三档」、「全选」、「清空」快捷操作，默认留空不配置（安全回退 ZCode 内置默认行为）。
  - 选中的档位值随配置同步写入 `optionSpecs.reasoningLevel.values`，经代理层透传为 `reasoning_effort` 参数；支持可选高级参数映射表达式。
  - `load_zcode_models` 接入双向回读，打开编辑弹窗时自动回显已持久化的思考档位设置。
- 编辑模型模态框全面重构与现代化设计：
  - 空间扩展：模态框宽度从 640px 提升至 780px（自适应宽度 92%，高度放宽至 85vh），彻底解决内容拥挤与内层纵向滚动条。
  - 响应式多列布局：基础配置重构为 2 列自适应网格，上下文与生成参数重构为 3 列平等等宽网格（`repeat(3, minmax(0, 1fr))`）。
  - 消除控件对齐错位：将「填入推荐值」从输入框内部移至分组标题栏右上角（`[ 🔄 填入官方推荐值 ]`），与思考档位快捷按钮保持统一设计语言，三列输入框顶部完全水平对齐。
  - 胶囊化档位控件：档位选择升级为精致胶囊开关（Pill Toggle），去除原生小方框复选框，选中态平滑变蓝高亮。
  - 高级映射折叠收纳：99% 用户无需配置的 JSON 映射表达式设计为低调实线折叠面板，默认收起不占位，配置非空时自动展开。
  - 隐藏 ZCode 不支持的「工具调用」复选框，避免无效选项产生认知误导。
- 供应商模型列表快捷复制体验优化：
  - 供应商卡片与模型选择抽屉的模型 ID 胶囊悬浮支持一键复制，并联动底部轻量 Toast 提示，方便跨平台快速流转 ID。

## v0.5.21 - 2026-09-21

- 修复 Linux AppImage 内代理 sidecar 被 linuxdeploy patchelf 破坏导致的白屏与代理不可用（Fixes #33；自 v0.5.5 起所有已发布 AppImage 均受影响）：
  - 根因：linuxdeploy 打 AppImage 时对 `AppDir/usr/bin` 下所有 ELF 写入 RUNPATH，patchelf 重排 ELF（LOAD 程序头 5→6）使 pkg 追加在文件尾部的 JS payload 绝对偏移错位，`readPrelude` 读到错误内容 → `SyntaxError` → sidecar 秒退、7450 端口不监听。`NO_STRIP=true` 只能阻止 strip，无法阻止 patchelf。
  - 修复：新增 `scripts/release/repair_appimage_sidecar.py`，打包后解包 AppImage、用未 patchelf 的原始 sidecar 还原 `usr/bin/anybridge-proxy`、用 tauri 缓存的 linuxdeploy-plugin-appimage 重新打包。
  - 发布链路：修复后 AppImage 内容变化使原 updater 签名失效，release workflow 新增重签名与 `--clobber` 覆盖上传步骤。
  - 防复发门禁：修复后重新解包复核 sidecar hash 与原始一致，并执行启动冒烟；任一环节异常即 CI 失败，`rebuild-latest-json` 被跳过，版本停在 draft 不会推给用户。

## v0.5.20 - 2026-09-20

- 合并社区 PR #32（@yangjuncode）：README 补充源码启动缺失的 sidecar 构建步骤说明（`build_sidecar_plain.py` / `build_cursor_core.py` 需在 `tauri:dev` 前手动执行）。
- 仓库 PR 合并策略统一为 Squash and Merge，主干历史保持线性。

## v0.5.19 - 2026-09-20

- 故障转移配置弹窗全面重构（Pipeline 管线链架构）：
  - 彻底修复弹窗背景穿透与文字重影：遮罩加高斯模糊，卡片改为实心不透明底色（亮色纯白 / 暗色实心表面色）。
  - 淘汰错位文本表头与原生 select：每行升级为「首选主目标 / 备用降级」管线节点卡片，供应商 ➔ 目标模型流向布局，协议路由与思考档位收纳为行内微型胶囊，能力徽章同行展示。
  - 新增专属自定义下拉组件（fo-dropdown）：卡片式浮动面板、自适应主题、折叠箭头动效、选中对勾、超 7 项自动出现即时搜索过滤；严格限制弹出高度（140px）并自适应宽度（≤280px），根除 Windows 原生下拉遮挡标题与底部截断问题。
  - 智能滚动校正：展开下拉时自动检测与弹窗滚动容器底边的碰撞，贴底时平滑滚动确保选项 100% 可见。
  - 弹窗结构规范化：标准头部（标题 + 副标题 + 关闭按钮）、虚线「添加备用目标」按钮、底部操作栏（取消 / 保存配置）、支持点击遮罩关闭；弹窗高度升级为 min(650px, 86vh)。

## v0.5.18 - 2026-09-18

- 模型显示名设置全面升级（支持思考档位、原始槽位与上下文灵活展示）：
  - 新增「附加信息显示模式」选项卡，支持独立开启/关闭「思考档位 (Thinking Effort)」、「原始槽位名 (Slot UID)」、「上下文窗口 (Context Window)」，默认保持官方原样清爽显示，兼顾新手与进阶需求。
  - 界面排版与视觉质感重构：去除大片白底刺眼高亮，支持品牌微蓝高亮选中态；全面移除弹窗内所有 emoji，保持严谨专业的前端规范。
  - 全面胶囊化快捷操作：新增前缀/后缀快捷胶囊（`+ (BYOK)`、`+ ({provider})`、`清空`），高级自定义模式支持点击胶囊直接插入字段（`{effort}`、`{context}`、`{slotUid}` 等）并内置 4 套经典预设，彻底告别手动敲击花括号。
  - 思考档位展示对齐官方规范：去除生硬的短横线 `-`，采用空格分隔与首字母大写格式（如 `High`、`Medium`、`Max`），且支持空格与连字符智能剥离，杜绝 `high-high` 等重复叠加。
  - 槽位简写名自动推导档位：`deepseek-v4-pro`、`kimi-k3` 等旧版简写槽位在自动模式下自动映射至官方规范 UID 并正确提取出 `High` 档位。
  - 槽位版本号展示美化：展示层自动将 UID 中的版本连字符还原为点号（如 `gemini-3.7-flash-high`、`glm-5.2-max`），提升直观辨识度。
  - 实时效果预览升级为真实数据驱动：优先使用用户当前配置的真实槽位演算最终呈现；尚未添加模型时自动展示规范的代表性示例。

## v0.5.17 - 2026-09-17

- 修复「重启 Devin 以应用代理」报「Devin 进程未能终止」的回归（重装/自定义安装路径后稳定复现）：
  - 根因：进程终止按安装目录精确前缀筛选 PID，而存活检测按路径宽松子串判定，两者基准不一致；重装后注册表/快捷方式指向的路径与实际运行进程目录错位时，强杀一个都没命中而检测仍报存活，稳定误报「未能终止」。
  - PID 筛选与存活检测改为同源判定（路径含 devin 目录名并排除 Windsurf 的 devin 扩展目录），并叠加安装目录前缀匹配取并集。
  - 强杀升级为最多 3 轮「枚举 → taskkill → 复查」，总等待窗口 3s → 6s，覆盖 Electron 进程树慢退出。
  - taskkill 失败原因不再静默吞掉，报错信息附带 kill 输出（如「拒绝访问」），便于自助定位权限问题。

## v0.5.16 - 2026-09-17

- 修复 Devin/Windsurf「一键接入 → 停止接入」循环中 IDE 自动升级后，还原操作用旧版本备份覆盖新版原厂文件导致的 workbench 新旧版本错配（表现为客户端误入屏幕阅读器模式、界面 NLS 文案错乱，重装可临时恢复）：
  - `restore_workbench_html` / `restore_nls` / `restore_product_json` 三个还原函数增加版本感知防护：检测到当前文件已是 IDE 升级后的原厂状态时，丢弃过期备份并跳过还原，绝不让旧版本文件覆盖新版本安装。
  - `patch_nls_tolerant` 备份策略从「仅首次写入」改为「原厂态总是刷新」，确保备份与当前安装版本严格一致。
- 用户目录日志防堆积治理（此前只增不删，实测单用户堆积 1.2 GB+）：
  - 新增统一清理模块 `sidecar/lib/log-cleanup.js`：`proxy-logs` / `mitm-logs` / `rpc-audit` / `vision-logs` 四类按天滚动日志默认保留 7 天（`BYOK_LOG_RETENTION_DAYS` 可覆盖），过期自动删除；按自然日节流扫描，写入路径零感知。
  - 「导出日志」只保留最近 10 份，历史导出文件自动回收。
- 修复 Codex 历史会话可见性修复成功后，sqlite 备份目录（可达数十 MB）永久残留在 `~/.codex` 的问题：修复成功即清理备份；备份前先清理同名残留目录，避免 `VACUUM INTO` 冲突。
- 槽位编辑器布局优化：映射参数区（显示名 / 思考档位 / 上下文窗口）合并为单行紧凑布局，思考档位选项文案改为「思考·自动 / 思考·关闭」。

## v0.5.15 - 2026-09-17

- 深度解决 Devin 1.126.0+ 新版架构适配与新旧版本交互体验一致性：
  - 根治模型列表重复与显示不全：重构 `model-aliases.js` 映射机制，采用严格 1:1 精确靶向对齐（如 `kimi-k3` 唯一对齐 `kimi-k3-high`，`glm-5-2-max` 独占改写），从源头彻底杜绝同家族多思考档位重复列表问题，同时保持旧版简写名无感兼容。
  - 解锁 Cascade 原生流式体验：彻底解除新版前端对老版 Cascade 会话模式的强制隐藏与切换拦截，用户可随时在 Agent 切换菜单（`Ctrl+'`）中切回 Cascade，重获毫秒级实时逐字打字机与无阻断交互手感。
  - 优化 Devin Local 免打扰编码体验：支持在 `settings.json` 中自动配置 `mode: "accept-edits"`，消除代码变更时的频繁弹窗打断，找回流畅编码心流。
  - 根除语言包升级死锁白屏：排查并加固国际化 `lAo` 容错处理，防止因旧版语言包缓存缺失新版本新增系统词条（如 21158）导致主渲染进程崩溃抛错。

## v0.5.14 - 2026-09-16

- 修复 Arch Linux / Manjaro 环境下系统 CA 证书安装失败问题（Fixes #25）：
  - 调整证书路径检测优先级：优先检测 Arch / Manjaro 真实证书目录 `/etc/ca-certificates/trust-source/anchors`，避免因系统自带 `update-ca-trust` 工具而误判为 Fedora/RHEL 分支写入不存在的 `/etc/pki/...`。
  - 复制证书命令统一使用 `install -D` 参数，防止目标父目录不存在时报错，并适配 Arch 下执行 `update-ca-trust extract` 或 `trust extract-compat`。
- 修复 Linux AppImage 打包时 strip 破坏 Node.js pkg 产物导致代理进程秒退白屏（Fixes #26）：
  - 根因：`anybridge-proxy` 是使用 `@yao-pkg/pkg` 打包的单文件 Node.js 运行时，payload 追加在二进制末尾且硬编码绝对偏移量。Tauri 打包 Linux AppImage 时底层 `linuxdeploy` 默认执行无差别全局 `strip`，导致 ELF 头部偏移前移，Node 引导代码读取 payload 错位崩溃（`SyntaxError: Unexpected identifier 'instance'`）。
  - 实施分层精准 Strip 机制：在 Linux 打包环境注入 `NO_STRIP="true"` 防止破坏 Node.js pkg 二进制；同时在 Rust 侧单独开启 `[profile.release] strip = true` 与 LTO 优化，并在编译脚本中显式执行 strip，使 `anybridge-cursor-core` 降至 ~15MB，兼顾稳定性与极致轻量包体。
- 增强 Devin Local / Windsurf 跨版本模型别名映射与兼容性：
  - 新增跨版本模型别名解析模块（`model-aliases.js`），建立双向等价解析索引，支持 `kimi-k3` / `kimi-k3-high` / `kimi-k3-max`、`deepseek-v4-pro` / `deepseek-v4-pro-high`、`glm-5`、`gemini`、`claude` 等等价变体。
  - 优化路由与注入逻辑：`provider-pool` 支持等价别名槽位检索；`rename-models` 自动补全等价别名映射并防重复注入，确保新版 Devin Local 的白名单交集校验 100% 通过，且不影响旧版客户端。

## v0.5.13 - 2026-09-14

- 修复国际化（英文模式）下表头文本过长导致字形重叠错位（`Third-party image understandiEngable`）的问题：
  - 将表头文本统一规范为「图片理解」（`Vision`），优化列宽分配并增加文本截断防溢出样式，根治叠字错位。
- 全面完善中英文国际化覆盖与动态文本同步：
  - 补全 Windsurf、Devin、Cursor 控制台副标题、Kite 推荐插件、接入状态按钮（`Connected` / `One-Click Access`）、能力徽章（`Stream` / `Vision` / `Tools`）等全套英文国际化词条。
  - 优化动态数字匹配引擎（`Total X` / `Selected X / Y` 等），全平台模型数量统计 100% 自动对齐英文，支持语言切换实时热更新。
- 修复应用启动时概率性卡死假死与配置加载阻塞的致命问题：
  - 根因：`i18n.js` 的 `MutationObserver` 监听选项中包含了 `characterData: true`，在文本翻译改写 `nodeValue` 时触发了无限微任务递归死循环，导致主线程被占满，阻塞了后续的 `init()`、配置读取与代理健康检查。
  - 修复：移除 `characterData` 递归监听，恢复安全的 DOM 树变动监听机制，启动阶段增加语言切换保护与异常捕获，确保配置数据与代理状态秒级加载。
- 深度重构中英文官方文档（README.md / README_en.md）：
  - 摒弃虚假噱头，转为以开发者真实痛点为导向（第三方渠道接入、免翻隐藏目录手写配置、代理增强、CPA 反代、在线拉取模型列表等）；
  - 构建“极简快速上手 ➔ 核心技术实现原理（ASCII 架构图、Connect-RPC 协议转译、CDP 动态注入、专属解锁协议隔离）➔ 开发者指南”的三段式文档体系；
  - 纠正全量架构与功能预览截图，单图独占一行，图文严格对齐。

## v0.5.12 - 2026-09-13

- 修复 Windsurf / Devin 接入后每次启动都弹出「安装似乎损坏，请重新安装」（`Your XXX installation appears to be corrupt. Please reinstall.`）：
  - 根因：VS Code 完整性校验在 workbench 启动时，会按 `product.json` 的 `checksums` 清单逐一校验核心文件（`workbench.html`、`workbench.desktop.main.js`、`sessions.*` 等共 10 个）的 SHA-256；AnyBridge 注入模型卡片脚本会改写 `workbench.html`，哈希必然失配。且 Windsurf / Devin 未配置 `checksumFailMoreInfoUrl`，提示走的是纯 `notificationService.notify` 分支，连「不再提示」按钮都没有，用户根本无法关闭。
  - 修复：接入代理时一并接管 `product.json`——先备份为 `product.json.byok-origin`（与汉化插件的 `.origin` 互不覆盖），再清空顶层 `checksums` 清单；workbench 的 `_isPure()` 拿到空清单时循环 0 次，直接判定 `isPure=true`，提示从源头消失。整个过程不改动任何核心文件内容，还原直连时连同备份一起还原，两者失败互不影响。
  - 未采用「重算哈希写回 checksums」的做法：`workbench.html` 常被汉化插件同时改写，重算后插件再改一次仍会失配，只能反复修补，故选择一次性清空。
  - 新增 5 项单测覆盖 `checksums` 定位边界：嵌套同名键、顶层值恰为字符串 `"checksums"`、值为 `null`、无该字段、值内含转义引号与花括号。

## v0.5.11 - 2026-09-11

- 修复 macOS 版代理无法启动：sidecar 启动瞬间被系统以信号 5（SIGTRAP）终止，界面报「代理主端口 7450 未监听」。
  - 根因：Tauri 2 的 `bundle.macOS.hardenedRuntime` 默认为 `true`，签名时会以 Hardened Runtime 签署 bundle 内全部可执行文件（含 externalBin）；项目此前未配置 entitlements，pkg 打在 Node.js 运行时上的 `anybridge-proxy` 缺少 `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory`，V8 初始化时无法申请 JIT 可执行内存而被 trap。
  - 修复：新增 `src-tauri/entitlements.plist` 并在 `tauri.conf.json` 的 `bundle.macOS.entitlements` 引用，只声明 JIT 必需项，不额外放宽库校验（`disable-library-validation`）。
  - 发布门禁：移除会被 Tauri 覆盖的打包前预签名，改为在打包后校验最终 `AnyBridge.app`——整包 `codesign --verify --deep --strict`、断言 sidecar 的 Hardened Runtime 标记与两项 JIT entitlement，并用独立配置目录做 5 秒启动冒烟，被信号终止即中断发布。
- 诊断增强：sidecar 退出状态为信号 5 时，日志按平台给出可读说明（macOS 指向 JIT entitlement，其他 Unix 指向通用断点/陷阱）。
- 发布门禁修正（v0.5.9 / v0.5.10 均未对外发布，签名链路本身是正常的）：
  - 第一版把 sidecar 的 Hardened Runtime 断言写成匹配孤立的 `(runtime)`，而实际 flags 为 `0x10002(adhoc,runtime)`，必然匹配失败；
  - 第二版改用 `plutil -extract` 读取 entitlement，但该命令把 key 中的 `.` 当作 keypath 分隔符，`com.apple.security.cs.allow-jit` 被解析为嵌套路径而永远取不到值；
  - 现改为匹配 `flags=0x<hex>(...runtime`，并用 plistlib 解析导出的 entitlement plist。

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
- 恢复默认使用 Connect-RPC 原生流错误帧（`BYOK_NATIVE_ERRORS=true`），避免错误进入会话上下文与会话标题。
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
