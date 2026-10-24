/**
 * AnyBridge Devin 界面汉化（源自 Kite devin-better.js 汉化模块，v8.x 实战打磨）
 * 引擎：MutationObserver 实时翻译 + 3s 定时全量兜底 + 防误伤体系
 *   - EXCLUDE_SELECTOR：编辑器/终端/文件树/标签页/状态栏等禁翻区
 *   - code/kbd/samp/var 仅在真正的代码容器内才跳过（设置描述里的 <code> 正常翻译）
 *   - 模型名保护（MODEL_LABEL_SKIP_RE）+ 描述性词汇豁免（MODEL_DESC_RE）
 *   - 标点中文化 + 前缀锚定（'...' 长短语）+ 软翻译（DOM 拆分兜底）
 * 词典：TRANSLATIONS 静态 + REGEX_TRANSLATIONS 正则 + SOFT_TRANSLATIONS 软替换
 */
(function () {
	'use strict';
	const LOG_PREFIX = '[AnyBridge-Loc]';
	const settings = { localizationEnabled: true, localizationMode: 'realtime' };
	// ========== 汉化功能 ==========
	// v8.5.5：把"易被误伤"的元素（code/kbd/samp/var）从 EXCLUDE_SELECTOR 拆出，
	// 仅当其祖先含 CODE_CONTEXT_REQUIRED 之一时才算"代码区"才跳过。
	// 解决"设置面板里 <code> 描述（如"Automatically detect a network proxy..."）被误屏蔽"的问题。
	const EXCLUDE_SELECTOR = [
		// ── 编辑器与代码区 ──
		'.monaco-editor', '.monaco-diff-editor',
		'[class*="diffEditor"]', '[class*="diff-editor"]',
		'[class*="codeBlock"]', '[class*="code-block"]',
		'.hljs', '[class*="hljs"]',                   // highlight.js（含变体）
		'.shiki', '[class*="shiki"]',                  // Shiki 语法高亮器
		'[class*="language-"]',                        // Prism / 通用 language-xx 标记
		'[class*="token"]',                            // Prism / Monaco token spans
		'pre',                                          // <pre> 代码块容器（保留）
		'textarea', 'input', '[contenteditable="true"]',
		// ── 终端 / 输出区 ──
		'.xterm', '.terminal', '.debug-console',
		'[id*="workbench.panel.output"]',              // 输出面板
		'[id*="workbench.panel.markers"]',             // 问题/诊断面板
		// ── 自家 UI 不翻译 ──
		'.ws-bubbles', '.ws-better-panel', '#ws-recovery-toast',
		// ── Windsurf 模型选择器面板 ──
		'[aria-label*="Model Selector"]', '[aria-label*="\u6a21\u578b\u9009\u62e9"]',
		'[class*="model-selector"]', '[class*="modelSelector"]',
		// ── 文件名/路径相关：禁止翻译文件夹/文件名 ──
		'.explorer-folders-view',                      // 资源管理器文件树
		'[id*="workbench.view.explorer"]',             // Explorer 视图容器
		'[id*="workbench.view.search"]',               // 搜索结果
		'[id*="workbench.view.scm"]',                  // 源代码管理（变更文件列表）
		'.outline-tree',                               // 大纲视图
		'.monaco-list-row[role="treeitem"]',           // 任意树视图的行
		'.monaco-icon-label',                          // 带图标的文件/路径标签
		'.breadcrumbs',                                // 面包屑导航
		'.tabs-container .tab',                         // 编辑器标签页
		'.editor-group-container .title',              // 编辑器组标题区
		'.statusbar',                                  // 状态栏（含文件路径/git 分支）
		// ── Cascade 聊天代码/工具调用区 ──
		'[class*="markdown-body"]', '[class*="markdownBody"]',  // markdown 渲染容器（含代码块）
		'[class*="tool-call"]', '[class*="toolCall"]', '[class*="tool_call"]',  // 工具调用展示
		'[class*="code-citation"]', '[class*="codeCitation"]',  // 代码引用
		'[class*="file-citation"]', '[class*="fileCitation"]',  // 文件引用
		'[class*="diff-line"]', '[class*="diffLine"]',          // 内嵌 diff 行
		'[data-language]',                             // 标注了语言的代码块容器
		'[role="code"]',                               // ARIA code 角色
		// ── 笔记本 ──
		'.notebook-editor', '.notebook-cell-list',
		'[class*="cell-editor-part"]',
		// ── Quick Pick / 命令面板（常含文件路径） ──
		'.quick-input-widget',
		'.quick-input-list',
		// ── Hover 浮窗里的代码 ──
		'.monaco-hover code',
		'.monaco-hover pre',
		// ── Notification 中的命令/路径 ──
		'.notification-list-item-source',
		'.notification-list-item-detail-row code'
	].join(', ');

	// 仅当"易误伤"元素（code/kbd/samp/var）在真正的代码容器中时才跳过。
	// 单独的 <code> 在设置描述里很常见，不应被屏蔽。
	const CODE_CONTEXT_REQUIRED = '.monaco-editor, .monaco-diff-editor, [class*="diffEditor"], [class*="diff-editor"], [class*="codeBlock"], [class*="code-block"], .hljs, [class*="hljs"], .shiki, [class*="shiki"], [class*="language-"], [class*="token"], pre, [class*="markdown-body"], [class*="markdownBody"], [class*="tool-call"], [class*="toolCall"], [class*="tool_call"], [class*="code-citation"], [class*="codeCitation"], [class*="file-citation"], [class*="fileCitation"], [class*="diff-line"], [class*="diffLine"], [data-language], [role="code"], .notebook-editor, .notebook-cell-list, [class*="cell-editor-part"], .monaco-hover, .xterm, .terminal, .debug-console';
	const FRAGILE_INLINE_TAGS = 'code, kbd, samp, var';
	// 模型名标识正则：文本包含已知模型/智能体名称时跳过翻译（避免翻译模型限定词如 Thinking/Fast/Medium）
	// v8.5.6：放宽 - 只匹配"短且像模型限定词"的文本。含 devin 但长度 > 30 视为产品名/描述，跳过此检查
	const MODEL_LABEL_SKIP_RE = /\b(claude|gpt-?\d|gpt-?o|o\d-|gemini|llama|qwen|deepseek|mistral|mixtral|swe-?\d|grok|haiku|sonnet|opus|codestral|devstral|devin)\b/i;
	// 描述性词汇指示符：含这些词时认为是描述/说明文字而非模型标签，不跳过翻译
	// v8.5.6：扩展词汇表，覆盖"长描述句"的常见特征词（detect/reload/setting/...）
	const MODEL_DESC_RE = /\b(for|via|using|with|agent|coding|powered|based|built|available|supported|requires?|enables?|provides?|settings|apply|saved|balance|draw|from|describe|task|detect|reload|enable|disable|when|will|this|that|default|click|select|enter|input|edit|change|update|reload|reload|reloads|reload|please|note|tip|hint|info|warning|error|failed|success|complete|reopen|restart|reset|clear|remove|delete|add|create|new|import|export|download|upload|view|open|close|save|cancel|confirm|run|start|stop|pause|resume|show|hide|display|render|compute|process|handle|manage|configure)\b/i;
	const ATTRS_TO_TRANSLATE = ['aria-label', 'title', 'placeholder', 'data-tooltip'];
	
	const TRANSLATIONS = new Map([
		// ========== Section 标题 ==========
		['User Interface', '用户界面'],
		['Devin Tab', 'Devin 补全'],
		['Shortcuts', '快捷键'],
		['Advanced', '高级'],
		['General', '通用'],
		['Editor', '编辑器'],
		['Cascade', 'Cascade'],
		['Cascade Configuration', 'Cascade 配置'],
		['Notifications', '通知'],
		['Agent', '智能体'],
		['Agents', '智能体'],
		['Settings', '设置'],
		['Account', '账户'],
		['Profile', '个人资料'],
		['Subscription', '订阅'],
		
		// ========== User Interface 设置 ==========
		['Show Inlay Shortcuts', '显示内联快捷键'],
		['Show in-line shortcut actions while the cursor is on an empty line', '当光标在空行上时，显示行内快捷操作'],
		['Show Explain Problem Inlay Hint', '显示问题解释内联提示'],
		['Show in-line explain problem actions while the cursor is on a line with an error squiggle', '当光标所在行有错误波浪线时，在行内显示解释问题的操作'],
		['Show Selection Popup', '显示选区弹窗'],
		['Show clickable shortcut popup when selecting text', '选中文本时显示浮动快捷弹窗'],
		['Scroll to Next Diff on Accept', '接受时滚动到下一个差异'],
		['Automatically scroll to the next Diff when accepting the current one', '接受当前差异时自动滚动到下一个差异'],
		
		// ========== Windsurf Tab 设置 ==========
		['Completion Mode', '补全模式'],
		['Choose your preferred code completion experience', '选择你偏好的代码补全体验'],
		['Aggression', '主动程度'],
		['Controls how proactively Supercomplete suggests edits near your cursor', '控制 Supercomplete 在光标附近主动建议编辑的频率'],
		['Tab to Jump', 'Tab 跳转'],
		['Predict the location of your next edit and navigates you there with a tab keypress', '预测下一个编辑位置，按 Tab 跳转到该位置'],
		['Tab to Import', 'Tab 导入'],
		['Quickly add and update imports with a tab keypress', '按 Tab 快速添加和更新导入语句'],
		['Clipboard Context', '剪贴板上下文'],
		['When enabled, Devin will use the clipboard as context for completions', '启用后，Devin 将使用剪贴板内容作为补全的上下文'],
		['Auto-Generate Memories', '自动生成记忆'],
		['When enabled, Cascade will autonomously generate memories to remember important context. When disabled, Cascade will only create memories when you explicitly ask', '启用后，Cascade 将自动生成记忆以记住重要上下文。禁用后，Cascade 仅在你明确要求时创建记忆'],
		['Allow Cascade in Background', '允许 Cascade 在后台运行'],
		['When enabled, Devin will allow Cascade to run in the background. When disabled, switching conversations will stop Cascade. Terminal commands may run in the background depending on your Terminal Auto Execution setting', '启用后，Devin 允许 Cascade 在后台运行。禁用后，切换对话将停止 Cascade。终端命令可能根据你的终端自动执行设置在后台运行'],
		['Auto-Continue', '自动继续'],
		['Controls whether Cascade automatically continues when it reaches the invocation limit. When on, Cascade continues indefinitely without prompting. When off, Cascade stops at the invocation limit and asks you to continue', '控制 Cascade 达到调用限制时是否自动继续。开启时，Cascade 无限期继续而无需提示。关闭时，Cascade 在调用限制处停止并询问你是否继续'],
		['Disable Fast Context Agent', '禁用快速上下文智能体'],
		['Disable the Fast Context agent that executes parallel searches as a subagent', '禁用执行并行搜索的快速上下文智能体'],
		['Arena Always Open Fullscreen', 'Arena 始终全屏打开'],
		['When enabled, Arena mode sessions will automatically open in the editor tab for a side-by-side view', '启用后，Arena 模式会话将自动在编辑器标签页中打开以进行并排视图'],
		['Cascade Completion Notifications', 'Cascade 完成通知'],
		['Show notifications when a Cascade finishes while in the background', '当 Cascade 在后台完成时显示通知'],
		['Always Notify on Cascade Completion', '始终通知 Cascade 完成'],
		['Show notifications when a Cascade finishes, even when the panel is open and focused', '当 Cascade 完成时显示通知，即使面板已打开且处于焦点状态'],
		['Read Claude Code Config', '读取 Claude Code 配置'],
		['When enabled, Cascade will read skills from .claude directories (both local .claude/skills/ and global ~/.claude/skills/)', '启用后，Cascade 将从 .claude 目录读取技能（包括本地 .claude/skills/ 和全局 ~/.claude/skills/）'],
		
		// ========== Cascade Configuration 设置 ==========
		['Explain and Fix in Current Conversation', '在当前对话中解释和修复'],
		['Send explain and fix request to the current conversation', '向当前对话发送解释和修复请求'],
		['Gitignore access', 'Gitignore 访问权限'],
		['Allow Cascade, tab, and supercomplete to view and edit the files in .gitignore', '允许 Cascade、tab 和 supercomplete 查看和编辑 .gitignore 中的文件'],
		['Cascade Auto-Fix Lints', 'Cascade 自动修复 Lint 错误'],
		['When enabled, Cascade is given awareness of lint errors created by its edits and may fix them without explicit user prompting. Note that this may increase Cascade\'s tool usage', '启用后，Cascade 会感知自身编辑引发的 lint 错误，并可能自动修复。注意：这可能会增加工具调用次数'],
		['Devin Preview', 'Devin 预览'],
		['When enabled, Cascade will be able to open local browser previews of sites running on development servers that Cascade has started. These browser previews provide special functionalities to integrate Cascade more tightly in the development cycle', '启用后，Cascade 可以打开其启动的开发服务器的本地浏览器预览，让 Cascade 更深度参与开发流程'],
		['Auto Execution', '自动执行'],
		['Disabled - All terminal commands require manual approval', '已禁用 - 所有终端命令需要手动批准'],
		['Auto Web Requests', '自动 Web 请求'],
		['Disabled - All web requests require manual approval', '已禁用 - 所有 Web 请求需要手动批准'],
		
		// ========== Advanced 设置 ==========
		['Search Max Workspace File Count', '最大工作区文件搜索数'],
		['Devin will attempt to compute embeddings for workspaces up to this many files. This file count ignores .gitignore and binary files. Raising this limit from the default value may lead to performance issues. Values 0 or below will be treated as unlimited', 'Devin 会对不超过此文件数的工作区生成索引（不含 .gitignore 和二进制文件）。调高此值可能影响性能，设为 0 或负数表示无限制'],
		['Open Editor Settings', '打开编辑器设置'],
		['For general editor settings, visit the Editor Settings Page', '对于常规编辑器设置，请访问编辑器设置页面'],
		['Customize Application Icon', '自定义应用图标'],
		['Choose your Devin Application Icon among a few custom presets', '从几个自定义预设中选择你的 Devin 应用图标'],
		['Enable ACP', '启用 ACP'],
		['Enable or disable ACP (Agent Client Protocol) entirely. When off, no agents are instantiated', '完全启用或禁用 ACP（代理客户端协议）。关闭时，不会实例化任何代理'],
		['Marketplace Extension Gallery Service URL', 'Marketplace 扩展库服务 URL'],
		['Change the base URL for marketplace search results. You must restart Devin to use the new marketplace after changing the value', '更改 marketplace 搜索结果的基础 URL。更改值后必须重启 Devin 才能使用新的 marketplace'],
		['Marketplace Gallery Item URL', 'Marketplace 库项目 URL'],
		['Changes the base URL on each extension page. You must restart Devin to use the new marketplace after changing this value', '更改每个扩展页面的基础 URL。更改值后必须重启 Devin 才能使用新的 marketplace'],
		
		// ========== Shortcuts 设置 ==========
		['Open Command', '打开命令'],
		['Open Chat with Cascade', '打开 Cascade 聊天'],
		['View All Devin shortcuts', '查看所有 Devin 快捷键'],
		['Open Command Palette', '打开命令面板'],
		['Change keybindings', '修改快捷键'],
		['Keyboard Shortcuts', '键盘快捷键'],
		['Reset to default shortcuts', '重置为默认快捷键'],
		['Reset to defaults', '重置为默认'],

		// ========== New Devin/Cascade Translations (v7.10.1) ==========
		['Plan information', '套餐信息'],
		['Plugins', '插件'],
		['Configuration file', '配置文件'],
		['Dismiss', '忽略'],
		['No items', '暂无内容'],
		['Go to output', '转到输出'],
		['Local', '本地'],
		['Worktree', '工作树'],
		['Cloud', '云端'],
		['Clear filter', '清除筛选'],
		['Preview', '预览'],
		['to switch agents', '以切换智能体'],
		['Search all models', '搜索所有模型'],
		['Start With History', '带着历史对话开始'],
		['View all Devin shortcuts', '查看所有 Devin 快捷键'],
		['View all Windsurf shortcuts', '查看所有 Windsurf 快捷键'],
		['Current plan', '当前套餐'],
		['Plan ends in 4 days', '计划在 4 天内结束'],
		['Allowed origins', '允许的源'],
		['Browse, install, and manage MCP servers from the Cascade MCP marketplace. Enable or disable servers and individual tools', '从 Cascade MCP 市场浏览、安装和管理 MCP 服务器。启用或禁用服务器及单个工具。'],
		['Open MCP marketplace', '打开 MCP 市场'],
		['Cascade keeps running when you switch conversations. Terminal commands may run in the background depending on your auto execution setting', '当您切换会话时，Cascade 将在后台保持运行。根据您的自动执行设置，终端命令可能会在后台运行。'],
		['Arena mode sessions open in the editor tab for a side-by-side view', '启用后，Arena 模式会话将自动在编辑器标签页中打开以进行并排视图。'],
		['Cascade continues past the invocation limit without prompting; otherwise it stops and asks you to continue', '控制 Cascade 达到调用限制时是否自动继续。开启时，Cascade 无限期继续而无需提示。关闭时，Cascade 在调用限制处停止并询问您是否继续。'],
		['Cascade automatically saves important context as memories; otherwise it saves only when you ask', 'Cascade 会自动将重要上下文保存为记忆；否则仅在您请求时保存'],
		['Cascade detects lint errors from its own edits and may fix them automatically. May increase tool usage', 'Cascade 会检测其自身修改引入的 lint 错误并尝试自动修复。这可能会增加工具使用量。'],
		['Cascade opens browser previews of dev servers it starts, integrating tightly with your workflow', 'Cascade 会为其启动的开发服务器打开浏览器预览，与您的工作流紧密集成。'],
		['Stops the fast context agent from running parallel searches as a subagent', '停止快速上下文智能体作为子代理执行并行搜索。'],
		['Cascade can perform web searches on the open internet. Reading specific URLs is unaffected and runs locally on your machine', 'Cascade 可以在互联网上执行网页搜索。读取特定 URL 的操作不受影响，且在您的本地机器上运行。'],
		['Send explain and fix requests to the open conversation instead of a new one', '将解释和修复请求发送到当前打开的对话中，而不是新建一个对话。'],
		['Let Cascade, tab, and supercomplete view and edit files in .gitignore', '允许 Cascade、Tab 补全和超级补全查看并编辑 .gitignore 中的文件。'],
		['Cascade reads skills from .claude directories (local .claude/skills/ and global ~/.claude/skills/)', 'Cascade 会从 .claude 目录中读取技能（包括本地 .claude/skills/ 和全局 ~/.claude/skills/）。'],
		['Allowlist - only allowlisted origins are auto-fetched', '允许列表 - 仅自动获取允许列表中的源'],
		['Turbo - all web requests are auto-fetched', '极速 - 所有 Web 请求均自动获取'],
		['Origins must include the scheme and port if non-default (e.g., "https://github.com" or "http://localhost:3000").', '如果不是默认端口，源（Origin）必须包含协议和端口（例如 "https://github.com" 或 "http://localhost:3000"）。'],
		['Origins Cascade auto-fetches URLs from', 'Cascade 会自动从中获取 URL 的源列表'],
		['Cascade will auto-run commands in the allowlist and ask for permission for commands in the denylist, with the denylist taking precedence. Add "*" at the end of a command for prefix matching (e.g., "git *" matches all git commands).', 'Cascade 将自动运行允许列表中的命令，并对拒绝列表中的命令请求许可，拒绝列表具有更高优先级。在命令末尾添加 "*" 可进行前缀匹配（例如，"git *" 匹配所有 git 命令）。'],
		['Patterns for commands that are always auto-executed', '始终自动执行的命令的匹配模式'],
		['Patterns for commands that are always denied', '始终拒绝的命令的匹配模式'],
		['Notify when Cascade finishes while running in the background', '当 Cascade 在后台运行完成时发送通知。'],
		['Persistent instructions that shape how Cascade behaves', '塑造 Cascade 行为的持久指令。'],
		['Saved prompts Cascade can follow. Type "/" in Cascade to trigger one', 'Cascade 可以遵循的已保存提示。在 Cascade 中输入 "/" 以触发。'],
		['View and edit memories Cascade generated', '查看和编辑 Cascade 生成的记忆。'],
		['Automatically detect a network proxy. Changing this reloads Devin', '自动检测网络代理。修改此项将重新加载并重启 Devin。'],
		['Maximum files Devin computes embeddings for, ignoring .gitignore and binary files. Higher values may hurt performance; 0 or below means unlimited', 'Devin 计算嵌入的最大文件数（忽略 .gitignore 和二进制文件）。值越大可能会影响性能；输入 0 或以下表示无限制。'],
		['The following workspace folder has a .windsurf/ directory. Would you like to rename it to .devin/?', '以下工作区文件夹包含 .windsurf/ 目录。您想将其重命名为 .devin/ 吗？'],
		['Rename', '重命名'],
		['Client windsurf: connection to server is erroring. Shutting down server.', '客户端 windsurf: 与服务器的连接发生错误。正在关闭服务器。'],
		['Client devin: connection to server is erroring. Shutting down server.', '客户端 devin: 与服务器的连接发生错误。正在关闭服务器。'],
		['These settings only apply to Devin CLI and are saved to c:\\Users\\admin\\AppData\\Roaming\\devin\\config.json', '这些设置仅适用于 Devin CLI，并保存至 c:\\Users\\admin\\AppData\\Roaming\\devin\\config.json'],
		['Browse, install, and manage MCP servers from the Devin MCP marketplace. Enable or disable servers and individual tools', '从 Devin MCP 市场浏览、安装和管理 MCP 服务器。启用或禁用服务器及单个工具。'],
		['Open Devin MCP marketplace', '打开 Devin MCP 市场'],
		['Browse and install MCP servers from the Devin MCP marketplace. Manage installed MCPs including enabling or disabling them at both server and individual tool level.', '从 Devin MCP 市场浏览并安装 MCP 服务器。管理已安装的 MCP，包括在服务器和单个工具级别启用或禁用它们。'],
		['Open Devin MCP Marketplace', '打开 Devin MCP 市场'],
		['Open the config.json file in the editor for advanced editing.', '在编辑器中打开 config.json 文件进行高级编辑。'],
		['Patterns for tools and commands that are always allowed', '始终允许的工具和命令的模式'],
		['Patterns for tools and commands that are always denied', '始终拒绝的工具和命令的模式'],
		['Patterns for tools and commands that require confirmation', '需要确认的工具和命令的模式'],
		['Devin uses your clipboard as context for completions', '启用后，Devin 将使用剪贴板内容作为补全的上下文'],
		['Add and update imports with a tab keypress', '按 Tab 键可快速添加并更新导入语句'],
		['Agents can be instantiated through the Agent Client Protocol', '智能体可以通过智能体客户端协议（ACP）进行实例化'],
		['Search agents...', '搜索智能体...'],
		['Makes Cascade available; otherwise only ACP agents can be used', '启用 Cascade；否则只能使用 ACP 智能体'],
		['Start a new Codex CLI session', '开始新的 Codex CLI 会话'],
		['Start a new Claude Agent session', '开始新的 Claude Code 会话'],
		['Devin Local', 'Devin 本地'],
		['Devin AI coding agent via Devin CLI', '通过 Devin CLI 的 Devin AI 编程智能体'],
		['Devin Cloud', 'Devin 云端'],
		['Claude Agent', 'Claude Code'],
		['ACP wrapper for Anthropic\'s Claude', 'Anthropic Claude 的 ACP 封装器'],
		['Codex CLI', 'Codex CLI'],
		['ACP adapter for OpenAI\'s coding assistant', 'OpenAI 编程助手的 ACP 适配器'],
		['Agoragentic', 'Agoragentic'],
		['Agent marketplace with 174+ AI capabilities. Browse, invoke, and pay for agent s...', '拥有 174+ AI 能力的智能体市场。浏览、调用并支付智能体服务...'],
		['Amp', 'Amp'],
		['ACP wrapper for Amp - the frontier coding agent', 'Amp (前沿编程智能体) 的 ACP 封装器'],
		['Auggie CLI', 'Auggie CLI'],
		['Augment Code\'s powerful software agent, backed by industry-leading context en...', 'Augment Code 的强大软件智能体，由行业领先的上下文增强支持...'],
		['Autohand Code', 'Autohand Code'],
		['Autohand Code - AI coding agent powered by Autohand AI', 'Autohand Code - 基于 Autohand AI 的 AI 编程智能体'],
		['Autonomous coding agent CLI - capable of creating/editing files, running comm...', '自主编程智能体 CLI - 能够创建/编辑文件、运行命令...'],
		['Codebuddy Code', 'Codebuddy Code'],
		['Tencent Cloud\'s official intelligent coding tool', '腾讯云官方智能编码工具'],
		['Cortex Code', 'Cortex Code'],
		['Snowflake\'s Cortex Code coding agent', 'Snowflake 的 Cortex Code 编程智能体'],
		['Corust Agent', 'Corust Agent'],
		['Co-building with a seasoned Rust partner.', '与资深 Rust 伙伴共同构建。'],
		['crow-cli', 'crow-cli'],
		['Minimal ACP Native Coding Agent', '极简 ACP 原生编程智能体'],
		['Cursor\'s coding agent', 'Cursor 的编程智能体'],
		['DeepAgents', 'DeepAgents'],
		['Batteries-included AI coding and general purpose agent powered by LangChain.', '基于 LangChain 的开箱即用 AI 编程及通用智能体。'],
		['DimCode', 'DimCode'],
		['A coding agent that puts leading models at your command.', '听从您指挥、驾驭前沿模型的编程智能体。'],
		['Dirac', 'Dirac'],
		['Reduces API costs by more than 50%, produces better and faster work. Uses Has...', '降低 API 成本超过 50%，产出更好更快的成果。使用 Has...'],
		['Factory Droid', 'Factory Droid'],
		['Factory Droid - AI coding agent powered by Factory AI', 'Factory Droid - 基于 Factory AI 的 AI 编程智能体'],
		['fast-agent', 'fast-agent'],
		['Code and build agents with comprehensive multi-provider support', '具备全面多服务商支持的编程与构建智能体'],
		['Gemini CLI', 'Gemini CLI'],
		['Google\'s official CLI for Gemini', '谷歌官方 Gemini CLI'],
		['GitHub\'s AI pair programmer', 'GitHub 的 AI 结对编程助手'],
		['GLM Agent', 'GLM Agent'],
		['ACP agent powered by Zhipu AI\'s GLM Coding Plan models (glm-5.1, glm-5-turb...', '基于智谱 AI GLM Coding Plan 模型（glm-5.1, glm-5-turb...）的 ACP 智能体'],
		['A local, extensible, open source AI agent that automates engineering tasks', '一个本地、可扩展、开源的 AI 智能体，可自动执行工程任务'],
		['Grok Build', 'Grok Build'],
		['xAI\'s coding agent and CLI', 'xAI 的编程智能体和 CLI'],
		['Junie', 'Junie'],
		['AI Coding Agent by JetBrains', 'JetBrains 推出的 AI 编程智能体'],
		['The open source coding agent', '开源编程智能体'],
		['Kimi CLI', 'Kimi CLI'],
		['Moonshot AI\'s coding assistant', 'Moonshot AI 的编程助手'],
		['Minion Code', 'Minion Code'],
		['An enhanced AI code assistant built on the Minion framework with rich develop...', '基于 Minion 框架构建的增强型 AI 代码助手，具有丰富的开发...'],
		['Mistral Vibe', 'Mistral Vibe'],
		['Mistral\'s open-source coding assistant', 'Mistral 的开源编程助手'],
		['Nova by Compass AI - a fully-fledged software engineer at your command', 'Compass AI 的 Nova - 听从您指挥的完全体软件工程师'],
		['pi ACP', 'pi ACP'],
		['ACP adapter for pi coding agent', 'pi 编程智能体的 ACP 适配器'],
		['Poolside\'s coding agent', 'Poolside 的编程智能体'],
		['Qoder CLI', 'Qoder CLI'],
		['AI coding assistant with agentic capabilities', '具有智能体能力的 AI 编程助手'],
		['Alibaba\'s Qwen coding assistant', '阿里巴巴的通义千问（Qwen）编程助手'],
		['Local-first coding agent. Runs entirely on your machine with optional on-device ...', '本地优先编程智能体。完全在您的机器上运行，支持可选的本地端...'],
		['Open-source DevOps agent in Rust with enterprise-grade security', '采用 Rust 编写的、具有企业级安全性的开源 DevOps 智能体'],
		['An open-source coding agent with LLM-native code understanding and robust s...', '一个开源编程智能体，具有 LLM 原生代码理解和强大的...'],
		// v8.5.8：扩长 anchor，覆盖 robust shel... 截断（+3 字符）
		['An open-source coding agent with LLM-native code understanding and robust shel', '一个开源编程智能体，具有 LLM 原生代码理解和强大的 shel'],
		['An open-source coding agent with LLM-native code understanding and robust she', '一个开源编程智能体，具有 LLM 原生代码理解和强大的 she'],
		['An open-source coding agent with LLM-native code understanding and robust sh', '一个开源编程智能体，具有 LLM 原生代码理解和强大的 sh'],
		['An open-source coding agent with LLM-native code understanding and robust ', '一个开源编程智能体，具有 LLM 原生代码理解和强大的 '],
		// Agoragentic 智能体描述（截图 5）
		['Agoragentic', 'Agoragentic'],
		['Agent marketplace with 174+ AI capabilities. Browse, invoke, and pay for agent s...', '聚合 174+ AI 能力的智能体市场。可浏览、调用和支付 agent s...'],
		['Agent marketplace with 174+ AI capabilities', '聚合 174+ AI 能力的智能体市场'],
		// VT Code 智能体名（保持英文）
		['VT Code', 'VT Code'],
		// 下拉菜单补充
		['Hide configuration', '隐藏配置'],
		['Show configuration', '显示配置'],
		
		// ========== 选项值 ==========
		// ['Low', '低'],     // 移除：保留原文（模型推理强度等上下文使用）
		['Conservative suggestions with higher confidence', '保守的建议，置信度更高'],
		// ['Medium', '中等'],  // 移除：保留原文
		['Balanced suggestions', '平衡的建议'],
		// ['High', '高'],    // 移除：保留原文
		['More frequent and ambitious suggestions', '更频繁、更大胆的建议'],
		['Supercomplete', '超级补全'],
		['Intelligent edit suggestions near your cursor', '光标附近的智能编辑建议'],
		['Autocomplete', '自动补全'],
		['Standard inline completions without side hint code box suggestions', '标准内联补全，不含侧边代码提示框'],
		['OFF', '关闭'],
		['Disable all code completions', '禁用所有代码补全'],
		['Disabled', '已禁用'],
		['Auto-execution is disabled for all commands', '所有命令的自动执行已禁用'],
		['Auto-fetching is disabled for all web requests', '所有 Web 请求的自动获取已禁用'],
		['Allowlist', '允许列表'],
		['Permission required', '需要权限'],
		['Allow for this session', '允许本次会话'],
		["Allow and don't ask again", '允许并不再询问'],
		['Never auto-execute commands unless they are in your allow list', '除非命令在你的允许列表中，否则不自动执行'],
		['Only auto-fetch URLs from origins in your allow list', '仅自动获取允许列表中来源的 URL'],
		['Auto', '自动'],
		['Cascade model will decide which commands are safe to auto-execute. This is only available for premium models', 'Cascade 模型将决定哪些命令可以安全地自动执行。此功能仅适用于高级模型'],
		['Turbo', '极速'],
		['Always auto-execute commands unless they are in your deny list. This also allows Cascade to auto-execute Browser controls', '自动执行命令，除非在拒绝列表中。同时允许 Cascade 自动控制浏览器'],
		['Always auto-fetch all web requests', '始终自动获取所有 Web 请求'],
		
		// ========== 通用选项 ==========
		['On', '开启'],
		['Off', '关闭'],
		['Enabled', '已启用'],
		['Yes', '是'],
		['No', '否'],
		['None', '无'],
		['Default', '默认'],
		['Custom', '自定义'],
		['Manual', '手动'],
		
		// ========== 其他界面文本 ==========
		['Search settings...', '搜索设置...'],
		['Search settings', '搜索设置'],
		['General editor preferences open in a separate page', '常规编辑器偏好设置在单独的页面中打开'],
		['My Team', '我的团队'],
		['Log in to Devin', '登录 Devin'],
		['Getting started with Devin', '开始使用 Devin'],
		['Code with Cascade', '使用 Cascade 编码'],
		['Edit code inline', '内联编辑代码'],
		['Open Agent Window', '打开智能体窗口'],
		['Thought', '思考'],
		['Created Todo List', '已创建任务列表'],
		['Analyzed content', '已分析内容'],
		// 'tasks done' 由正则 "N tasks done" 处理；单独出现见下方 1235 行
		// 'chunks' 不做静态翻译，避免误翻文件夹名
		['Predicts your next edit location and jumps there when you press tab', '预测您的下一个编辑位置，并在您按下 Tab 时跳转到该位置'],
		['Automatically detect a network proxy. Changing this reloads Devin', '自动检测网络代理。修改此项将重新加载并重启 Devin'],
		['No agents available', '暂无可用智能体'],
		['Currently: Cascade — cannot switch agents during an active session', '当前：Cascade — 活跃会话期间无法切换智能体'],
		['When enabled, messages will automatically include your recent coding history for better context awareness.', '启用后，消息将自动包含您最近的编码历史记录，以获取更好的上下文感知。'],
		['Failed to fetch document content at', '无法获取文档内容：'],
		['Markdown', 'Markdown'],
		['UTF-8', 'UTF-8'],
		['Ctrl', 'Ctrl'],
		['Shift', 'Shift'],
		['Alt', 'Alt'],
		['Cmd', 'Cmd'],
		['Win', 'Win'],
		['Detect Proxy', '自动检测代理'],
		['Enable automatic proxy detection. Toggling this will force Devin to reload', '启用自动代理检测。切换此选项将强制 Devin 重新加载'],

		// ========== MCP 相关 ==========
		['MCP Servers', 'MCP 服务器'],
		['Browse and install MCP servers', '浏览并安装 MCP 服务器'],
		['Open MCP Registry', '打开 MCP 注册表'],
		['Manage installed servers', '管理已安装的服务器'],
		['Install', '安装'],
		['Uninstall', '卸载'],
		['Server URL', '服务器 URL'],
		['Command', '命令'],
		['Environment Variables', '环境变量'],
		['Arguments', '参数'],
		['Headers', '请求头'],
		['Getting Started', '入门指南'],
		['No tools found', '未找到工具'],
		['All Tools', '所有工具'],
		['No description available', '无可用描述'],
		['required', '必需'],
		['secret', '机密'],
		['Remote Endpoints', '远程端点'],
		['Click **Install** to add this MCP server to your configuration', '点击 **安装** 将此 MCP 服务器添加到你的配置'],
		['Set the required environment variables below', '在下方设置必需的环境变量'],
		['The server\'s tools will be available in Cascade', '服务器的工具将在 Cascade 中可用'],

		// ========== Plan 和 Quota 相关 ==========
		['Plan ends', '套餐到期'],
		['Daily quota usage', '每日配额使用'],
		['Weekly quota usage', '每周配额使用'],
		['Extra usage balance', '额外使用余额'],
		['Purchase extra usage', '购买额外使用量'],
		['Auto refill settings', '自动充值设置'],
		['Configure auto refill', '配置自动充值'],
		['Manage your plan', '管理你的套餐'],
		['Upgrade', '升级'],
		['Downgrade', '降级'],
		['Cancel', '取消'],
		['Billing', '账单'],
		['Payment method', '支付方式'],
		['Invoice', '发票'],
		['Usage', '使用量'],
		['Resets daily', '每日重置'],
		['Resets weekly', '每周重置'],
		['Resets monthly', '每月重置'],
		['Trial', '试用'],
		['Free', '免费'],
		['Pro', '专业版'],
		['Plan Info', '套餐信息'],

		// ========== 右键菜单 / 面板菜单 ==========
		['Open Preview', '打开预览'],
		['Deploy', '部署'],
		['Download Trajectory', '下载对话记录'],
		['Cascade Usage', 'Cascade 使用量'],
		['Download Diagnostics', '下载诊断信息'],
		['Configure Rules', '配置规则'],
		['Configure Skills', '配置技能'],
		['Configure Workflows', '配置工作流'],
		['Edit Memories', '编辑记忆'],
		['MCPs', 'MCP 服务'],

		// ========== Customizations 页面 ==========
		['Customizations', '自定义'],
		['Customize Cascade to get a better, more personalized experience.', '自定义 Cascade，打造更个性化的体验。'],
		['Customize Cascade to get a better, more personalized experience', '自定义 Cascade，打造更个性化的体验'],
		['Learn more', '了解更多'],
		['Rules', '规则'],
		['Skills', '技能'],
		['Workflows', '工作流'],
		['Memories', '记忆'],
		['Rules help guide the behavior of Cascade. Global rules are automatically included in memory.', '规则帮助引导 Cascade 的行为。全局规则会自动包含在记忆中。'],
		['Workspace', '工作区'],
		['Global', '全局'],
		['Back', '返回'],
		['Cascade Rules', 'Cascade 规则'],
		['Rules help guide the behavior of Cascade.', '规则帮助引导 Cascade 的行为。'],
		['Manage rules', '管理规则'],
		['Workflows are saved prompts that Cascade can follow. To trigger a workflow, type "/" in Cascade.', '工作流是 Cascade 可以遵循的已保存提示。要触发工作流，在 Cascade 中输入 "/"。'],
		['Manage workflows', '管理工作流'],
		['Cascade Memories', 'Cascade 记忆'],
		['View and edit Cascade generated memories', '查看和编辑 Cascade 生成的记忆'],
		['View memories', '查看记忆'],
		['Manage', '管理'],
		['Search memories', '搜索记忆'],
		['Memories are automatically generated by Cascade to maintain context between conversations.', '记忆由 Cascade 自动生成，用于在对话之间保持上下文。'],
		['No auto-generated memories', '暂无自动生成的记忆'],

		// ========== Configuration 设置（截图3: 描述文本） ==========
		['Configuration', '配置'],
		['When enabled, Devin will allow Cascade to run in the background. When disabled, switching conversations will stop Cascade. Terminal commands may run in the background depending on your Terminal Auto Execution setting.', '启用后，Devin 允许 Cascade 在后台运行。禁用后，切换对话将停止 Cascade。终端命令可能根据你的终端自动执行设置在后台运行。'],
		['When enabled, Arena mode sessions will automatically open in the editor tab for a side-by-side view.', '启用后，Arena 模式会话将自动在编辑器标签页中打开以进行并排视图。'],
		['Show Allowlist', '显示允许列表'],
		['Disabled - All terminal commands require manual approval.', '已禁用 - 所有终端命令需要手动批准。'],
		['Allowlist - Only allowlisted terminal commands are auto-executed.', '允许列表 - 仅允许列表中的终端命令会自动执行。'],
		['Auto - The model decides whether to auto-execute a command (premium models only)', '自动 - 模型决定是否自动执行命令（仅限高级模型）'],
		['Turbo - All terminal commands are auto-executed (except those in the denylist)', '极速 - 所有终端命令自动执行（拒绝列表中的除外）'],
		['Disabled - All web requests require manual approval.', '已禁用 - 所有 Web 请求需要手动批准。'],
		['Allowlist - Only allowlisted origins are auto-fetched.', '允许列表 - 仅自动获取允许列表中来源的请求。'],
		['Turbo - All web requests are auto-fetched.', '极速 - 所有 Web 请求自动获取。'],
		['Controls whether Cascade automatically continues when it reaches the invocation limit. When on, Cascade continues indefinitely without prompting. When off, Cascade stops at the invocation limit and asks you to continue.', '控制 Cascade 达到调用限制时是否自动继续。开启时，Cascade 无限期继续而无需提示。关闭时，Cascade 在调用限制处停止并询问你是否继续。'],
		['When enabled, Cascade will autonomously generate memories to remember important context. When disabled, Cascade will only create memories when you explicitly ask.', '启用后，Cascade 将自动生成记忆以记住重要上下文。禁用后，Cascade 仅在你明确要求时创建记忆。'],
		['Auto-Open Edited Files', '自动打开编辑的文件'],
		['Open files in the background if Cascade creates or edits them', '如果 Cascade 创建或编辑了文件，则在后台打开它们'],
		['When enabled, Cascade is given awareness of lint errors created by its edits and may fix them without explicit user prompting. Note that this may increase Cascade\'s tool usage.', '启用后，Cascade 会感知自身编辑引发的 lint 错误，并可能自动修复。注意：这可能会增加工具调用次数。'],

		// ========== Enable Cascade ==========
		['Enable Cascade', '启用 Cascade'],
		['When disabled, Cascade is not available and only ACP agents can be used.', '禁用后，Cascade 将不可用，只能使用 ACP 智能体。'],

		// ========== Agent Diff Zones ==========
		['Agent Diff Zones', '智能体 Diff 区域'],
		['Show interactive diff zones with accept/reject controls for agent file edits', '显示带有接受/拒绝控件的交互式 diff 区域，用于智能体文件编辑'],

		// ========== 截图4: Enable Cascade Web Tools 等 ==========
		['Enable Cascade Web Tools', '启用 Cascade Web 工具'],
		['When enabled, Cascade can perform web searches on the open Internet. This does not affect Cascade\'s ability to read specific URLs, which is performed locally on your machine.', '启用后，Cascade 可以在互联网上执行 Web 搜索。这不影响 Cascade 读取特定 URL 的能力，该操作在本地执行。'],
		['Send explain and fix request to the current conversation.', '向当前对话发送解释和修复请求。'],
		['Allow Cascade, tab, and supercomplete to view and edit the files in .gitignore.', '允许 Cascade、Tab 和超级补全查看和编辑 .gitignore 中的文件。'],
		['When enabled, Cascade will read skills from .claude directories (both local .claude/skills/ and global ~/.claude/skills/).', '启用后，Cascade 将从 .claude 目录读取技能（包括本地 .claude/skills/ 和全局 ~/.claude/skills/）。'],
		['When enabled, Cascade will be able to open local browser previews of sites running on development servers that Cascade has started. These browser previews provide special functionalities to integrate Cascade more tightly in the development cycle.', '启用后，Cascade 可以打开其启动的开发服务器的本地浏览器预览，让 Cascade 更深度参与开发流程。'],
		['Disable the Fast Context agent that executes parallel searches as a subagent.', '禁用执行并行搜索的快速上下文子智能体。'],

		// ========== 截图5: Devin for Terminal ==========
		['Devin for Terminal', 'Devin 终端'],
		['Patterns for tools/commands that are always allowed.', '始终允许的工具/命令模式。'],
		['Patterns for tools/commands that are always denied.', '始终拒绝的工具/命令模式。'],
		['Patterns for tools/commands that require confirmation.', '需要确认的工具/命令模式。'],
		['Allow', '允许'],
		['Deny', '拒绝'],
		['Ask', '询问'],
		['Add Item', '添加项'],
		['Open config.json in editor', '在编辑器中打开 config.json'],

		// ========== 截图6: 高级页 ==========
		['Enable automatic proxy detection. Toggling this will force Devin to reload.', '启用自动代理检测。切换此选项将强制 Devin 重新加载。'],
		['Devin will attempt to compute embeddings for workspaces up to this many files. This file count ignores .gitignore and binary files. Raising this limit from the default value may lead to performance issues. Values 0 or below will be treated as unlimited.', 'Devin 会对不超过此文件数的工作区生成索引（不含 .gitignore 和二进制文件）。调高此值可能影响性能，设为 0 或负数表示无限制。'],
		['Enable or disable ACP (Agent Client Protocol) entirely. When off, no agents are instantiated.', '完全启用或禁用 ACP（代理客户端协议）。关闭时，不会实例化任何代理。'],

		// ========== 截图2: 设置页描述文本 ==========
		['Change the base URL for marketplace search results. You must restart Devin to use the new marketplace after changing the value.', '更改 Marketplace 搜索结果的基础 URL。更改值后必须重启 Devin 才能使用新的 Marketplace。'],
		['Base URL for marketplace search results. Restart Devin to use the new marketplace', 'Marketplace 搜索结果的基础 URL。重启 Devin 以使用新的 Marketplace'],
		['Available marketplace options.', '可用的 Marketplace 选项。'],
		['Available marketplace options', '可用的 Marketplace 选项'],
		['Changes the base URL on each extension page. You must restart Devin to use the new marketplace after changing this value.', '更改每个扩展页面的基础 URL。更改值后必须重启 Devin 才能使用新的 Marketplace。'],
		['Base URL on each extension page. Restart Devin to use the new marketplace', '每个扩展页面的基础 URL。重启 Devin 以使用新的 Marketplace'],
		['Available options.', '可用选项。'],
		['Available options', '可用选项'],
		['Browse and install MCP servers from the Cascade MCP store. Manage installed MCPs including enabling or disabling them at both server and individual tool level.', '从 Cascade MCP 商店浏览并安装 MCP 服务器。管理已安装的 MCP，包括在服务器和单个工具级别启用或禁用它们。'],

		// ========== 截图3: 面板设置 ==========
		['Advanced Settings', '高级设置'],
		['AI Shortcuts', 'AI 快捷键'],

		// ========== 通用操作 ==========
		['Enable', '启用'],
		['Disable', '禁用'],
		['Save', '保存'],
		['Delete', '删除'],
		['Edit', '编辑'],
		['Close', '关闭'],
		['Apply', '应用'],
		['Reset', '重置'],
		['Confirm', '确认'],
		['Search', '搜索'],
		['Refresh', '刷新'],
		['Copy', '复制'],
		['Paste', '粘贴'],
		['Undo', '撤销'],
		['Redo', '重做'],
		['Error', '错误'],
		['Warning', '警告'],
		['Info', '信息'],
		['Success', '成功'],
		['Loading', '加载中'],
		['Retry', '重试'],

		// ========== 模型选择相关 ==========
		['Search all models', '搜索所有模型'],
		['Available models', '可用模型'],
		['Small, fast, and cost-efficient model for simpler coding tasks.', '小巧、快速、成本更低，适合较简单的编码任务。'],
		['Small, fast, and cost-efficient model for simpler coding tasks', '小巧、快速、成本更低，适合较简单的编码任务'],
		['Group by', '分组'],
		['Adaptive', '自适应'],
		['Automatically balances quality and cost', '自动平衡质量和成本'],
		['Add Opus 4.5 for difficult problems and planning', '添加 Opus 4.5，用于困难问题和规划'],
		['Recently Used', '最近使用'],
		['Recommended', '推荐'],
		// ['New', '新'],  // 移除：模型徒章/徒章上下文保留原文
		// 'context' 不做静态翻译，避免误翻文件夹名；"NK context" 和 "context used" 已由正则/长短语覆盖
		// ['Thinking', '思考'],  // 移除：避免误翻模型限定词（带标点的 Thinking.. / Thinking. 仍正常翻译）
		['Cost', '成本'],
		['Higher effort consumes more tokens', '越高越消耗 tokens'],
		['Input', '输入'],
		['Cached input', '缓存输入'],
		['Effort', '推理强度'],
		['Output', '输出'],
		['tokens', 'tokens'],

		// ========== Cascade 输入框 chip 标签（截图 Cascade Agent Session） ==========
		// chip 格式: "Model: Default" / "Effort: High" / "Claude Haiku 5"
		// v8.5.7 补：Model / Effort 单独翻译，含冒号也支持
		['Model', '模型'],
		['Model: Default', '模型：默认'],
		['Model: ', '模型：'],
		['Effort: ', '推理强度：'],
		['Effort: high', '推理强度：高'],
		['Effort: High', '推理强度：高'],
		['Model default', '模型默认'],
		['Mode', '模式'],
		['Mode: Default', '模式：默认'],
		['Mode: ', '模式：'],
		['Mode default', '模式默认'],
		['Mode: Bypass Permissions', '模式：绕过权限'],
		['Effort: Medium', '推理强度：中'],
		['Effort: Low', '推理强度：低'],
		['Effort: medium', '推理强度：中'],
		['Effort: low', '推理强度：低'],
		// 模型选择 chip 文本（用户在 chip 上点击后展示的当前选中）
		['Claude Haiku 5', 'Claude Haiku 5'],

		// ========== Cascade Agent Session 页面（截图右下角） ==========
		['Cascade Agent Session', 'Cascade 智能体会话'],
		['Cascade Code Session', 'Cascade 代码会话'],
		['Claude Code', 'Claude Code'],  // 产品名保持英文
		['Start a new Claude Code session', '开启新的 Claude Code 会话'],

		// ========== 聊天模式相关 ==========
		['Code', '代码'],
		['Can write and edit code', '可以编写和编辑代码'],
		['Reads but won\'t edit', '读取但不会编辑'],
		['Plan changes before implementing', '先规划，再实施'],
		['Read Only', '只读'],
		['Codex can read files in the current workspace. Approval is required to edit files or access the internet.', 'Codex 可以读取当前工作区中的文件。编辑文件或访问互联网需要批准。'],
		['Codex can read files in the current workspace. Approval is required to edit files or access the internet', 'Codex 可以读取当前工作区中的文件。编辑文件或访问互联网需要批准'],
		['Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files. (Identical to Agent mode)', 'Codex 可以读取和编辑当前工作区中的文件，并运行命令。访问互联网或编辑其他文件需要批准。（等同于 Agent 模式）'],
		['Full Access', '完全访问'],
		['Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.', 'Codex 可以编辑此工作区外的文件并访问互联网，无需请求批准。使用时请谨慎。'],
		['Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using', 'Codex 可以编辑此工作区外的文件并访问互联网，无需请求批准。使用时请谨慎'],
		['Low', '低'],
		['Fast responses with lighter reasoning', '更快响应，推理更轻量'],
		['Medium', '中'],
		['Balances speed and reasoning depth for everyday tasks', '在日常任务中平衡速度与推理深度'],
		['High', '高'],
		['Greater reasoning depth for complex problems', '为复杂问题提供更深的推理'],
		['Xhigh', '超高'],
		['Extra high reasoning depth for complex problems', '为复杂问题提供额外高强度推理'],
		['Use a model classifier to approve/deny permission prompts', '使用模型分类器批准或拒绝权限提示'],
		['Standard behavior, prompts for dangerous operations', '标准行为，危险操作会提示确认'],
		['Accept Edits', '接受编辑'],
		['Auto-accept file edit operations', '自动接受文件编辑操作'],
		['Plan Mode', '计划模式'],
		['Planning mode, no actual tool execution', '计划模式，不实际执行工具'],
		['Don\'t Ask', '不询问'],
		['Don\'t prompt for permissions, deny if not pre-approved', '不提示权限请求，未预先批准则拒绝'],
		['Bypass Permissions', '绕过权限'],
		['Bypass all permission checks', '绕过所有权限检查'],
		['Use', '使用'],
		['to switch modes', '切换模式'],
		['Ask anything', '询问任何问题'],
		['Single', '单模型'],
		['Arena', '竞技场'],

		// ========== 输入框菜单 ==========
		['Mentions', '提及'],
		['Trigger Workflow', '触发工作流'],
		['Upload Image', '上传图片'],

		// ========== 顶部标签和按钮 ==========
		['Chat', '聊天'],
		['Composer', '编排'],
		['Documentation', '文档'],
		['Commit', '提交'],
		['Continue', '继续'],
		['Accept', '接受'],
		['Reject', '拒绝'],
		['Generating', '生成中'],
		['Complete', '完成'],
		['Insert', '插入'],

		// ========== AI补全相关 ==========
		['Codeium', 'Codeium'],
		['Generating code...', '正在生成代码...'],
		['Tab to accept', '按 Tab 接受'],
		['Press Tab to accept', '按 Tab 接受'],
		['for more options', '查看更多选项'],
		['Show next', '显示下一个'],
		['Show previous', '显示上一个'],

		// ========== 文件/编辑器相关 ==========
		['New File', '新文件'],
		['New Folder', '新文件夹'],
		['Open File', '打开文件'],
		['Open Folder', '打开文件夹'],
		['Save All', '保存全部'],
		['Close Editor', '关闭编辑器'],
		['Close All', '关闭全部'],
		['Split Editor', '拆分编辑器'],
		['Go to File', '转到文件'],
		['Go to Symbol', '转到符号'],
		['Find in Files', '在文件中查找'],
		['Replace in Files', '在文件中替换'],
		['Recent Files', '最近的文件'],
		['Clear Recent', '清除最近'],

		// ========== 终端相关 ==========
		['Terminal', '终端'],
		['New Terminal', '新建终端'],
		['Split Terminal', '拆分终端'],
		['Kill Terminal', '关闭终端'],
		['Clear', '清除'],
		['Scroll to bottom', '滚动到底部'],

		// ========== 状态相关 ==========
		['Ready', '就绪'],
		['Busy', '忙碌'],
		['Disconnected', '已断开'],
		['Connecting', '连接中'],
		['Syncing', '同步中'],
		['Indexing', '索引中'],
		['Analyzing', '分析中'],
		['Building', '构建中'],
		['Testing', '测试中'],
		['Debugging', '调试中'],

		// ========== Git相关 ==========
		['Source Control', '源代码管理'],
		['Changes', '更改'],
		['Staged Changes', '暂存更改'],
		['Untracked', '未跟踪'],
		['Modified', '已修改'],
		['Added', '已添加'],
		['Deleted', '已删除'],
		['Renamed', '已重命名'],
		['Message', '消息'],
		['Stage All', '全部暂存'],
		['Unstage All', '全部取消暂存'],
		['Discard Changes', '放弃更改'],
		['View Changes', '查看更改'],
		['Pull', '拉取'],
		['Push', '推送'],
		['Fetch', '获取'],
		['Sync', '同步'],
		['Branch', '分支'],
		['Create Branch', '创建分支'],
		['Switch Branch', '切换分支'],
		['Merge Branch', '合并分支'],
		['Delete Branch', '删除分支'],
		['Checkout', '签出'],
		['Cherry-pick', '遴选'],
		['Revert', '还原'],
		['Stash', '贮藏'],
		['Stash All', '全部贮藏'],
		['Pop Stash', '弹出贮藏'],
		['Drop Stash', '删除贮藏'],

		// ========== MCP Registry 页面 ==========
		['MCP Registry', 'MCP 注册表'],
		['Installed', '已安装'],
		['Available', '可用'],
		// 'tools' 不做静态翻译，避免误翻文件夹名；动态 "N tools" 已由 REGEX_TRANSLATIONS 覆盖
		['Enabled', '已启用'],
		['Error', '错误'],
		['No tools found.', '未找到工具。'],
		['Quota resets daily/weekly.', '配额每日/每周重置。'],
		['Purchase extra usage or manage auto refill', '购买额外使用量或管理自动充值'],

		// ========== Plan Info 页面（截图1） ==========
		['Daily quota usage:', '每日配额使用:'],
		['Weekly quota usage:', '每周配额使用:'],
		['Extra usage balance:', '额外使用余额:'],
		['Resets', '重置于'],
		['Plan', '套餐'],
		['Plan ends in', '套餐剩余'],
		['daily/weekly', '每日/每周'],
		// 'days' 不做静态翻译，避免误翻文件夹名；"Plan ends in N days" 已由正则覆盖

		// ========== Devin Terminal 描述（截图2） ==========
		['These settings only apply to Devin for Terminal and are saved to', '这些设置仅适用于 Devin 终端，并保存到'],

		// ========== Windsurf Tab 描述带句号版（截图3） ==========
		['When enabled, Devin will use the clipboard as context for completions.', '启用后，Devin 将使用剪贴板内容作为补全的上下文。'],
		['Quickly add and update imports with a tab keypress.', '按 Tab 快速添加和更新导入语句。'],
		['Predict the location of your next edit and navigates you there with a tab keypress.', '预测下一个编辑位置，按 Tab 跳转到该位置。'],
		['Controls how proactively Supercomplete suggests edits near your cursor.', '控制 Supercomplete 在光标附近主动建议编辑的频率。'],
		['Choose your preferred code completion experience.', '选择你偏好的代码补全体验。'],

		// ========== Agents 页面（截图1-4） ==========
		// 智能体卡片下拉菜单
		['Set as preferred', '设为首选'],
		['Remove as preferred', '取消首选'],
		['Configure', '配置'],
		// 智能体卡片下拉菜单（其他动作 - 截图3）
		['Hide configuration', '隐藏配置'],
		['Show configuration', '显示配置'],
		['Disable', '禁用'],
		['Enable', '启用'],
		['Uninstall', '卸载'],
		// Agent 配置面板 - 环境变量
		['No environment variables set.', '未设置环境变量。'],
		['No environment variables', '暂无环境变量'],
		['Add', '添加'],
		// 智能体描述（DOM 中省略号位置不固定，前缀兜底匹配，见 lookupTranslationPrefix）
		// 注：带 `...` 的智能体描述 key 已存在于上方的"智能体/ACP"分类中

		// ========== 高级设置 / 允许的源（截图5-6） ==========
		// 允许的源 - 底部按钮
		['Import', '导入'],
		['Export', '导出'],
		// 顶级 "Settings" 标题（截图1标签）
		['Settings', '设置'],
		// 底部状态栏（截图3）
		['Free - Upgrade Now', '免费版 - 立即升级'],

		// ========== 模型选择器分组菜单 ==========
		['Provider', '提供商'],
		['Input cost', '输入成本'],
		['Cached input cost', '缓存输入成本'],
		['Output cost', '输出成本'],
		['All models draw from your Devin ACU balance', '所有模型从你的 Devin ACU 余额中扣费'],

		// ========== 底部栏 ==========
		['Reject all', '全部拒绝'],
		['Accept all', '全部接受'],
		['Devin - Settings', 'Devin - 设置'],

		// ========== Cascade 状态文本 ==========
		['Surfing..', '驰骋中..'],
		['Surfing.', '驰骋中.'],
		['Exploring..', '探索中..'],
		['Exploring.', '探索中.'],
		['Floating..', '酝酿中..'],
		['Floating.', '酝酿中.'],
		['Thinking..', '思考中..'],
		['Thinking.', '思考中.'],
		['Generating..', '生成中..'],
		['Generating.', '生成中.'],
		['Sailing..', '航行中..'],
		['Sailing.', '航行中.'],

		// ========== 输入框/模式切换 ==========
		['Switch mode', '切换模式'],
		['+ Add', '+ 添加'],

		// ========== Skills 页面 ==========
		['Skills are rules or workflows with additional resources that the model can choose to invoke.', '技能是模型可以选择调用的规则或工作流，包含额外资源。'],
		// 'resources' 不做静态翻译，避免误翻文件夹名；动态 "N resources" 已由 REGEX_TRANSLATIONS 覆盖

		// ========== 发送按钮菜单 ==========
		['Queue', '排队发送'],
		['Send now', '立即发送'],

		// ========== 顶栏按钮 tooltip ==========
		['Past Conversations', '历史对话'],
		['Start a New Conversation', '开始新对话'],
		['Start recording', '开始录音'],
		['Add Context', '添加上下文'],
		['Model Selector', '模型选择'],
		['Conversation', '对话'],

		// ========== 欢迎页 ==========
		['Start', '开始'],
		['Generate a New Project', '创建新项目'],
		['Clone Repository', '克隆仓库'],
		['Connect via SSH', '通过 SSH 连接'],
		['Recent Projects', '最近的项目'],
		['Show More...', '显示更多...'],

		// ========== 会话管理页面 ==========
		['All sessions', '所有会话'],
		['New session', '新建会话'],
		['Spaces', '空间'],
		['Running', '运行中'],
		['Blocked', '已阻塞'],
		['Uncategorized', '未分类'],
		['Search sessions...', '搜索会话...'],
		['Search sessions', '搜索会话'],
		['Last 24 hours', '最近 24 小时'],
		['Include archived', '包含已归档'],
		['Rename', '重命名'],
		['Archive', '归档'],
		['Unarchive', '取消归档'],
		['Last run', '上次运行'],
		// 'files' 不做静态翻译，避免误翻文件夹名；"N files" 已由 REGEX_TRANSLATIONS 覆盖
		['cascade', 'cascade'],

		// ========== 文件变更区域 ==========
		['files with changes', '个文件有变更'],
		['View all', '查看全部'],
		['View all changes', '查看所有变更'],
		['MCP servers', 'MCP 服务器'],

		// ========== 会话筛选 ==========
		['Exclude archived', '排除已归档'],
		['Only archived', '仅已归档'],
		['Unassigned', '未分配'],
		['Time is', '时间为'],
		['just now', '刚刚'],

		// ========== 上下文/缓存状态 ==========
		['context used', '上下文已用'],
		['Prompt cache expires in', '提示缓存过期于'],
		['Send', '发送'],
		['message queued', '条消息排队中'],
		['1 message queued', '1 条消息排队中'],
		['2 messages queued', '2 条消息排队中'],
		['3 messages queued', '3 条消息排队中'],
		['Message with attachments', '带附件的消息'],
		['Enter to send queued message', '按回车发送排队消息'],
		['Queued messages will be sent one at a time. Click to send this message now.', '排队消息将逐条发送。点击可立即发送此消息。'],
		['Queued messages will be sent one at a time. Press', '排队消息将逐条发送。按'],
		['or click here to send the first queued message.', '或点击此处发送第一条排队消息。'],
		['messages queued', '条消息排队中'],

		// ========== 排队消息操作 ==========
		['Edit message', '编辑消息'],
		['Remove from queue', '从队列移除'],

		// ========== 终端命令相关 ==========
		['Command Auto-ran', '命令已自动运行'],
		['Copy command', '复制命令'],
		['Moves this terminal session to the Terminal tab in your IDE. Cascade will still be able to use it.', '将此终端会话移至 IDE 的终端标签页。Cascade 仍可使用它。'],
		['Review', '审查'],

		// ========== 欢迎页描述 ==========
		['Kick off a new project. Make changes across your entire codebase.', '启动一个新项目。在整个代码库中进行更改。'],

		// ========== 欢迎页快捷键 ==========
		['Cascade in new tab', '在新标签页中打开 Cascade'],

		// ========== 远程连接菜单 ==========
		['Connect to SSH Host...', '连接到 SSH 主机...'],
		['Connect to SSH Host in Current Window...', '在当前窗口连接到 SSH 主机...'],
		['Open Folder in Container', '在容器中打开文件夹'],
		['Attach to Running Container', '附加到运行中的容器'],
		['Reopen in Container', '在容器中重新打开'],
		['Connect to WSL', '连接到 WSL'],
		['Connect to WSL using Distro...', '使用发行版连接到 WSL...'],

		// ========== Cascade 对话区域 ==========
		['Thoughts', '思考过程'],
		['Analyzed', '已分析'],
		['tasks done', '个任务完成'],
		['more', '更多'],
		['Read', '读取'],

		// ========== 配额提示条 ==========
		['You\'ve used', '已使用'],
		['of your quota', '的配额'],
		['Quota resets', '配额重置于'],
		['Promo pricing is active for a limited time', '限时促销价生效中'],
		['tokens', 'tokens'],
		// ['Fast', '快速'],  // 移除：模型限定词，保留原文
		['Connecting to server...', '正在连接服务器...'],
		['Your included daily usage quota is exhausted.', '您的每日配额已用完。'],
		['Your included usage quota is exhausted.', '您的配额已用完。'],
		['to continue using premium models.', '以继续使用高级模型。'],
		['Purchase additional usage', '购买额外使用量'],

		// ========== Codemaps ==========
		['Codemaps', '代码地图'],
		['Suggestions from recent activity', '根据最近活动推荐'],
		['Your Codemaps', '你的代码地图'],
		['Search', '搜索'],
		['No codemaps found for this repository.', '此仓库未找到代码地图。'],
		['Show Archived Codemaps', '显示已归档的代码地图'],
		['Only Starred Codemaps', '仅显示星标代码地图'],
		['from recent activity', '根据最近活动'],

		// ========== 设置菜单 ==========
		['Devin Settings', 'Devin 设置'],
		['Devin Usage', 'Devin 用量'],
		['Quick Settings Panel', '快捷设置面板'],
		['Devin Account', 'Devin 账户'],
		// 'Docs' 不做静态翻译，避免误翻文件夹名（Docs 是常见目录名）
		['Join the Community', '加入社区'],
		['Changelog', '更新日志'],
		['Current Workspace', '当前工作区'],
		['now', '刚刚'],

		// ========== 文件编辑操作 ==========
		['edits', '处编辑'],
		['Accept File', '接受文件'],
		['Reject File', '拒绝文件'],

		// ========== 终端操作 ==========
		['Send Terminal to Chat', '发送终端到聊天'],
		['Send to Chat', '发送到聊天'],

		// ========== 回复操作按钮 ==========
		['Copy response', '复制回复'],
		['Create a Codemap', '创建代码地图'],
		['View response statistics', '查看回复统计'],
		['Other actions', '更多操作'],
		['Duplicate cascade', '复制对话'],
		['Create snapshot', '创建快照'],

		// ========== Web 请求弹窗 ==========
		['Allow web request?', '允许 Web 请求？'],
		['Cascade wants to fetch this URL', 'Cascade 想要访问此 URL'],
		['Allow Once', '允许一次'],
		['Always allow this page', '始终允许此页面'],
		['Allow all requests', '允许所有请求'],

		// ========== 回复截断 ==========
		['Cascade\'s response was cut short due to length limits.', 'Cascade 的回复因长度限制被截断。'],
		['Continue to generate the full response. This will consume the selected model\'s cost.', '继续生成完整回复。这将消耗所选模型的额度。'],
		['Continue response', '继续回复'],

		// ========== 预览/命令状态 ==========
		['Checked command status', '已检查命令状态'],
		['Running Preview:', '运行预览:'],
		['Open website preview in:', '在以下位置打开网站预览:'],
		['System Browser', '系统浏览器'],
		['In-IDE', 'IDE 内'],
		['BETA', 'BETA'],

		// ========== 超时/重试 ==========
		['This is taking a long time. Click to retry if it seems stuck.', '响应时间较长。如果卡住了，点击重试。'],
		// 'Surfing.' 已在上方 Cascade 状态文本区定义为 '驰骋中.'

		// ========== 允许/禁止列表 ==========
		['Hide Allow/Deny list', '隐藏允许/禁止列表'],
		['Show Allow/Deny list', '显示允许/禁止列表'],
		['Allow / Deny List', '允许 / 禁止列表'],
		['Allow List', '允许列表'],
		['Deny List', '禁止列表'],
		['If terminal command auto-execution is enabled, Cascade will auto-run commands in the allowlist and ask for permission for commands in the denylist, with the denylist taking precedence.', '当终端命令自动执行开启时，Cascade 会自动运行允许列表中的命令，并对禁止列表中的命令请求权限，禁止列表优先。'],
		['If terminal command auto-execution is disabled, Cascade will ask for permission for all commands.', '当终端命令自动执行关闭时，Cascade 会对所有命令请求权限。'],
		['Add " *" at the end of a command for prefix matching (e.g., "git *" matches all git commands).', '在命令末尾添加 " *" 进行前缀匹配（例如 "git *" 匹配所有 git 命令）。'],

		// ========== DeepWiki ==========
		// ========== 智能体/模型切换 ==========
		['Send the task to a single model', '发送任务到单个模型'],
		['Select multiple models to compare', '选择多个模型进行对比'],
		// 智能体/模型名称不翻译，保留原始标识
		// ['Devin Local', 'Devin 本地'],  // 移除
		['Describe your task to Devin', '向 Devin 描述你的任务'],
		['Switch agent location', '切换智能体位置'],
		['Switch agent', '切换智能体'],
		['See more', '查看更多'],
		['Model provider unreachable', '模型提供商不可达'],
		['Internal error: API Error: Request rejected (429) - Service Unavailable', '内部错误：API 错误：请求被拒绝 (429) - 服务不可用'],
		['Show logs', '显示日志'],
		['Show Logs', '显示日志'],
		['Authentication failed', '认证失败'],
		['Failed to activate agent', '激活智能体失败'],
		['Team settings refresh timed out', '团队设置刷新超时'],
		['Unable to connect to Devin. Some AI features may not work.', '无法连接到 Devin。部分 AI 功能可能不可用。'],
		['timed out', '超时'],
		['Canceled terminal command', '已取消终端命令'],
		['Cancelled terminal command', '已取消终端命令'],
		['Canceled', '已取消'],
		['Cancelled', '已取消'],
		['Purchase extra usage to continue using premium models', '购买额外用量以继续使用高级模型'],
		['Your included weekly usage quota is exhausted.', '您的每周配额已用完。'],
		['Your included weekly usage quota is exhausted', '您的每周配额已用完'],
		['Devin AI coding agent via Devin for Terminal', 'Devin AI 编程智能体，通过 Devin for Terminal'],
		// ['Devin Cloud', 'Devin 云端'],  // 移除：保留原始模型名
		['Cannot switch agents during an active session', '无法在活动会话期间切换智能体'],
		['Cannot switch modes after cascade has started', '无法在 Cascade 开始后切换模式'],
		['Reasoning Effort', '推理强度'],
		['Prompt cache has expired.', '提示缓存已过期。'],
		['Prompt cache has expired', '提示缓存已过期'],
		['Higher cost expected.', '预计费用更高。'],
		['Higher cost expected', '预计费用更高'],
		['Install Update', '安装更新'],
		['Your modified files:', '你修改的文件：'],
		['Your modified files', '你修改的文件'],
		['Auto-fix', '自动修复'],
		['Auto-continued', '自动继续'],

		['DeepWiki', 'DeepWiki'],
		['Welcome to DeepWiki', '欢迎使用 DeepWiki'],
		['Right-click on a symbol and select', '右键点击符号并选择'],
		['"See Wiki"', '"查看 Wiki"'],
		['to explore its definition, usage, and documentation.', '以查看其定义、用法和文档。'],
	
	// ========== AnyBridge 补丁（截图实测补充） ==========
	['Open editor settings', '打开编辑器设置'],
	['Start a new Codebuddy Code session', '开始新的 Codebuddy Code 会话'],
	['Tip: Type @ to conversation to bring in context from another chat', '提示：在对话中输入 @ 可从其他聊天中引入上下文'],
	['Extensions', '扩展'],
	['Quota resets daily/weekly', '配额每每日/每周重置'],
	// ========== AnyBridge 补丁 2：Devin App settings（截图实测补充） ==========
	['Back to app', '返回应用'],
	['App settings', '应用设置'],
	['Personal', '个人'],
	['Organization', '组织'],
	['Preferences', '偏好设置'],
	['Search settings...', '搜索设置...'],
	['Share terminal activity', '共享终端活动'],
	['Let Devin see commands and output from your integrated terminal.', '让 Devin 查看集成终端中的命令与输出。'],
	['Share user edits', '共享用户编辑'],
	['Let Devin see which files you edit and create in your workspace, and let a Devin Cloud session read unsaved edits when it reads a file on this machine.', '让 Devin 查看你在工作区中编辑和创建的文件；Devin Cloud 会话读取本机文件时也可读取未保存的编辑。'],
	['Run save actions on agent edits', '对智能体编辑执行保存操作'],
	['Run format-on-save and code actions on save (e.g. gofmt) when Devin edits a file.', '当 Devin 编辑文件时，执行保存时的格式化与代码操作（如 gofmt）。'],
	['Agent notifications', '智能体通知'],
	['Notify when an agent session finishes or needs your input while in the background', '智能体会话结束或在后台需要你输入时通知'],
	['Remote agent hosts', '远程智能体主机'],
	['Connect to agents on remote machines over SSH.', '通过 SSH 连接远程机器上的智能体。'],
	['Connect on startup', '启动时连接'],
	['Connect to saved hosts automatically on startup.', '启动时自动连接已保存的主机。'],
	['Auto-fix lints', '自动修复 lint'],
	['Devin detects lint errors from its own edits and may fix them automatically. May increase tool usage', 'Devin 检测自身编辑产生的 lint 错误并自动修复。可能增加工具使用量。'],
	['Devin continues past the invocation limit without prompting; otherwise it stops and asks you to continue', 'Devin 在达到调用上限后继续而不提示；否则会停下并询问是否继续。'],
]);
	
	const REGEX_TRANSLATIONS = [
		[/^for\s+(\d+)s$/i, '耗时 $1 秒'],
		[/^(\d+)\s+tasks$/i, '$1 个任务'],
		[/^(\d+)\s+chunks$/i, '$1 个分片'],
		[/^Failed to fetch document content at$/i, '无法获取文档内容：'],
		[/^Quota resets daily\/weekly\.\s*Plan ends in (\d+) days$/i, '配额每日/每周重置。套餐剩余 $1 天'],
		[/^Quota resets daily\/weekly$/i, '配额每日/每周重置'],
		[/^Plan ends in (\d+) days\s*\((.+)\)$/i, '套餐剩余 $1 天 ($2)'],
		[/\bPlan ends in (\d+) days\b/i, '套餐剩余 $1 天'],
		[/\b(\d+)% used\b/i, '$1% 已使用'],
		[/^These settings only apply to Devin for Terminal and are saved to\s*(.+)$/i, '这些设置仅适用于 Devin 终端，并保存到 $1'],
		[/^These settings only apply to Devin CLI and are saved to\s*(.+)$/i, '这些设置仅适用于 Devin CLI，并保存至 $1'],
		[/^These settings only apply to Devin Local and are saved to\s*(.+)$/i, '这些设置仅适用于 Devin Local，并保存至 $1'],
		[/^Augment Code['\u2019]s powerful software agent, backed by industry-leading context.+$/i, 'Augment Code 的强大软件智能体，由行业领先的上下文引擎支持'],
		[/^Autonomous coding agent CLI\s*-\s*capable of creating\/editing files, running comm.+$/i, '自主编程智能体 CLI，可创建/编辑文件、运行命令等'],
		[/^Reduces API costs by more than 50%, produces better and faster work\. Uses.+$/i, '降低 API 成本超过 50%，产出更好更快的成果'],
		[/^Plan ends in (\d+) days$/i, '计划在 $1 天内结束'],
		[/^Resets\s+(.+)$/i, '重置于 $1'],
		[/^(\d+)K context$/i, '$1K 上下文'],
		[/^\$([0-9.]+)\s*\/\s*1M tokens$/i, '$$$1 / 百万 tokens'],
		[/^(\d+)\s+tools$/i, '$1 个工具'],
		[/^(\d+)\s*\/\s*(\d+)\s+tools$/i, '$1 / $2 个工具'],
		[/^Switch mode\s*\((.+)\)$/i, '切换模式 ($1)'],
		[/^Queue\s*\((.+)\)$/i, '排队发送 ($1)'],
		[/^Send now\s*\((.+)\)$/i, '立即发送 ($1)'],
		[/^Send now\s+(.+)$/i, '立即发送 $1'],
		[/^Ask anything\s*\((.+)\)$/i, '询问任何问题 ($1)'],
		[/^(\d+)\s+resources$/i, '$1 个资源'],
		[/^Start a new (.+) session$/i, '开始新的 $1 会话'],
		[/^Start a New Conversation\s+(.+)$/i, '开始新对话 $1'],
		[/^Start recording\s*\((.+)\)$/i, '开始录音 ($1)'],
		[/^Add Context\s*\((.+)\)$/i, '添加上下文 ($1)'],
		[/^Model Selector\s*\((.+)\)$/i, '模型选择 ($1)'],
		[/^Past Conversations\s*\((.+)\)$/i, '历史对话 ($1)'],
		[/^Search all models\s*\((.+)\)$/i, '搜索所有模型 ($1)'],
		[/^(\d+)m ago$/i, '$1 分钟前'],
		[/^(\d+)h ago$/i, '$1 小时前'],
		[/^(\d+)d ago$/i, '$1 天前'],
		[/^(\d+)s ago$/i, '$1 秒前'],
		[/^(\d+)\s+files$/i, '$1 个文件'],
		[/^(\d+)\s+MCP servers?$/i, '$1 个 MCP 服务器'],
		[/^Rename\s+(\d+)\s+files?\s+(\d+)$/i, '重命名 $1 个文件 $2'],
		[/^Daily:\s*(\d+)%\s*quota used\s*[·\-]\s*Weekly:\s*(\d+)%\s*quota used$/i, '日配额已用 $1% · 周配额已用 $2%'],
		[/^Daily:\s*(\d+)%\s*quota used$/i, '日配额已用 $1%'],
		[/^Weekly:\s*(\d+)%\s*quota used$/i, '周配额已用 $1%'],
		[/^(\d+)%\s*quota used$/i, '配额已用 $1%'],
		[/^(\d+)\s+files with changes$/i, '$1 个文件有变更'],
		[/^(\d+)\s+files?\s+(\+\d+)\s+(-\d+)$/i, '$1 个文件 $2 $3'],
		[/^Prompt cache expires in\s+(.+)$/i, '提示缓存 $1 后过期'],
		[/^Send\s*\((.+)\)$/i, '发送 ($1)'],
		[/^(\d+)\s+messages?\s+queued$/i, '$1 条消息排队中'],
		[/^Enter to send queued message\s*\((.+)\)$/i, '按回车发送排队消息 ($1)'],
		[/^(\d+)\s*\/\s*(\d+)\s+tasks?\s+done$/i, '$1 / $2 个任务完成'],
		[/^(\d+)\s+tasks?\s+done$/i, '$1 个任务完成'],
		[/^(\d+)\s+more$/i, '还有 $1 项'],
		[/^Analyzed\s+(.+)$/i, '已分析 $1'],
		[/^Read\s+(.+)$/i, '读取 $1'],
		[/^You['\u2019]ve used\s+(\d+)%\s+of your quota\.?\s*Quota resets\s+(.+)$/i, '已使用 $1% 的配额。配额重置于 $2'],
		[/^You['\u2019]ve used\s+(\d+)%\s+of your quota$/i, '已使用 $1% 的配额'],
		[/^Quota resets\s+(.+)$/i, '配额重置于 $1'],
		[/^Your included daily usage quota is exhausted\.\s*(.+?)\s+to continue using premium models\.\s*(.+)$/i, '您的每日配额已用完。$1以继续使用高级模型。$2'],
		[/^Enter a starting point for a new codemap\s*\((.+)\)$/i, '输入新代码地图的起点 ($1)'],
		[/^Enter a starting point for a new codemap$/i, '输入新代码地图的起点'],
		[/^Devin Account\s*\((.+)\)$/i, 'Devin 账户 ($1)'],
		[/^(\d+)\s+edits?$/i, '$1 处编辑'],
		[/^Accept File\s+(.+)$/i, '接受文件 $1'],
		[/^Reject File\s+(.+)$/i, '拒绝文件 $1'],
		[/^Send Terminal to Chat\s*\((.+)\)$/i, '发送终端到聊天 ($1)'],
		[/^Cancel\s*\((.+)\)$/i, '取消 ($1)'],
		[/^Prompt cache expires in\s+(\d+:\d+)$/i, '提示缓存过期于 $1'],
		[/^Invalid argument:\s*an internal error occurred\s*\(trace ID:\s*([^)]+)\)$/i, '参数无效：发生内部错误（跟踪 ID：$1）'],
		[/^Permission denied:\s*all API providers are over their global rate limit for trial users\s*\(trace ID:\s*([^)]+)\)$/i, '权限拒绝：所有 API 提供商已达到试用用户的全局速率限制（跟踪 ID：$1）'],
		[/^Permission denied:\s*all API providers are over their global rate limit for trial users$/i, '权限拒绝：所有 API 提供商已达到试用用户的全局速率限制'],
		[/^Permission denied:\s*(.+?)\s*\(trace ID:\s*([^)]+)\)$/i, '权限拒绝：$1（跟踪 ID：$2）'],
		[/^Failed precondition:\s*(.+?)\s*\(trace ID:\s*([^)]+)\)$/i, '前置条件失败：$1（跟踪 ID：$2）'],
		[/^Resource exhausted:\s*(.+?)\s*\(trace ID:\s*([^)]+)\)$/i, '资源耗尽：$1（跟踪 ID：$2）'],
		[/^Internal error:\s*(.+?)\s*\(trace ID:\s*([^)]+)\)$/i, '内部错误：$1（跟踪 ID：$2）'],
		// 社区高频错误翻译
		[/^Deadline exceeded:\s*Encountered retryable error from model provider:\s*context deadline exceeded\s*\(Client\.Timeout or context cancellation while reading body\)$/i, '响应超时：模型提供商响应过慢被中断（流式读取超时）'],
		[/^Deadline exceeded:\s*(.+)$/i, '超时：$1'],
		[/^Cascade has encountered an internal error in this step\.\s*No credits consumed on this tool call\.$/i, 'Cascade 在此步骤遇到内部错误。本次工具调用未消耗额度。'],
		[/^Cascade has encountered an internal error in this step\.?$/i, 'Cascade 在此步骤遇到内部错误。'],
		[/^Encountered unexpected error during\s+(.+)$/i, '在 $1 期间遇到未预期错误'],
		[/^This request is taking longer than expected\.?$/i, '此请求耗时超出预期'],
		[/^Failed to log in:\s*\[deadline_exceeded\]\s*deadline_exceeded$/i, '登录失败：[超时] 登录态已失效'],
		[/^Cascade can make up to (\d+) tool calls per prompt\.?$/i, 'Cascade 每次提示最多可调用 $1 次工具'],
		[/^context length exceeded$/i, '上下文长度超限'],
		[/^prompt is too long$/i, '提示词过长'],
		[/^maximum context length\s*(.*)$/i, '已达最大上下文长度 $1'],
		[/^Send the task to a single model\s*\((.+)\)$/i, '发送任务到单个模型 ($1)'],
		[/^Select multiple models to compare\s*\((.+)\)$/i, '选择多个模型进行对比 ($1)'],
		[/^Switch agent location\s*\((.+)\)$/i, '切换智能体位置 ($1)'],
		[/^Switch agent\s*\((.+)\)$/i, '切换智能体 ($1)'],
		[/^Describe your task to Devin$/i, '向 Devin 描述你的任务'],
		[/^Invalid argument:\s*The third-party model provider is experiencing issues and is currently not available\.\s*Please try this model again later\.\s*\(trace ID:\s*([^)]+?)\)?\.?$/i, '参数无效：第三方模型提供商出现问题，当前不可用。请稍后重试此模型。（跟踪 ID：$1）'],
		[/^Invalid argument:\s*The third-party model provider is experiencing issues and is currently not available\.\s*Please try this model again later\.?$/i, '参数无效：第三方模型提供商出现问题，当前不可用。请稍后重试此模型。'],
		[/^Model provider unreachable$/i, '模型提供商不可达'],
		[/^Reached message rate limit for this model\.\s*Please try again later\.\s*Resets in:\s*(.+?)\s*$/i, '此模型已达到消息速率限制。请稍后再试。重置时间：$1'],
		[/^Reached message rate limit for this model\.\s*Please try again later\.?$/i, '此模型已达到消息速率限制，请稍后再试。'],
		[/^Purchase extra usage to continue using premium models\s*\u2192?$/i, '购买额外用量以继续使用高级模型 →'],
		[/^Cannot switch agents during an active session\s*\((.+)\)$/i, '无法在活动会话期间切换智能体 ($1)'],
		[/^Plan ends in (\d+) days?$/i, '套餐剩余 $1 天'],
		[/^(\d+)%\s*\(([^)]+)\)\s*context used$/i, '$1% ($2) 上下文已用'],
		[/^\(([^)]+)\)\s*context used$/i, '($1) 上下文已用'],
		[/^([\d.]+[KMB]?)\s*\/\s*([\d.]+[KMB]?)\s*context used$/i, '$1 / $2 上下文已用'],
		[/^([\d.]+[KMB]?)\s*context used$/i, '$1 上下文已用'],
	];

	// ========== 软翻译（子串替换）==========
	// 用于 DOM 文本节点被拆分（多个 <span>）导致整条锚定正则失败时的兜底
	// 仅替换关键短语，不依赖整文本匹配。注意：不要包含过短/过通用的英文词，避免误伤代码、文件名等
	const SOFT_TRANSLATIONS = [
		// 上下文使用量
		[/\bcontext used\b/gi, '上下文已用'],
		[/\bcontext window used\b/gi, '上下文窗口已用'],
		[/\bof context used\b/gi, '上下文已用'],
		[/\bquota used\b/gi, '配额已用'],
		[/\bquota remaining\b/gi, '剩余配额'],
		[/\bquota exhausted\b/gi, '配额已耗尽'],
		[/\bdaily quota\b/gi, '每日配额'],
		[/\bweekly quota\b/gi, '每周配额'],
		[/\busage limit\b/gi, '使用上限'],
		[/\busage exceeded\b/gi, '使用量已超限'],
		// 完整短语优先（更具体的放前面）
		[/\bYour included weekly usage quota is exhausted\.?/gi, '你的每周用量配额已耗尽。'],
		[/\bYour included daily usage quota is exhausted\.?/gi, '你的每日用量配额已耗尽。'],
		[/\bYour included usage quota is exhausted\.?/gi, '你的包含用量配额已耗尽。'],
		[/\bweekly usage quota is exhausted\b/gi, '每周用量配额已耗尽'],
		[/\bdaily usage quota is exhausted\b/gi, '每日用量配额已耗尽'],
		[/\busage quota is exhausted\b/gi, '用量配额已耗尽'],
		[/\bincluded usage\b/gi, '包含用量'],
		// 配额提示（与额度耗尽相关，常被拆分）
		[/\bof your quota\b/gi, '你的配额'],
		// 注意：更具体的 "Quota resets daily/weekly" 整体短语优先于裸 "Quota resets"
		[/\bQuota resets daily\/weekly\b/gi, '配额每日/每周重置'],
		[/\bQuota resets daily\b/gi, '配额每日重置'],
		[/\bQuota resets weekly\b/gi, '配额每周重置'],
		[/\bQuota will reset (?:in|at|on)\b/gi, '配额重置于'],
		[/\bQuota resets (?:in|at|on)\b/gi, '配额重置于'],
		[/\bResets in:\s*/gi, '重置时间：'],
		[/\bResets at\b/gi, '重置于'],
		// Plan 到期（拆分场景，无锚定）
		[/\bPlan ends in (\d+) days?\b/gi, '套餐剩余 $1 天'],
		[/\bdaily\/weekly\b/gi, '每日/每周'],
		[/\bdaily\b/gi, '每日'],
		[/\bweekly\b/gi, '每周'],
		[/\b(\d+)\s*days?\b/gi, '$1 天'],
		// 速率限制相关
		[/\bPlease try again later\.?/gi, '请稍后再试。'],
		[/\bPlease try again\.?/gi, '请重试。'],
		[/\bRate limit exceeded\b/gi, '速率限制超出'],
		// 用量预警
		[/\bUsage is high\b/gi, '使用量较高'],
		[/\bUsage warning\b/gi, '用量预警'],
		[/\ball providers? (?:are )?(?:exhausted|over capacity)\b/gi, '所有提供商均已耗尽'],
		// 状态/动作短语
		[/\bGenerating\b/gi, '生成中'],
		// [/\bThinking\b/gi, '思考中'],  // 移除：避免误翻模型限定词
		[/\bSearching\b/gi, '搜索中'],
		[/\bLoading\b/gi, '加载中'],
		[/\bConnecting\b/gi, '连接中'],
		[/\bRetrying\b/gi, '重试中'],
		[/\bWaiting\b/gi, '等待中'],
	];

	function applySoftReplacement(s) {
		let out = s;
		let changed = false;
		for (const [re, rep] of SOFT_TRANSLATIONS) {
			if (re.test(out)) {
				re.lastIndex = 0; // 重置 g 标志位
				out = out.replace(re, rep);
				changed = true;
			}
			re.lastIndex = 0;
		}
		return changed ? out : null;
	}
	
	function logLocalization(...args) { console.log(LOG_PREFIX + '[Localization]', ...args); }
	
	// 大小写不敏感的查找索引（小写键 -> 原始键），按需懒构建
	let _translationsLowerIndex = null;
	function getTranslationsLowerIndex() {
		if (_translationsLowerIndex) return _translationsLowerIndex;
		_translationsLowerIndex = new Map();
		for (const k of TRANSLATIONS.keys()) {
			const lk = k.toLowerCase();
			if (!_translationsLowerIndex.has(lk)) _translationsLowerIndex.set(lk, k);
		}
		return _translationsLowerIndex;
	}

	// 拆分尾部标点：返回 [核心, 尾部标点]
	// 尾部包含: . … ... : ; ! ? 。 ， ： ； ！ ？ 以及尖括号箭头 → ▸ ▾ 等装饰符（连同前置空白）
	const TRAILING_PUNCT_RE = /[\s\u00A0]*([.\u2026:;!?\u3002\uFF1A\uFF1B\uFF01\uFF1F]+|\.\.\.|[\u2192\u25B8\u25BE\u25BC])$/;
	function splitTrailingPunct(s) {
		const m = s.match(TRAILING_PUNCT_RE);
		if (!m) return [s, ''];
		return [s.slice(0, m.index), m[0]];
	}

	// 归一化内部空白（多空格、NBSP、零宽空格）
	function normalizeWhitespace(s) {
		return s
			.replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
			.replace(/\u00A0/g, ' ')
			.replace(/\s+/g, ' ');
	}

	// 标点尾部的中文化映射
	const PUNCT_CN_MAP = { '.': '。', ':': '：', ';': '；', '!': '！', '?': '？' };
	function localizePunct(p) {
		// 仅当尾部为单个 ASCII 标点时本地化；多字符（如 ... → 和组合符）原样返回
		if (p && p.length === 1 && PUNCT_CN_MAP[p]) return PUNCT_CN_MAP[p];
		// 处理 "..." -> "…"
		if (/^\.{3,}$/.test(p.trim())) return '…';
		return p;
	}

	function lookupTranslation(core) {
		// 1) 精确
		if (TRANSLATIONS.has(core)) return TRANSLATIONS.get(core);
		// 2) 大小写不敏感
		const idx = getTranslationsLowerIndex();
		const orig = idx.get(core.toLowerCase());
		if (orig) return TRANSLATIONS.get(orig);
		// 3) 前缀兜底匹配：处理 DOM 中省略号位置不固定导致的截断失配
		//    仅匹配字典 key 以 `...` 结尾的条目，且 core 长度 < key 长度
		//    例：dict key = "An enhanced AI code assistant ... develop..."
		//        DOM text = "An enhanced AI code assistant ... developm..."  (省略号前多了 1~N 字符)
		//    → 取 dict key 中第一个 "..." 之前的"锚定前缀"（至少 20 字符），在 core 中查找
		const prefixHit = lookupTranslationPrefix(core);
		if (prefixHit) return prefixHit;
		return null;
	}

	// 前缀兜底匹配索引：key 前缀(在第一个 `...` 之前) → value
	// 懒构建，键都是稳定长英文（≥ 20 字符），避免误伤短词
	let _translationsPrefixIndex = null;
	const PREFIX_ANCHOR_MIN_LEN = 20;
	function getTranslationsPrefixIndex() {
		if (_translationsPrefixIndex) return _translationsPrefixIndex;
		_translationsPrefixIndex = [];
		for (const k of TRANSLATIONS.keys()) {
			// 仅索引带 `...` 省略号的 key
			const dotIdx = k.indexOf('...');
			if (dotIdx < 0) continue;
			// 锚定前缀 = 第一个 `...` 之前的内容
			const anchor = k.substring(0, dotIdx).trim();
			if (anchor.length < PREFIX_ANCHOR_MIN_LEN) continue;
			// value = 翻译条目对应值的"前 dotIdx 字符"（同样去 `...`）
			const v = TRANSLATIONS.get(k) || '';
			const vAnchor = v.substring(0, dotIdx).trim();
			_translationsPrefixIndex.push({ anchor, vPrefix: vAnchor, fullKey: k });
		}
		return _translationsPrefixIndex;
	}

	function lookupTranslationPrefix(core) {
		const idx = getTranslationsPrefixIndex();
		const lower = core.toLowerCase();
		for (const { anchor, vPrefix } of idx) {
			// 字典锚点（去尾 `...` 后的稳定前缀）应出现在 core 中
			// 容忍 1~5 字符的尾部差异（DOM 截断可能多保留 1~N 字符）
			const minMatch = anchor.length;
			const maxMatch = anchor.length + 5;
			// core 的开头必须以 anchor 起始（DOM 截断只能让前缀更长）
			if (lower.length < minMatch || lower.length > maxMatch + 20) continue;
			if (!lower.startsWith(anchor.toLowerCase())) continue;
			// 命中：返回 value 前缀 + 省略号收尾（devin DOM 总是带 `...`）
			// vPrefix 已不含 `...`（构建索引时去掉了），此处统一补上
			return vPrefix + '...';
		}
		return null;
	}

	function applyRegex(core) {
		for (const [pattern, replacement] of REGEX_TRANSLATIONS) {
			if (!pattern || typeof pattern.test !== 'function') continue;
			if (pattern.test(core)) return core.replace(pattern, replacement);
		}
		return null;
	}

	function translateText(text) {
		if (!text || !text.trim()) return text;
		const leading = text.match(/^\s*/)?.[0] ?? '';
		const trailing = text.match(/\s*$/)?.[0] ?? '';
		let core = text.trim();

		// 跳过模型名标签（如 "Claude Opus 4.6 Thinking", "SWE-1.6 Fast"）
		// 短于 30 字符且包含已知模型标识 → 认为是模型限定词标签，不翻译
		// v8.5.6：阈值 80→30 - 避免把含"Devin/Windsurf"等品牌名的长描述句误判为模型标签
		// 含描述性词汇（for/via/agent 等）时例外，视为描述文字继续翻译
		if (core.length < 30 && MODEL_LABEL_SKIP_RE.test(core) && !MODEL_DESC_RE.test(core)) return text;

		// 第 1 轮：原文精确/大小写不敏感
		let hit = lookupTranslation(core);
		if (hit) return `${leading}${hit}${trailing}`;

		// 第 2 轮：归一化空白后查找
		const normalized = normalizeWhitespace(core);
		if (normalized !== core) {
			hit = lookupTranslation(normalized);
			if (hit) return `${leading}${hit}${trailing}`;
		}

		// 第 3 轮：剥离尾部标点后再查
		const [stripped, tail] = splitTrailingPunct(normalized);
		if (tail && stripped) {
			hit = lookupTranslation(stripped);
			if (hit) return `${leading}${hit}${localizePunct(tail)}${trailing}`;
		}

		// 第 4 轮：正则匹配（原文）
		let regHit = applyRegex(core);
		if (regHit) return `${leading}${regHit}${trailing}`;

		// 第 5 轮：正则匹配（归一化后）
		if (normalized !== core) {
			regHit = applyRegex(normalized);
			if (regHit) return `${leading}${regHit}${trailing}`;
		}

		// 第 6 轮：正则匹配（剥离尾部标点后）
		if (tail && stripped) {
			regHit = applyRegex(stripped);
			if (regHit) return `${leading}${regHit}${localizePunct(tail)}${trailing}`;
		}

		// 第 7 轮：软翻译子串替换（兜底，处理 DOM 拆分文本节点导致的半汉化）
		const softHit = applySoftReplacement(core);
		if (softHit) return `${leading}${softHit}${trailing}`;

		// 调试：记录翻译未命中（含英文但未匹配）
		try {
			if (typeof window !== 'undefined' && window.__wsI18nDebug) {
				if (core.length > 10 && core.length < 500 && /[A-Za-z]{8,}/.test(core)) {
					window.__wsI18nDebug.noMatch.push(core.slice(0, 200));
					if (window.__wsI18nDebug.noMatch.length > 200) window.__wsI18nDebug.noMatch.shift();
				}
			}
		} catch {}

		return text;
	}
	
	function isAllowedSettingsTreeExclusion(el) {
		return Boolean(el && el.matches && el.matches('.monaco-list-row[role="treeitem"]') && el.closest && el.closest('.settings-editor'));
	}

	function shouldSkip(node) {
		if (!node) return true;
		// 获取"祖先链上的第一个匹配 EXCLUDE_SELECTOR 的元素"
		const closestExcluded = (() => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				return node.closest && node.closest(EXCLUDE_SELECTOR);
			}
			const parent = node.parentElement;
			return parent && parent.closest ? parent.closest(EXCLUDE_SELECTOR) : null;
		})();
		if (closestExcluded && !isAllowedSettingsTreeExclusion(closestExcluded)) return true;
		// 易误伤的内联元素（code/kbd/samp/var）需要"祖先含代码容器"才算代码区
		// 单独 <code> 在设置描述里很常见，不应被屏蔽
		const fragile = (() => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				return node.matches && node.matches(FRAGILE_INLINE_TAGS);
			}
			const parent = node.parentElement;
			return parent && parent.matches && parent.matches(FRAGILE_INLINE_TAGS);
		})();
		if (fragile) {
			const root = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
			if (root && root.closest && root.closest(CODE_CONTEXT_REQUIRED)) {
				return true;
			}
		}
		return false;
	}

	function shouldSkipAttributes(el) {
		if (!el) return true;
		if (el.matches && el.matches('input, textarea')) {
			const parent = el.parentElement;
			return !parent || Boolean(parent.closest(EXCLUDE_SELECTOR));
		}
		return shouldSkip(el);
	}

	// 别名以兼容旧调用点
	const shouldSkipParent = (node) => shouldSkip(node);
	
	function translateAttributes(el) {
		if (!el || shouldSkipAttributes(el)) return;
		for (const attr of ATTRS_TO_TRANSLATE) {
			const value = el.getAttribute(attr);
			if (!value) continue;
			// 已翻译过的 attribute 不再处理（避免重复翻译破坏原值）
			if (el.hasAttribute('data-ws-orig-' + attr)) continue;
			const translated = translateText(value);
			if (translated !== value) {
				// 先存原值，再写翻译值，便于关闭汉化时还原
				el.setAttribute('data-ws-orig-' + attr, value);
				el.setAttribute(attr, translated);
			}
		}
	}
	
	// 翻译过的 textNode → 原文映射（用于关闭汉化时实时还原）
	// WeakMap 不阻止 GC，textNode 被移除后自动回收
	const _translatedTextNodes = new WeakMap();
	// 翻译过的 attribute → 原值（attr key: el + ':' + attr，存到 dataset）
	// 简化：每个被翻译的 attribute 在元素上记录 data-ws-orig-<attr>="<原值>"

	function translateTextNode(node) {
		if (!node || shouldSkip(node)) {
			// 调试：记录被跳过的原因到 window.__wsI18nDebug，便于排查未翻译文本
			try {
				if (typeof window !== 'undefined') {
					if (!window.__wsI18nDebug) window.__wsI18nDebug = { skipped: [], noMatch: [], translated: 0 };
					const original = node && node.nodeValue;
					if (original && original.trim().length > 10 && original.length < 500 &&
					    /[A-Za-z]/.test(original) && !/^[\u4e00-\u9fa5\s]+$/.test(original)) {
						const parent = node.parentElement;
						const skipReason = parent && parent.closest ? (() => {
							const m = parent.closest(EXCLUDE_SELECTOR);
							return m ? m.tagName.toLowerCase() + (m.className ? '.' + String(m.className).split(' ')[0] : '') : 'none';
						})() : 'no-parent';
						window.__wsI18nDebug.skipped.push({
							text: original,
							parentTag: parent ? parent.tagName : null,
							parentClass: parent ? String(parent.className || '').slice(0, 80) : null,
							skipReason,
						});
						if (window.__wsI18nDebug.skipped.length > 200) window.__wsI18nDebug.skipped.shift();
					}
				}
			} catch {}
			return;
		}
		const original = node.nodeValue;
		const translated = translateText(original);
		if (translated !== original) {
			node.nodeValue = translated;
			try {
				if (typeof window !== 'undefined' && window.__wsI18nDebug) window.__wsI18nDebug.translated++;
			} catch {}
			_translatedTextNodes.set(node, original);
			// 2) 同时把原文写到父元素 data-ws-orig（供错误检测等模块用）
			try {
				const parent = node.parentElement;
				if (parent && original && original.trim()) {
					const prev = parent.getAttribute('data-ws-orig') || '';
					if (!prev.includes(original)) {
						parent.setAttribute('data-ws-orig', prev ? prev + '\n' + original : original);
					}
					// 3) 短 CJK 翻译（标签/标题）防止 flex 压缩导致竖排
					// CJK 字符间每个都是断行点，flex min-content 会压缩到 1 字宽
					const trimmed = translated.trim();
					if (trimmed.length <= 10 && /[\u4e00-\u9fff]/.test(trimmed) && !parent.getAttribute('data-ws-nowrap')) {
						parent.style.whiteSpace = 'nowrap';
						parent.setAttribute('data-ws-nowrap', '1');
					}
				}
			} catch {}
		}
	}

	/** 还原汉化：遍历整个 document 找回所有翻译过的 textNode 还原回原文 */
	function revertLocalization() {
		// 1) 还原 textNode
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		let cur = walker.nextNode();
		let count = 0;
		while (cur) {
			const orig = _translatedTextNodes.get(cur);
			if (orig != null && orig !== cur.nodeValue) {
				cur.nodeValue = orig;
				count++;
			}
			cur = walker.nextNode();
		}
		// 2) 还原 attributes（从 data-ws-orig-<attr> 取回原值）
		document.querySelectorAll('*').forEach(el => {
			for (const attr of ATTRS_TO_TRANSLATE) {
				const stored = el.getAttribute('data-ws-orig-' + attr);
				if (stored != null) {
					el.setAttribute(attr, stored);
					el.removeAttribute('data-ws-orig-' + attr);
				}
			}
		});
		// 3) 还原彩虹文本元素
		document.querySelectorAll('[data-ws-rainbow]').forEach(el => {
			setSafeHTML(el, el.getAttribute('data-ws-rainbow'));
			el.removeAttribute('data-ws-rainbow');
			el.style.whiteSpace = '';
			count++;
		});
		// 4) 还原短 CJK 翻译的 nowrap
		document.querySelectorAll('[data-ws-nowrap]').forEach(el => {
			el.style.whiteSpace = '';
			el.removeAttribute('data-ws-nowrap');
		});
		// 5) 清理 data-ws-orig 标记（错误检测改读 textContent）
		document.querySelectorAll('[data-ws-orig]').forEach(el => el.removeAttribute('data-ws-orig'));
		console.log(LOG_PREFIX + '[Localization] 已还原 ' + count + ' 个 textNode');
	}
	
	function scanAndTranslate(root) {
		if (!root || !settings.localizationEnabled) return;
		if (root.nodeType === Node.TEXT_NODE) {
			// 节点已脱离 DOM 则跳过
			if (!root.parentNode || !root.parentNode.isConnected) return;
			translateTextNode(root);
			return;
		}
		
		const elementRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body;
		if (!elementRoot || !elementRoot.isConnected) return;
		// 整个 root 在排除区域内（如 Monaco 编辑器）→ 跳过整棵子树
		const closestExcludedRoot = elementRoot.closest && elementRoot.closest(EXCLUDE_SELECTOR);
		if (closestExcludedRoot && !isAllowedSettingsTreeExclusion(closestExcludedRoot)) {
			if (elementRoot.matches && elementRoot.matches('input, textarea')) {
				translateAttributes(elementRoot);
			}
			return;
		}
		
		translateAttributes(elementRoot);
		const elementList = elementRoot.querySelectorAll ? elementRoot.querySelectorAll('*') : [];
		for (const el of elementList) {
			translateAttributes(el);
		}
		
		const walker = document.createTreeWalker(elementRoot, NodeFilter.SHOW_TEXT);
		let current = walker.nextNode();
		while (current) {
			translateTextNode(current);
			current = walker.nextNode();
		}

		// ========== 彩虹文本合并翻译 ==========
		// 处理每个字符被单独 <span> 包裹（渐变/彩虹色）的情况：
		// 单个 textNode 只含 1-2 个字符，无法匹配完整翻译键。
		// 策略：找到 childNodes 全为内联元素且各含极短文本的父元素，
		// 拼合 textContent 后查翻译表，命中则整体替换。
		translateRainbowElements(elementRoot);

		// ========== 父容器兜底合并翻译（v8.5.4） ==========
		// 处理"描述文本被 React 等拆成多个 textNode"的情况：
		// 单 textNode 翻译可能因拆分而不命中；走父容器拼合后再查表。
		// 与 translateRainbowElements 不同：这里不要求"每 span 极短"，
		// 只要父容器整段是英文且长度适中即可尝试整段替换。
		translateParentFallback(elementRoot);
	}

	/** 检测并翻译"彩虹文本"（字符被拆分到多个 span 的元素） */
	function translateRainbowElements(root) {
		if (!root || !root.querySelectorAll) return;
		// 候选：含多个子元素、textContent 长度适中的元素
		const candidates = root.querySelectorAll('span, p, h1, h2, h3, h4, h5, h6, div, label, a, button');
		for (const el of candidates) {
			if (shouldSkip(el)) continue;
			// 已处理过则跳过
			if (el.hasAttribute('data-ws-rainbow')) continue;
			const children = el.childNodes;
			// 至少 3 个子节点且大部分是 element（span）
			if (children.length < 3) continue;
			let spanCount = 0;
			let totalTextLen = 0;
			for (const ch of children) {
				if (ch.nodeType === Node.ELEMENT_NODE && ch.tagName === 'SPAN') {
					spanCount++;
					totalTextLen += (ch.textContent || '').length;
				} else if (ch.nodeType === Node.TEXT_NODE) {
					totalTextLen += (ch.nodeValue || '').length;
				}
			}
			// 判定为彩虹文本：大部分子节点是 span 且平均每个 span 文本很短
			if (spanCount < 3 || spanCount / children.length < 0.6) continue;
			if (totalTextLen / spanCount > 3) continue; // 平均每 span 超过 3 字符则不是逐字拆分

			const combined = el.textContent.trim();
			if (!combined || combined.length > 200) continue;
			const translated = translateText(combined);
			if (translated && translated !== combined) {
				// 记录原始 HTML 用于还原
				el.setAttribute('data-ws-rainbow', el.innerHTML);
				el.textContent = translated;
				// 防止 CJK 字符逐字换行导致竖排（原 span 的 inline-block 阻止了换行，
				// 移除 span 后纯文本 CJK 在窄容器中会逐字断行）
				el.style.whiteSpace = 'nowrap';
			}
		}
	}

	/**
	 * 父容器兜底合并翻译（v8.5.4+）
	 * 场景：React 等 SPA 框架常把一段文本拆成多个 textNode（如"前导空格 + 文本"或"链接 + 文本"），
	 *       单 textNode 精确匹配 miss，整段合起来才能命中。
	 * 策略：对所有"非彩虹文本"的 p/div/span/label/a，若整段 textContent 是英文且
	 *       translateText 能命中，则直接用 textContent 替换原 innerHTML。
	 * 保守性：仅在子节点全是 textNode 或 inline 元素（无 form/控件）时执行，避免破坏复杂布局。
	 */
	function translateParentFallback(root) {
		if (!root || !root.querySelectorAll) return;
		const candidates = root.querySelectorAll('p, div, span, label, a, h1, h2, h3, h4, h5, h6, li, td, th');
		for (const el of candidates) {
			if (shouldSkip(el)) continue;
			if (el.hasAttribute('data-ws-rainbow')) continue;
			if (el.hasAttribute('data-ws-fallback')) continue;
			// 必须是叶子级或近叶子级（子节点是 textNode + inline 元素），否则整段替换会破坏布局
			const children = el.childNodes;
			if (children.length < 2) continue;
			// 检查子节点：允许 textNode + 1~N 个 inline 元素（如 span/a/strong），不允许 form/控件
			let allSafe = true;
			for (const ch of children) {
				if (ch.nodeType === Node.TEXT_NODE) continue;
				if (ch.nodeType === Node.ELEMENT_NODE) {
					const tag = ch.tagName;
					if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
						allSafe = false; break;
					}
				} else {
					allSafe = false; break;
				}
			}
			if (!allSafe) continue;
			const combined = (el.textContent || '').trim();
			if (!combined || combined.length < 20 || combined.length > 300) continue;
			// 必须是英文为主（避免破坏中英文混排和已有中文）
			const asciiLetters = (combined.match(/[A-Za-z]/g) || []).length;
			if (asciiLetters < combined.length * 0.5) continue;
			const translated = translateText(combined);
			if (translated && translated !== combined) {
				el.setAttribute('data-ws-fallback', el.innerHTML);
				el.textContent = translated;
			}
		}
	}
	
	let pendingRoots = new Set();
	let _locFlushTimer = 0;
	let _isTranslating = false;
	let localizationObserver = null;
	// 短 debounce：让快速连续 DOM 变更（切换聊天）合并为一次翻译
	// 60ms 足够让 React reconciliation 完成，又不会产生明显闪烁
	const LOC_DEBOUNCE_MS = 60;
	
	function flushQueue() {
		_locFlushTimer = 0;
		if (!settings.localizationEnabled) return;
		_isTranslating = true;
		try {
			for (const root of pendingRoots) {
				// 跳过已从 DOM 中移除的节点（切换聊天时旧节点被卸载）
				if (root && root.nodeType === Node.ELEMENT_NODE && !root.isConnected) continue;
				if (root && root.nodeType === Node.TEXT_NODE && (!root.parentNode || !root.parentNode.isConnected)) continue;
				scanAndTranslate(root);
			}
		} finally {
			_isTranslating = false;
			// 消耗掉由翻译自身产生的 mutations，断掉反馈环
			if (localizationObserver) localizationObserver.takeRecords();
		}
		pendingRoots.clear();
	}
	
	function enqueue(root) {
		pendingRoots.add(root || document.body);
		if (_locFlushTimer) clearTimeout(_locFlushTimer);
		_locFlushTimer = setTimeout(flushQueue, LOC_DEBOUNCE_MS);
	}
	
	let _locRescanTimer = 0;
	function startLocalizationObserver() {
		if (localizationObserver) localizationObserver.disconnect();
		localizationObserver = new MutationObserver((mutations) => {
			// 忽略自身翻译产生的 mutations（断掉 translate→observe→translate 反馈环）
			if (_isTranslating) return;
			for (const mutation of mutations) {
				if (mutation.type === 'characterData') {
					enqueue(mutation.target);
					continue;
				}
				if (mutation.type === 'attributes') {
					enqueue(mutation.target);
					continue;
				}
				for (const node of mutation.addedNodes) {
					enqueue(node);
				}
			}
		});
		
		localizationObserver.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ATTRS_TO_TRANSLATE,
		});

		// v8.6.4：定时全量重扫兜底（每 3 秒）
		// 原因：部分 DOM 变更不被 MutationObserver 捕获（React 并发模式/Shadow DOM/webview 等），
		// 导致已有翻译条目不生效。定时全扫确保遗漏的节点也能被翻译。
		if (!_locRescanTimer) {
			_locRescanTimer = setInterval(() => {
				if (!settings.localizationEnabled) return;
				enqueue(document.body);
			}, 3000);
		}
	}
	
	// (Settings UI removed — moved to sidebar panel)
	// ========== AnyBridge 启动入口 ==========
	// 与 Kite 的差异：不等 3s 定时兜底，先同步全量扫一遍再起 observer，
	// 首屏即刻中文（注入发生在页面加载早期，此时 DOM 尚未渲染完，
	// observer 会捕获后续增量；这里的全量扫兜住已存在的节点）。
	function anybridgeLocStart() {
		if (!settings.localizationEnabled) return;
		try { scanAndTranslate(document.body); } catch (e) { console.warn(LOG_PREFIX, '首次扫描失败:', e); }
		startLocalizationObserver();
	}
	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', () => setTimeout(anybridgeLocStart, 200));
	} else {
		setTimeout(anybridgeLocStart, 200);
	}
})();
