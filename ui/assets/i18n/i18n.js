(function () {
  const DEFAULT_LANGUAGE = 'zh-CN';
  const CONFIG_KEY = 'APP_LANGUAGE';
  const LOCAL_STORAGE_KEY = 'byok-language';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
  const LANGUAGE_LABELS = {
    'zh-CN': '简体中文',
    'en-US': 'English'
  };
  const textSources = new WeakMap();
  let currentLanguage = DEFAULT_LANGUAGE;
  let observer = null;
  let translating = false;

  function catalogOf(language) {
    return (window.ByokI18nCatalog && window.ByokI18nCatalog[language])
      || (window.ByokI18nCatalog && window.ByokI18nCatalog[DEFAULT_LANGUAGE])
      || { translations: {} };
  }

  function normalizeLanguage(language) {
    const raw = String(language || '').trim().replace('_', '-');
    const lower = raw.toLowerCase();
    if (lower === 'zh' || lower === 'zh-cn' || lower === 'cn') return 'zh-CN';
    if (lower === 'en' || lower === 'en-us') return 'en-US';
    return window.ByokI18nCatalog && window.ByokI18nCatalog[raw] ? raw : DEFAULT_LANGUAGE;
  }

  function interpolate(text, params) {
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, key) => Object.prototype.hasOwnProperty.call(params, key) ? params[key] : m);
  }

  function translate(source, params, language) {
    const key = String(source == null ? '' : source);
    const lang = normalizeLanguage(language || currentLanguage);
    const catalog = catalogOf(lang);
    if (catalog.translations && Object.prototype.hasOwnProperty.call(catalog.translations, key)) {
      return interpolate(catalog.translations[key], params);
    }
    if (lang === 'en-US') {
      let m = key.match(/^共\s*(\d+)\s*个$/);
      if (m) return `Total ${m[1]}`;
      m = key.match(/^共\s*(\d+)\s*个结果$/);
      if (m) return `${m[1]} results`;
      m = key.match(/^(\d+)\/(\d+)\s*个结果$/);
      if (m) return `${m[1]}/${m[2]} results`;
      m = key.match(/^已选择\s*(\d+)\s*\/\s*(\d+)$/);
      if (m) return `Selected ${m[1]} / ${m[2]}`;
      m = key.match(/^已选择\s*(\d+)\s*\/\s*共\s*(\d+)\s*个$/);
      if (m) return `Selected ${m[1]} / Total ${m[2]}`;
      m = key.match(/^共\s*(\d+)\s*个可用模型/);
      if (m) return key.replace(/^共\s*(\d+)\s*个可用模型/, `Total $1 available models`);
      m = key.match(/^共\s*(\d+)\s*个模型/);
      if (m) return key.replace(/^共\s*(\d+)\s*个模型/, `Total $1 models`);
    }
    return interpolate(key, params);
  }

  function shouldSkip(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return true;
    return !!element.closest('[data-i18n-ignore], script, style, textarea, code, pre');
  }

  function translateTextNode(node) {
    if (!node || shouldSkip(node)) return;
    const existingSource = textSources.get(node);
    const raw = existingSource || node.nodeValue;
    const match = String(raw).match(/^(\s*)(.*?)(\s*)$/s);
    if (!match || !match[2]) return;
    const source = match[2];
    if (!existingSource && !/[\u4e00-\u9fff]/.test(source)) return;
    textSources.set(node, raw);
    const translated = translate(source);
    node.nodeValue = match[1] + translated + match[3];
  }

  function originalAttrName(attr) {
    return 'data-i18n-original-' + attr.replace(':', '-');
  }

  function translateElementAttrs(element) {
    ATTRS.forEach((attr) => {
      if (!element.hasAttribute(attr)) return;
      const dataAttr = originalAttrName(attr);
      const source = element.getAttribute(dataAttr) || element.getAttribute(attr);
      if (!source || (!element.hasAttribute(dataAttr) && !/[\u4e00-\u9fff]/.test(source))) return;
      element.setAttribute(dataAttr, source);
      const next = translate(source);
      if (element.getAttribute(attr) !== next) element.setAttribute(attr, next);
    });
  }

  function translateNode(root) {
    if (!root || translating) return;
    translating = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) {
        translateTextNode(root);
      } else if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        const element = root.nodeType === Node.ELEMENT_NODE ? root : null;
        if (element && !SKIP_TAGS.has(element.tagName)) translateElementAttrs(element);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
          acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE && shouldSkip(node)) return NodeFilter.FILTER_REJECT;
            if (node.nodeType === Node.TEXT_NODE && shouldSkip(node)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        let node = walker.nextNode();
        while (node) {
          if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
          else if (node.nodeType === Node.ELEMENT_NODE) translateElementAttrs(node);
          node = walker.nextNode();
        }
      }
    } finally {
      translating = false;
    }
  }

  function syncLanguageControls() {
    document.querySelectorAll('[data-i18n-language-select]').forEach((el) => {
      if (el.value !== currentLanguage) el.value = currentLanguage;
      syncCustomLanguageSelect(el);
    });
  }

  function syncCustomLanguageSelect(select) {
    const root = select.closest('[data-language-select]');
    if (!root) return;
    const value = normalizeLanguage(select.value || currentLanguage);
    const valueEl = root.querySelector('[data-language-select-value]');
    const trigger = root.querySelector('[data-language-select-trigger]');
    if (valueEl) valueEl.textContent = LANGUAGE_LABELS[value] || value;
    root.querySelectorAll('[data-language-option]').forEach((option) => {
      const isSelected = normalizeLanguage(option.dataset.languageOption) === value;
      option.setAttribute('aria-selected', String(isSelected));
    });
    if (trigger) trigger.setAttribute('aria-expanded', root.classList.contains('open') ? 'true' : 'false');
  }

  function closeCustomLanguageSelect(root) {
    if (!root) return;
    root.classList.remove('open');
    const trigger = root.querySelector('[data-language-select-trigger]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function closeAllCustomLanguageSelects(except) {
    document.querySelectorAll('[data-language-select].open').forEach((root) => {
      if (root !== except) closeCustomLanguageSelect(root);
    });
  }

  function bindCustomLanguageSelect(select) {
    const root = select.closest('[data-language-select]');
    if (!root || root.dataset.languageSelectBound === 'true') return;
    root.dataset.languageSelectBound = 'true';
    const trigger = root.querySelector('[data-language-select-trigger]');
    const menu = root.querySelector('[data-language-select-menu]');

    if (trigger) {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const willOpen = !root.classList.contains('open');
        closeAllCustomLanguageSelects(root);
        root.classList.toggle('open', willOpen);
        trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
      trigger.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          root.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
          const selected = menu && menu.querySelector('[aria-selected="true"]');
          (selected || (menu && menu.querySelector('[data-language-option]')))?.focus();
        }
      });
    }

    root.querySelectorAll('[data-language-option]').forEach((option) => {
      option.addEventListener('click', (event) => {
        event.preventDefault();
        const next = normalizeLanguage(option.dataset.languageOption);
        if (select.value !== next) {
          select.value = next;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          syncCustomLanguageSelect(select);
        }
        closeCustomLanguageSelect(root);
        trigger?.focus();
      });
      option.addEventListener('keydown', (event) => {
        const options = Array.from(root.querySelectorAll('[data-language-option]'));
        const index = options.indexOf(option);
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCustomLanguageSelect(root);
          trigger?.focus();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          options[(index + 1) % options.length]?.focus();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          options[(index - 1 + options.length) % options.length]?.focus();
        }
      });
    });

    syncCustomLanguageSelect(select);
  }

  function setLanguage(language, options) {
    const next = normalizeLanguage(language);
    currentLanguage = next;
    document.documentElement.lang = next;
    try { localStorage.setItem(LOCAL_STORAGE_KEY, next); } catch {}
    translateNode(document.body || document.documentElement);
    syncLanguageControls();
    window.dispatchEvent(new CustomEvent('byok-language-change', { detail: { language: next, previousLanguage: options && options.previousLanguage } }));
    return next;
  }

  function initFromConfig(config) {
    let language = config && config[CONFIG_KEY];
    if (!language) {
      try { language = localStorage.getItem(LOCAL_STORAGE_KEY); } catch {}
    }
    setLanguage(language || DEFAULT_LANGUAGE);
  }

  function bindLanguageControls() {
    document.querySelectorAll('[data-i18n-language-select]').forEach((el) => {
      bindCustomLanguageSelect(el);
      if (el.dataset.i18nBound === 'true') return;
      el.dataset.i18nBound = 'true';
      el.addEventListener('change', () => {
        setLanguage(el.value);
        syncCustomLanguageSelect(el);
      });
    });
  }

  function observeMutations() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (translating) return;
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => translateNode(node));
        } else if (mutation.type === 'attributes') {
          translateNode(mutation.target);
        }
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  window.ByokI18n = {
    CONFIG_KEY,
    DEFAULT_LANGUAGE,
    get language() { return currentLanguage; },
    normalizeLanguage,
    setLanguage,
    initFromConfig,
    translate,
    apply: () => translateNode(document.body || document.documentElement),
    bindLanguageControls
  };
  window.t = translate;

  document.addEventListener('DOMContentLoaded', () => {
    bindLanguageControls();
    initFromConfig(null);
    observeMutations();
    document.addEventListener('click', () => closeAllCustomLanguageSelects());
  });
})();
