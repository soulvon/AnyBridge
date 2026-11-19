
  // 热更新词典合并：覆盖块由 AnyBridge 注入（get_hub_payload），缺失或类型不符时
  // 保持内置基线不动。写入端已做 JSON 自检，这里再挡一道外部脏数据。
  const hotDict = window.__ANYBRIDGE_HANS_DICT;
  if (hotDict && typeof hotDict === 'object') {
    for (const [en, zh] of Object.entries(hotDict)) {
      if (typeof en === 'string' && typeof zh === 'string' && en && zh) phrases.set(en, zh);
    }
  }

  // 根据长度倒序排序
  const sortedPhrases = Array.from(phrases.entries()).sort((a, b) => b[0].length - a[0].length);


  // 词条正则缓存
  const regexCache = new Map();
  function getPhraseRegex(source) {
    let cached = regexCache.get(source);
    if (!cached) {
      const escaped = source.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
      const startsWord = /^[A-Za-z0-9]/.test(source);
      const endsWord = /[A-Za-z0-9]$/.test(source);
      cached = new RegExp((startsWord ? '(?<![A-Za-z0-9])' : '') + escaped + (endsWord ? '(?![A-Za-z0-9])' : ''), 'g');
      regexCache.set(source, cached);
    }
    return cached;
  }

  function formatRelativeTime(str) {
    if (!str) return str;
    return str
      .replace(/(\d+)\s*years?\b/gi, (_m, n) => n + ' 年')
      .replace(/(\d+)\s*months?\b/gi, (_m, n) => n + ' 个月')
      .replace(/(\d+)\s*weeks?\b/gi, (_m, n) => n + ' 周')
      .replace(/(\d+)\s*days?\b/gi, (_m, n) => n + ' 天')
      .replace(/(\d+)\s*hours?\b/gi, (_m, n) => n + ' 小时')
      .replace(/(\d+)\s*minutes?\b/gi, (_m, n) => n + ' 分钟')
      .replace(/(\d+)\s*seconds?\b/gi, (_m, n) => n + ' 秒')
      .replace(/,\s*/g, ' ')
      .trim();
  }


  // 动态变量与模板匹配（仅针对含捕获组、时间、计算等动态规则）
  const dynamicPatterns = [
    // 动态权限请求
    [/Requesting permission to (read access to this path|write access to this path|reading this URL|executing actions on this URL|running this command|running this command outside the sandbox|using this MCP tool) (.+)/g, (_match, action, target) => {
      const actions = {
        'read access to this path': '读取此路径',
        'write access to this path': '写入此路径',
        'reading this URL': '读取此 URL',
        'executing actions on this URL': '在此 URL 上执行操作',
        'running this command': '运行此命令',
        'running this command outside the sandbox': '在沙盒外运行此命令',
        'using this MCP tool': '使用此 MCP 工具',
      };
      return '正在请求权限：' + (actions[action] ?? action) + ' ' + target;
    }],
    [/Agent needs permission to act on (.+)/g, '智能体需要权限才能操作 $1'],
    [/Agent needs permission to execute JavaScript on (.+)/g, '智能体需要权限才能在 $1 上执行 JavaScript'],
    [/Yes, save rule for '([^']+)' (when not in a project|in this project|in this workspace|globally)/g, (_m, target, scope) => {
      const scopes = { 'when not in a project': '在未处于项目时', 'in this project': '在此项目中', 'in this workspace': '在此工作区', 'globally': '全局' };
      return `是，并在${scopes[scope] || scope}保存 '${target}' 的规则`;
    }],
    [/Yes, save rule (when not in a project|in this project|in this workspace|globally)/g, (_m, scope) => {
      const scopes = { 'when not in a project': '在未处于项目时', 'in this project': '在此项目中', 'in this workspace': '在此工作区', 'globally': '全局' };
      return `是，并在${scopes[scope] || scope}保存规则`;
    }],
    [/Yes, and always allow '([^']+)'( (when not in a project|in this project|in this workspace))?/g, (_m, target, _p, scope) => {
      const scopes = { 'when not in a project': '在未处于项目时', 'in this project': '在此项目中', 'in this workspace': '在此工作区' };
      return `是，并${scope ? '在' + scopes[scope] : ''}始终允许 '${target}'`;
    }],
    [/Yes, and always allow( (when not in a project|in this project|in this workspace))?/g, (_m, _p, scope) => {
      const scopes = { 'when not in a project': '在未处于项目时', 'in this project': '在此项目中', 'in this workspace': '在此工作区' };
      return `是，并${scope ? '在' + scopes[scope] : ''}始终允许`;
    }],

    // 动态时间与耗时
    [/Worked for (\d+)\s*s\b/gi, '已工作 $1 秒'],
    [/Worked for (\d+)\s*m\b/gi, '已工作 $1 分钟'],
    [/Worked for (\d+)\s*h\b/gi, '已工作 $1 小时'],
    [/(\d+)\s*minutes?\s*ago\b/gi, '$1 分钟前'],
    [/(\d+)\s*hours?\s*ago\b/gi, '$1 小时前'],
    [/(\d+)\s*days?\s*ago\b/gi, '$1 天前'],
    [/(\d+)\s*weeks?\s*ago\b/gi, '$1 周前'],
    [/(\d+)\s*months?\s*ago\b/gi, '$1 个月前'],
    [/(\d+)\s*years?\s*ago\b/gi, '$1 年前'],
    [/Refreshes in (.+)/gi, (_m, time) => `${formatRelativeTime(time)}后刷新`],
    [/You have used (some|all) of your (weekly|5-hour) limit, it will (?:fully )?refresh in (.+?)\.?$/gi, (_m, qty, type, time) => {
      const isAll = qty.toLowerCase() === 'all';
      const typeZh = type.toLowerCase() === 'weekly' ? '周' : ' 5 小时';
      const action = isAll ? '已用尽' : '已使用部分';
      return `您${action}${typeZh}额度，将在 ${formatRelativeTime(time)}后完全刷新。`;
    }],
    [/^(\d+\s*(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?)(?:,\s*\d+\s*(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?))*)$/gi, (_m, dur) => formatRelativeTime(dur)],

    // 动态用量与数量词
    [/(\d+(?:\.\d+)?)% of the customization budget is available\./g, '自定义预算还剩 $1%。'],
    [/(\d+)\s*agents running/g, '$1 个代理正在运行'],
    [/See all \((\d+)\)/g, '查看全部 ($1)'],
    [/Show (\d+)\s*breakdowns?/gi, '显示 $1 个明细'],
    [/No more older messages, showing (\d+) of (\d+)/g, '没有更早的消息了，显示 $1 / $2'],
    [/showing (\d+) of (\d+)/gi, '显示 $1 / $2'],
    [/(\d+) files?, (\d+) folders?/gi, '$1 个文件, $2 个文件夹'],
    [/(\d+) files?, (\d+) searches?/gi, '$1 个文件, $2 次搜索'],
    [/(\d+)\s*folders?/gi, '$1 个文件夹'],
    [/(\d+)\s*files?/gi, '$1 个文件'],
    [/(\d+)\s*searches?/gi, '$1 次搜索'],
    [/(\d+)\s*search\b/gi, '$1 次搜索'],
    [/(\d+)\s*tokens?/gi, '$1 个 Token'],
    [/^(\d+)d$/g, '$1天'],
    [/^(\d+)m$/g, '$1分钟'],
    [/^(\d+)s$/g, '$1秒'],

    // 动态下拉与控件参数
    [/Toggle Agent(\s*\([^)]+\))?/g, '切换智能体$1'],
    [/Select (Next|Previous) (Conversation|对话)/g, (_m, dir) => `选择${dir === 'Next' ? '下一个' : '上一个'}对话`],
    [/Select model, current: (.+)/g, '选择模型，当前：$1'],
    [/Your Plan:\s*(.+)/g, '你的套餐：$1'],
    [/Autocomplete Speed:\s*(.+)/g, '补全速度: $1'],
    [/Send feedback as (.+)/g, '以 $1 发送反馈'],
    [/Gemini ([^(]+) \((High|Medium|Low)\)/g, (_match, model, effort) => {
      const efforts = { High: '高', Medium: '中', Low: '低' };
      return 'Gemini ' + model.trim() + ' (' + (efforts[effort] ?? effort) + ')';
    }],
    [/(Learn more|了解更多) about\s*(.+)/g, '了解更多关于 $2'],
  ];

  const patternsPost = [
    // 动态命令按钮兜底
    [/^Allow (.+)$/g, '允许 $1'],
    // 动态选项与操作
    [/^(.+)\s+options$/g, '$1 选项'],
    [/(?:刷新|Refresh)\s*MCP\s*servers?/gi, '刷新 MCP 服务器'],
    [/\btokens\)/gi, 'Token)'],
    // 量词与时间单位补齐
    [/(\d+)\s*搜索/g, '$1 次搜索'],
    [/(\d+)\s*days?\b/gi, '$1 天'],
    [/(\d+)\s*hours?\b/gi, '$1 小时'],
    [/(\d+)\s*minutes?\b/gi, '$1 分钟'],
    [/(\d+)\s*seconds?\b/gi, '$1 秒'],
    [/(\d+)\s*weeks?\b/gi, '$1 周'],
    [/(\d+)\s*months?\b/gi, '$1 个月'],
    [/(\d+)\s*years?\b/gi, '$1 年'],
  ];

  function replacePhrase(value, source, target) {
    const pattern = getPhraseRegex(source);
    return value.replace(pattern, target);
  }

  // 核心翻译流水线：优先纯静态最长匹配，再处理动态变量，最后后置微调
  function translate(value) {
    if (!value || !/[A-Za-z]/.test(value)) return value;
    let next = value;

    // 1. 优先使用纯静态精准词典（最长匹配优先）
    for (const [source, target] of sortedPhrases) {
      next = replacePhrase(next, source, target);
    }

    // 2. 处理动态变量与模板规则
    for (const [pattern, target] of dynamicPatterns) {
      next = next.replace(pattern, target);
    }

    // 3. 后置微调与插值收尾
    for (const [pattern, target] of patternsPost) {
      next = next.replace(pattern, target);
    }

    return next;
  }

  function shouldSkip(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return false;

    // 跳过代码与编辑区
    if (element.closest('script, style, textarea, code, pre, .xterm, .monaco-editor')) {
      return true;
    }

    // 跳过输入框
    if (node.nodeType === Node.TEXT_NODE) {
      if (element.closest('[contenteditable="true"], [contenteditable=""], input')) {
        return true;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // 跳过编辑框子节点
      const parent = node.parentElement;
      if (parent && parent.closest('[contenteditable="true"], [contenteditable=""], input')) {
        return true;
      }
    }

    // 跳过会话历史
    const historyItem = element.closest('.past-conversations, .conversation-list, .history-list, .conversations-list, [data-testid="history-list"], [data-testid="past-conversations"], .conversation-item, .convo-item, .history-item, [class*="history-item"], [class*="convo-item"]');
    if (historyItem) {
      const isActionBtn = element.closest('button[aria-label], button[title], [class*="delete"], [class*="pin"], [class*="archive"]');
      if (!isActionBtn) return true;
    }

    // 跳过用户输入
    if (element.closest('[data-testid="user-input-step"], [aria-label="User message"], [aria-label="用户消息"]')) {
      return true;
    }

    // 跳过回复正文（保留控件）
    const agentResponse = element.closest('[aria-label="Agent response"], [aria-label="智能体回复"]');
    if (agentResponse) {
      const isInteractive = element.closest('button, [role="button"], [class*="action"], [class*="button-container"]');
      if (!isInteractive) return true;
    }

    return false;
  }

  function isInAntigravityContainer(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return false;

    // 主窗口白名单
    const isMainWindow = window.location.pathname.endsWith('workbench.html') ||
      window.location.href.indexOf('/workbench.html') >= 0 ||
      window.location.href.indexOf('\\workbench.html') >= 0;
    if (!isMainWindow) return true;


    const containerSelector = [
      '[class*="antigravity"]',
      '[id*="antigravity"]',
      '[class*="jetski"]',
      '[id*="jetski"]',
      '.client-experience-pill',
      '.diff-hunk-widget',
      '.keep-changes',
      '.discard-changes',
      '.monaco-dialog-box',
      '.dialog-box',
      '[role="dialog"]',
      '.inline-chat-widget',
      '.inline-chat-overflow',
      '.monaco-hover',
      '.monaco-hover-content',
      '.context-view',
      '.monaco-select-box',
      '.monaco-menu',
      '.quick-input-widget',
      '.notification-toast',
      '.notifications-toasts',
      // VS Code/Antigravity IDE 设置页是异步渲染的，页面本身不一定带有
      // antigravity/jetski 类名；显式纳入设置容器，避免 Settings 页面被白名单过滤。
      '.settings-editor',
      '.settings-body',
      '[class*="settings"]',
      '[id*="settings"]',
      '#workbench\\.parts\\.titlebar .titlebar-right',
      '#workbench\\.parts\\.titlebar .action-label',
      '#workbench\\.parts\\.titlebar .action-nudge-button',
      '.antigravity-welcome-container',
      '[class*="welcome"]',
      '[class*="agent"]',
      '[id*="agent"]'
    ].join(', ');

    return !!element.closest(containerSelector);
  }

  function translateElement(element) {
    if (!isInAntigravityContainer(element)) return;
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = element.getAttribute?.(attr);
      if (!value) continue;
      const translated = translate(value);
      if (translated !== value) element.setAttribute(attr, translated);
    }
  }

  function translateNode(root) {
    if (!root) return;
    if (shouldSkip(root)) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (!isInAntigravityContainer(root)) return;
      if (root.__zh_patched) return;
      const val = root.nodeValue || '';
      const translated = translate(val);
      if (translated !== val) root.nodeValue = translated;
      root.__zh_patched = true;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (!root.__zh_patched) {
        // 节点可能先被插入、后被 React/Vue 补上容器 class。未处于目标容器时
        // 不能标记为已处理，否则后续容器就绪后不会再翻译它的子树。
        if (isInAntigravityContainer(root)) {
          translateElement(root);
          root.__zh_patched = true;
        }
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (shouldSkip(node)) continue;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!isInAntigravityContainer(node)) continue;
        if (node.__zh_patched) continue;
        const val = node.nodeValue || '';
        const translated = translate(val);
        if (translated !== val) node.nodeValue = translated;
        node.__zh_patched = true;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.__zh_patched) continue;
        if (!isInAntigravityContainer(node)) continue;
        translateElement(node);
        node.__zh_patched = true;
      }
    }
  }

  function run() {
    document.documentElement.lang = 'zh-CN';
    translateNode(document);

    new MutationObserver((mutations) => {
      const nodesToTranslate = [];
      const elementsToTranslate = [];

      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const target = mutation.target;
          target.__zh_patched = false;
          nodesToTranslate.push(target);
        } else if (mutation.type === 'attributes') {
          const target = mutation.target;
          target.__zh_patched = false;
          // 容器身份变化时要重新扫描整个子树；仅翻译属性本身会漏掉此前
          // 因未命中白名单而尚未处理的 Settings 子节点。
          if (mutation.attributeName === 'class' || mutation.attributeName === 'id' ||
              mutation.attributeName === 'role' || mutation.attributeName === 'data-testid') {
            nodesToTranslate.push(target);
          } else {
            elementsToTranslate.push(target);
          }
        } else {
          for (const node of mutation.addedNodes) {
            nodesToTranslate.push(node);
          }
        }
      }

      if (nodesToTranslate.length > 0 || elementsToTranslate.length > 0) {
        setTimeout(() => {
          for (const node of nodesToTranslate) {
            translateNode(node);
          }
          for (const el of elementsToTranslate) {
            translateElement(el);
          }
        }, 0);
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      // 监听容器身份变化。Settings 页面经常先挂载空节点，再异步补 class/id。
      attributeFilter: ['aria-label', 'title', 'placeholder', 'alt', 'class', 'id', 'role', 'data-testid'],
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
