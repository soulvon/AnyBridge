// antigravity_loc_payload.rs — 反重力高性能深度汉化注入脚本与词典
pub const HUB_LOCALIZATION_JS: &str = r#"
// Antigravity Chinese Localization Engine (Embedded Baseline)
(function() {
  if (window.__antigravityHansInjected) return;
  window.__antigravityHansInjected = true;

  // 合并策略：内置基线词典为底座，若上游热更新下载了词典则覆盖合并
  const DICT = Object.assign({}, {
    "File": "文件", "Edit": "编辑", "View": "视图", "Selection": "选择", "Find": "查找",
    "Help": "帮助", "Docs": "文档", "Toggle Developer Tools": "开发者工具", "New Window": "新窗口",
    "Quit": "退出", "Cancel": "取消", "Confirm Quit": "确认退出", "Connect to WSL": "连接到 WSL",
    "Reopen Locally": "本地重新打开", "Open Workspace": "打开工作区", "Open Folder": "打开文件夹",
    "Welcome to the new Antigravity!": "欢迎使用全新 Antigravity！",
    "Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named": "Antigravity 已经重构为以智能体为核心的全新平台。如果您仍需要代码编辑器，可以将其作为名为以下的独立应用下载：",
    "Download the Antigravity IDE": "下载 Antigravity IDE", "Explore the new Antigravity": "探索全新 Antigravity",
    "Agent": "智能体", "Agents": "智能体", "Subagent": "子智能体", "Subagents": "子智能体",
    "Task": "任务", "Tasks": "任务", "Workspace": "工作区", "Workspaces": "工作区",
    "Command": "命令", "Run": "运行", "Settings": "设置", "Model": "模型", "Stop": "停止",
    "Approve": "批准", "Reject": "拒绝", "Terminal": "终端", "Output": "输出",
    "Codebase": "代码库", "Error": "错误", "Success": "成功", "Pending": "等待中",
    "Running": "运行中", "Completed": "已完成", "Failed": "已失败", "Branch": "分支",
    "Merge": "合并", "Conflict": "冲突", "Active Agents": "活跃智能体", "Search": "搜索",
    "Search...": "搜索...", "Type a command...": "输入命令...", "Save": "保存", "Close": "关闭",
    "Status": "状态", "Progress": "进度", "Logs": "日志", "Console": "控制台",
    "Create Project": "创建项目", "New Project": "新建项目", "Create New Project": "创建新项目",
    "Open Project": "打开项目", "Reset Zoom": "重置缩放", "Toggle Fullscreen": "切换全屏",
    "Welcome to Antigravity": "欢迎使用 Antigravity", "Get Started": "开始使用",
    "Create an agent to get started": "创建一个智能体以开始", "New Agent": "新建智能体",
    "System Prompt": "系统提示词", "Description": "描述", "Capabilities": "能力",
    "Write Files": "写入文件", "Run Commands": "运行命令", "Web Browsing": "网页浏览",
    "Permissions": "权限", "Configure global allowed and denied resource permissions.": "配置全局允许与拒绝的资源访问权限。",
    "Project-Specific Settings": "项目专属设置", "File Permissions": "文件权限",
    "Network Permissions": "网络权限", "Terminal & Tooling Permissions": "终端与工具权限",
    "Appearance": "外观", "Choose light, dark, or inherit system settings.": "选择浅色、深色，或继承系统设置。",
    "Dark": "深色", "Light": "浅色", "Customizations": "自定义扩展",
    "Configure default behaviors, skills, and MCP servers.": "配置默认行为、技能以及 MCP 服务器。",
    "Token Usage": "Token 使用详情", "Account": "账号", "Shortcuts": "快捷键",
    "Provide Feedback": "提供反馈", "Check for Updates": "检查更新", "Up to date": "已是最新版本",
    "Planning Mode": "规划模式", "Planning Mode is ON": "规划模式已开启", "Planning Mode is OFF": "规划模式已关闭",
    "Implementation Plan": "实施计划", "Walkthrough": "变更回顾", "User Review Required": "需用户审批",
    "Open Questions": "待确认问题", "Proposed Changes": "拟定变更", "Verification Plan": "验证计划",
    "Automated Tests": "自动化测试", "Manual Verification": "手动验证", "Proceed": "继续执行",
    "Approve Plan": "批准计划", "Reject Plan": "拒绝计划", "Exit Planning Mode": "退出规划模式",
    "Rename": "重命名", "Mark Unread": "标记为未读", "Mark Read": "标记为已读", "Pin": "置顶",
    "Unpin": "取消置顶", "Archive": "归档", "Unarchive": "取消归档", "Copy": "复制",
    "Copied!": "已复制！", "Delete Conversation": "删除对话", "Side Question": "侧边提问",
    "Amend": "追加提交", "Amending...": "正在追加提交...", "Split": "分屏",
    "Split Right": "向右分屏", "Split Down": "向下分屏", "Split Terminal": "拆分终端",
    "Fork": "派生", "Fork Conversation": "派生对话", "Move to Group": "移动到分组",
    "New Group": "新建分组", "Create Group": "创建分组", "Delete Group": "删除分组",
    "Rename Group": "重命名分组", "Remove from Group": "从分组中移除", "No groups yet": "暂无分组",
    "Group By Project": "按项目分组", "Group By Workspace": "按工作区分组",
    "Ask anything, @ to mention, / for actions": "输入任何问题，输入 @ 提及，/ 触发操作",
    "Thought": "思考过程", "Thinking...": "思考中...", "Thinking": "思考中", "Ran": "运行",
    "Command Palette": "命令面板", "Keep computer awake": "保持电脑唤醒", "Run in background": "后台运行",
    "Always proceed": "总是直接执行", "Request review": "请求人工审查", "Proceed in sandbox": "在沙盒中直接执行",
    "Strict": "严格模式", "Agent decides": "智能体自主决定", "Turbo": "极速模式"
  }, window.__ANYBRIDGE_HANS_DICT || {});

  function shouldSkip(node) {
    if (!node) return true;
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (node.isContentEditable) return true;
    const cls = String(node.className || '');
    if (cls.includes('monaco-editor') || cls.includes('xterm') || cls.includes('code-block') || cls.includes('thinking-block')) return true;
    return false;
  }

  function translateText(str) {
    if (!str || typeof str !== 'string') return str;
    const trimmed = str.trim();
    if (!trimmed || trimmed.length < 2) return str;
    const direct = DICT[trimmed];
    if (direct) {
      return str.replace(trimmed, direct);
    }
    return str;
  }

  function walk(node) {
    if (shouldSkip(node)) return;
    if (node.nodeType === 3) {
      const original = node.nodeValue;
      const translated = translateText(original);
      if (translated !== original) {
        node.nodeValue = translated;
      }
      return;
    }
    if (node.nodeType === 1) {
      ['placeholder', 'title', 'aria-label'].forEach(attr => {
        const val = node.getAttribute(attr);
        if (val) {
          const trans = translateText(val);
          if (trans !== val) node.setAttribute(attr, trans);
        }
      });
      let child = node.firstChild;
      while (child) {
        walk(child);
        child = child.nextSibling;
      }
    }
  }

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const p = m.target.parentElement;
        if (!shouldSkip(p)) {
          const trans = translateText(m.target.nodeValue);
          if (trans !== m.target.nodeValue) m.target.nodeValue = trans;
        }
      } else if (m.type === 'childList') {
        for (const added of m.addedNodes) {
          walk(added);
        }
      }
    }
  });

  function start() {
    if (document.body) {
      walk(document.body);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } else {
      document.addEventListener('DOMContentLoaded', start);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
"#;

pub const IDE_LOCALIZATION_JS: &str = r#"
// Antigravity IDE Workbench Overlay Localization
(function() {
  if (window.__antigravityIdeHansInjected) return;
  window.__antigravityIdeHansInjected = true;

  const DICT = {
    "File": "文件", "Edit": "编辑", "Selection": "选择", "View": "视图", "Go": "转到",
    "Run": "运行", "Terminal": "终端", "Help": "帮助", "Search": "搜索", "Source Control": "源代码管理",
    "Run and Debug": "运行和调试", "Extensions": "扩展", "Settings": "设置", "Keyboard Shortcuts": "键盘快捷键",
    "Color Theme": "颜色主题", "File Icon Theme": "文件图标主题", "Check for Updates...": "检查更新...",
    "Toggle Full Screen": "切换全屏", "Toggle Zen Mode": "切换 Zen 模式", "Command Palette...": "命令面板...",
    "Open Folder...": "打开文件夹...", "Open Workspace from File...": "从文件打开工作区...",
    "Save": "保存", "Save As...": "另存为...", "Save All": "全部保存", "Close Window": "关闭窗口",
    "New Window": "新建窗口", "Close Workspace": "关闭工作区", "Close Editor": "关闭编辑器",
    "Cut": "剪切", "Copy": "复制", "Paste": "粘贴", "Undo": "撤销", "Redo": "重做", "Find": "查找",
    "Replace": "替换", "Toggle Word Wrap": "切换自动换行", "Output": "输出", "Problems": "问题",
    "Debug Console": "调试控制台", "Terminal": "终端", "Split Editor": "拆分编辑器",
    "Toggle Primary Side Bar": "切换主侧边栏", "Toggle Secondary Side Bar": "切换辅助侧边栏"
  };

  function translate(node) {
    if (!node || node.nodeType !== 3) return;
    const txt = node.nodeValue;
    if (!txt || txt.length < 2) return;
    const trimmed = txt.trim();
    if (DICT[trimmed]) {
      node.nodeValue = txt.replace(trimmed, DICT[trimmed]);
    }
  }

  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 3) translate(n);
          else if (n.nodeType === 1 && !n.classList.contains('monaco-editor')) {
            const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
            let cur = walker.nextNode();
            while (cur) { translate(cur); cur = walker.nextNode(); }
          }
        });
      }
    }
  });

  function start() {
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let cur = walker.nextNode();
      while (cur) { translate(cur); cur = walker.nextNode(); }
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
"#;
