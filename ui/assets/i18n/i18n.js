(function () {
  const DEFAULT_LANGUAGE = 'zh-CN';
  const CONFIG_KEY = 'APP_LANGUAGE';
  const LOCAL_STORAGE_KEY = 'byok-language';
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
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
    const catalog = catalogOf(language || currentLanguage);
    const value = (catalog.translations && Object.prototype.hasOwnProperty.call(catalog.translations, key))
      ? catalog.translations[key]
      : key;
    return interpolate(value, params);
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
    });
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
      if (el.dataset.i18nBound === 'true') return;
      el.dataset.i18nBound = 'true';
      el.addEventListener('change', () => setLanguage(el.value));
    });
  }

  function observeMutations() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (translating) return;
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => translateNode(node));
        if (mutation.type === 'attributes') translateNode(mutation.target);
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
  });
})();
