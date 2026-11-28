// platforms/antigravity_enhance_render.js — GitHub 详情 URL 规范化、在线 HTML DOM 白名单安全清洗与降级 Markdown 渲染

const SAFE_HTML_TAGS = new Set([
  'article', 'section', 'div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'picture', 'video', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'pre', 'code', 'blockquote', 'hr', 'strong', 'b', 'em', 'i', 'del', 's', 'ins',
  'br', 'details', 'summary', 'kbd', 'sup', 'sub', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'mark'
]);

const DROP_HTML_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
  'select', 'button', 'svg', 'template', 'noscript', 'link', 'meta', 'base', 'audio'
]);

const ALLOWED_VIDEO_HOST_RE = /^https:\/\/(?:github\.com|(?:[a-z0-9-]+\.)?githubusercontent\.com)\//i;

function normalizeGithubRawAssetUrl(url) {
  const m = String(url || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/raw\/([^?#]+)([?#].*)?$/i);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}${m[3] || ''}`;
  return url;
}

function resolveEnhanceGithubUrl(rawUrl, repo, branch, isAsset = false) {
  const url = String(rawUrl || '').trim();
  if (!url || url.startsWith('#')) return '';
  if (/^https?:\/\//i.test(url)) return isAsset ? normalizeGithubRawAssetUrl(url) : url;
  if (url.startsWith('//')) {
    const abs = `https:${url}`;
    return isAsset ? normalizeGithubRawAssetUrl(abs) : abs;
  }
  if (/^(javascript|data|vbscript|file):/i.test(url)) return '';
  const cleanRepo = String(repo || '').trim();
  const cleanBranch = String(branch || 'main').trim() || 'main';
  if (!cleanRepo) return '';
  if (url.startsWith('/')) {
    const abs = `https://github.com${url}`;
    return isAsset ? normalizeGithubRawAssetUrl(abs) : abs;
  }
  const rel = url.replace(/^\.?\//, '');
  if (isAsset) return `https://raw.githubusercontent.com/${cleanRepo}/${cleanBranch}/${rel}`;
  return `https://github.com/${cleanRepo}/blob/${cleanBranch}/${rel}`;
}

function isBadgeImageUrl(url) {
  return /img\.shields\.io|shields\.io\/|badgen\.net|badge\.svg/i.test(String(url || ''));
}

function parseSafeDimension(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const pct = s.match(/^(\d{1,3}(?:\.\d+)?)%$/);
  if (pct) {
    const val = Number(pct[1]);
    return Number.isFinite(val) && val > 0 && val <= 100 ? { unit: '%', value: val } : null;
  }
  const px = s.match(/^(\d{1,4})(?:px)?$/i);
  if (px) {
    const val = Number(px[1]);
    return Number.isFinite(val) && val > 0 ? { unit: 'px', value: val } : null;
  }
  return null;
}

function buildSafeImageProps(widthAttr, heightAttr, primary, fallback = '') {
  const wDim = parseSafeDimension(widthAttr);
  const hDim = parseSafeDimension(heightAttr);
  const isBadge = isBadgeImageUrl(primary)
    || isBadgeImageUrl(fallback)
    || (hDim?.unit === 'px' && hDim.value <= 36);
  const classes = [isBadge ? 'enhance-md-badge' : 'enhance-md-shot'];
  let pixelWidth = null;
  let styleWidth = '';

  if (!isBadge && wDim) {
    if (wDim.unit === '%') {
      if (wDim.value >= 99.5) classes.push('is-full-width');
      else styleWidth = `${wDim.value}%`;
    } else if (wDim.unit === 'px' && wDim.value <= 960) {
      pixelWidth = String(wDim.value);
      if (wDim.value <= 128) classes.push('is-inline-logo');
    }
  }

  return {
    isBadge,
    className: classes.join(' '),
    pixelWidth,
    styleWidth
  };
}

function isMediaSelfLink(href) {
  return /camo\.githubusercontent\.com|raw\.githubusercontent\.com|user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/(?:blob|raw)\/[^?#]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:[?#].*)?$/i.test(String(href || ''));
}

function isDarkUiTheme() {
  if (typeof document === 'undefined') return false;
  const htmlTheme = document.documentElement?.getAttribute?.('data-theme');
  if (htmlTheme === 'dark') return true;
  if (htmlTheme === 'light') return false;
  return Boolean(document.body?.classList?.contains?.('dark-theme'));
}

function normalizeAnchorSlug(raw) {
  let s = String(raw || '').trim().replace(/^#/, '').replace(/^user-content-/i, '');
  try { s = decodeURIComponent(s); } catch (_) {}
  return s.trim().toLowerCase();
}

function parseRawHtmlDocument(rawHtml) {
  const ParserCtor = typeof DOMParser !== 'undefined'
    ? DOMParser
    : (typeof window !== 'undefined' ? window.DOMParser : null);
  if (ParserCtor) {
    try {
      return new ParserCtor().parseFromString(String(rawHtml || ''), 'text/html');
    } catch (_) {}
  }
  if (typeof document !== 'undefined') {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = String(rawHtml || '');
    return doc;
  }
  return null;
}

function extractAlignClass(el) {
  const align = (el.getAttribute?.('align') || '').trim().toLowerCase();
  if (align === 'center' || align === 'left' || align === 'right') return `is-align-${align}`;
  return '';
}

function createCleanImageNode(doc, srcRaw, canonicalRaw, altRaw, widthAttr, heightAttr, repo, branch) {
  const rawSrc = resolveEnhanceGithubUrl(srcRaw, repo, branch, true);
  const canonical = canonicalRaw ? resolveEnhanceGithubUrl(canonicalRaw, repo, branch, true) : '';
  let primary = rawSrc || canonical;
  let fallback = canonical && canonical !== rawSrc ? canonical : '';
  if (canonical && isBadgeImageUrl(canonical) && /camo\.githubusercontent\.com/i.test(rawSrc)) {
    primary = canonical;
    fallback = rawSrc;
  }
  if (!primary) return null;

  const img = doc.createElement('img');
  const props = buildSafeImageProps(widthAttr, heightAttr, primary, fallback);
  img.className = props.className;
  img.setAttribute('src', primary);
  if (fallback) img.setAttribute('data-fallback-src', fallback);
  img.setAttribute('alt', String(altRaw || ''));
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.setAttribute('referrerpolicy', 'no-referrer');
  if (!props.isBadge) {
    img.setAttribute('data-enhance-zoom', '1');
    img.setAttribute('title', et('agEnhance.detailZoomHint'));
  }
  if (props.pixelWidth) {
    img.setAttribute('width', props.pixelWidth);
  } else if (props.styleWidth) {
    img.style.width = props.styleWidth;
  }
  return img;
}

function pickPictureSrc(pictureEl, repo, branch) {
  const dark = isDarkUiTheme();
  const sources = Array.from(pictureEl.children || []).filter((c) => c.tagName === 'SOURCE');
  for (const srcEl of sources) {
    const media = (srcEl.getAttribute('media') || '').toLowerCase();
    const srcset = (srcEl.getAttribute('srcset') || '').trim().split(/[\s,]+/)[0] || '';
    if (!srcset) continue;
    if (dark && media.includes('prefers-color-scheme: dark')) return resolveEnhanceGithubUrl(srcset, repo, branch, true);
    if (!dark && media.includes('prefers-color-scheme: light')) return resolveEnhanceGithubUrl(srcset, repo, branch, true);
  }
  return '';
}

function sanitizeNodeInto(srcNode, outDoc, repo, branch) {
  if (!srcNode) return null;
  if (srcNode.nodeType === 3) {
    const text = srcNode.nodeValue || '';
    const trimmed = text.trim();
    if (/^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/i.test(trimmed)) {
      const a = outDoc.createElement('a');
      a.className = 'enhance-md-attachment-link';
      a.setAttribute('href', '#');
      a.setAttribute('data-action', 'openAntigravityEnhanceRepo');
      a.setAttribute('data-arg', trimmed);
      a.textContent = et('agEnhance.detailAttachmentCard');
      return a;
    }
    return outDoc.createTextNode(text);
  }
  if (srcNode.nodeType !== 1) return null;

  const tag = srcNode.tagName.toLowerCase();
  if (DROP_HTML_TAGS.has(tag)) return null;

  const classList = String(srcNode.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  if (tag === 'a' && (classList.includes('anchor') || srcNode.getAttribute('aria-label')?.startsWith('Permalink:'))) {
    return null;
  }

  if (tag === 'div' && classList.includes('markdown-heading')) {
    const heading = srcNode.querySelector('h1, h2, h3, h4, h5, h6');
    if (!heading) return null;
    const cleanHeading = sanitizeNodeInto(heading, outDoc, repo, branch);
    if (!cleanHeading) return null;
    const anchor = srcNode.querySelector('a.anchor');
    const slug = normalizeAnchorSlug(anchor?.getAttribute('id') || anchor?.getAttribute('href') || heading.textContent || '');
    if (slug) cleanHeading.setAttribute('data-anchor-id', slug);
    const alignCls = extractAlignClass(srcNode);
    if (alignCls) cleanHeading.classList.add(alignCls);
    return cleanHeading;
  }

  if (tag === 'picture') {
    const innerImg = srcNode.querySelector('img');
    if (!innerImg) return null;
    const themedSrc = pickPictureSrc(srcNode, repo, branch);
    return createCleanImageNode(
      outDoc,
      themedSrc || innerImg.getAttribute('src'),
      themedSrc ? '' : innerImg.getAttribute('data-canonical-src'),
      innerImg.getAttribute('alt'),
      innerImg.getAttribute('width'),
      innerImg.getAttribute('height'),
      repo,
      branch
    );
  }

  if (tag === 'img') {
    return createCleanImageNode(
      outDoc,
      srcNode.getAttribute('src'),
      srcNode.getAttribute('data-canonical-src'),
      srcNode.getAttribute('alt'),
      srcNode.getAttribute('width'),
      srcNode.getAttribute('height'),
      repo,
      branch
    );
  }

  if (tag === 'video') {
    const vSrc = String(srcNode.getAttribute('src') || srcNode.querySelector('source')?.getAttribute('src') || '').trim();
    if (!ALLOWED_VIDEO_HOST_RE.test(vSrc)) return null;
    const video = outDoc.createElement('video');
    video.className = 'enhance-md-video';
    video.setAttribute('src', vSrc);
    video.setAttribute('controls', '');
    video.setAttribute('preload', 'metadata');
    video.setAttribute('playsinline', '');
    return video;
  }

  if (!SAFE_HTML_TAGS.has(tag)) {
    const frag = outDoc.createDocumentFragment();
    for (const child of Array.from(srcNode.childNodes)) {
      const cleaned = sanitizeNodeInto(child, outDoc, repo, branch);
      if (cleaned) frag.appendChild(cleaned);
    }
    return frag.childNodes.length ? frag : null;
  }

  if (tag === 'a') {
    const rawHref = String(srcNode.getAttribute('href') || '').trim();
    const frag = outDoc.createDocumentFragment();
    for (const child of Array.from(srcNode.childNodes)) {
      const cleaned = sanitizeNodeInto(child, outDoc, repo, branch);
      if (cleaned) frag.appendChild(cleaned);
    }
    if (!frag.childNodes.length) return null;

    if (rawHref.startsWith('#')) {
      const slug = normalizeAnchorSlug(rawHref);
      const a = outDoc.createElement('a');
      a.className = 'enhance-md-link enhance-md-anchor';
      a.setAttribute('href', '#');
      if (slug) a.setAttribute('data-enhance-anchor', slug);
      a.appendChild(frag);
      return a;
    }

    const resolved = resolveEnhanceGithubUrl(rawHref, repo, branch, false);
    if (!resolved) return frag;
    const elems = Array.from(frag.childNodes).filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim()));
    if (elems.length === 1 && elems[0].nodeType === 1 && elems[0].tagName === 'IMG' && isMediaSelfLink(resolved)) {
      return elems[0];
    }

    const a = outDoc.createElement('a');
    a.className = 'enhance-md-link';
    a.setAttribute('href', '#');
    a.setAttribute('data-action', 'openAntigravityEnhanceRepo');
    a.setAttribute('data-arg', resolved);
    a.appendChild(frag);
    return a;
  }

  if (tag === 'table') {
    const wrap = outDoc.createElement('div');
    wrap.className = 'enhance-md-table-wrap';
    const table = outDoc.createElement('table');
    table.className = 'enhance-md-table';
    for (const child of Array.from(srcNode.childNodes)) {
      const cleaned = sanitizeNodeInto(child, outDoc, repo, branch);
      if (cleaned) table.appendChild(cleaned);
    }
    const firstRow = table.querySelector('tr');
    const firstCells = firstRow ? Array.from(firstRow.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH') : [];
    if (firstCells.length >= 2 && firstCells.every((c) => /%$/.test(c.style.width || ''))) {
      table.classList.add('is-fixed-layout');
    }
    wrap.appendChild(table);
    return wrap;
  }

  const outTag = tag === 'article' ? 'div' : tag;
  const el = outDoc.createElement(outTag);
  const alignCls = extractAlignClass(srcNode);
  if (alignCls) el.classList.add(alignCls);

  if (/^h[1-6]$/.test(outTag)) {
    el.classList.add(`enhance-md-h${Math.min(4, Number(outTag[1]) || 4)}`);
    const slug = normalizeAnchorSlug(srcNode.getAttribute('id') || srcNode.textContent || '');
    if (slug) el.setAttribute('data-anchor-id', slug);
  } else if (outTag === 'p') {
    el.classList.add('enhance-md-p');
  } else if (outTag === 'pre') {
    el.classList.add('enhance-md-pre');
  } else if (outTag === 'blockquote') {
    el.classList.add('enhance-md-quote');
  } else if (outTag === 'ul' || outTag === 'ol') {
    el.classList.add('enhance-md-list');
  } else if (outTag === 'hr') {
    el.classList.add('enhance-md-hr');
  } else if (outTag === 'details') {
    el.classList.add('enhance-md-details');
    if (srcNode.hasAttribute('open')) el.setAttribute('open', '');
  } else if (outTag === 'div' && classList.includes('markdown-alert')) {
    el.classList.add('enhance-md-alert');
    const kind = classList.find((c) => /^markdown-alert-(note|tip|important|warning|caution)$/i.test(c));
    if (kind) el.classList.add(`is-${kind.replace(/^markdown-alert-/i, '').toLowerCase()}`);
  } else if (outTag === 'p' && classList.includes('markdown-alert-title')) {
    el.classList.add('enhance-md-alert-title');
  } else if (outTag === 'td' || outTag === 'th') {
    if (srcNode.getAttribute('colspan')) {
      const span = parseInt(srcNode.getAttribute('colspan'), 10);
      if (Number.isFinite(span) && span > 1 && span <= 20) el.setAttribute('colspan', String(span));
    }
    const cellWidth = parseSafeDimension(srcNode.getAttribute('width'));
    if (cellWidth?.unit === '%') {
      el.style.width = `${cellWidth.value}%`;
    } else if (cellWidth?.unit === 'px' && cellWidth.value <= 800) {
      el.style.width = `${cellWidth.value}px`;
    }
  }

  for (const child of Array.from(srcNode.childNodes)) {
    const cleaned = sanitizeNodeInto(child, outDoc, repo, branch);
    if (cleaned) el.appendChild(cleaned);
  }

  if (outTag === 'p') {
    if (el.querySelectorAll('img.enhance-md-badge').length > 0 && !el.textContent.trim()) {
      el.classList.add('is-badges');
    }
    if (!el.childNodes.length || (!el.querySelector('img, video, br, a') && !el.textContent.trim())) {
      return null;
    }
  }
  return el;
}

function sanitizeEnhanceGithubHtml(rawHtml, repo, branch) {
  if (!String(rawHtml || '').trim()) return '';
  const parsed = parseRawHtmlDocument(rawHtml);
  if (!parsed) return '';
  const root = parsed.querySelector('article.markdown-body') || parsed.body;
  const outDoc = typeof document !== 'undefined' ? document : parsed;
  const host = outDoc.createElement('div');
  for (const child of Array.from(root.childNodes)) {
    const cleaned = sanitizeNodeInto(child, outDoc, repo, branch);
    if (cleaned) host.appendChild(cleaned);
  }
  return host.innerHTML;
}

function renderMdImageTag(src, alt, repo, branch, widthAttr = '', heightAttr = '') {
  const resolved = resolveEnhanceGithubUrl(src, repo, branch, true);
  if (!resolved) return '';
  const props = buildSafeImageProps(widthAttr, heightAttr, resolved);
  const attrs = [
    `class="${props.className}"`,
    `src="${enhanceEscape(resolved)}"`,
    `alt="${enhanceEscape(alt || '')}"`,
    'loading="lazy"',
    'decoding="async"',
    'referrerpolicy="no-referrer"'
  ];
  if (!props.isBadge) {
    attrs.push('data-enhance-zoom="1"', `title="${enhanceEscape(et('agEnhance.detailZoomHint'))}"`);
  }
  if (props.pixelWidth) attrs.push(`width="${props.pixelWidth}"`);
  if (props.styleWidth) attrs.push(`style="width:${props.styleWidth}"`);
  return `<img ${attrs.join(' ')}>`;
}

function renderMdInline(text, repo, branch) {
  const tokens = [];
  const hold = (html) => {
    const key = `ENHANCETOKEN${tokens.length}ENDTOKEN`;
    tokens.push(html);
    return key;
  };
  const restore = (s) => s.replace(/ENHANCETOKEN(\d+)ENDTOKEN/g, (_, idx) => tokens[Number(idx)] || '');

  let src = String(text || '');
  src = src.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${enhanceEscape(code)}</code>`));
  src = src.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => hold(`<code>${enhanceEscape(code)}</code>`));
  src = src.replace(/<br\s*\/?>/gi, () => hold('<br>'));
  src = src.replace(/\[!\[([^\]]*)\]\(((?:[^\s()]+|\([^\s()]*\))+)(?:\s+"[^"]*")?\)\]\(((?:[^\s()]+|\([^\s()]*\))+)\)/g, (_, alt, imgUrl, href) => {
    const imgHtml = renderMdImageTag(imgUrl, alt, repo, branch);
    const link = resolveEnhanceGithubUrl(href, repo, branch, false);
    if (!imgHtml) return '';
    return link && !isMediaSelfLink(link)
      ? hold(`<a class="enhance-md-link" href="#" data-action="openAntigravityEnhanceRepo" data-arg="${enhanceEscape(link)}">${imgHtml}</a>`)
      : hold(imgHtml);
  });
  src = src.replace(/!\[([^\]]*)\]\(((?:[^\s()]+|\([^\s()]*\))+)(?:\s+"[^"]*")?\)/g, (_, alt, imgUrl) => {
    const imgHtml = renderMdImageTag(imgUrl, alt, repo, branch);
    return imgHtml ? hold(imgHtml) : '';
  });
  src = src.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const imgSrc = srcMatch ? (srcMatch[1] || srcMatch[2]) : '';
    if (!imgSrc) return '';
    const altMatch = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const widthMatch = tag.match(/\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const heightMatch = tag.match(/\bheight\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const imgAlt = altMatch ? (altMatch[1] ?? altMatch[2] ?? '') : '';
    const imgW = widthMatch ? (widthMatch[1] ?? widthMatch[2] ?? '') : '';
    const imgH = heightMatch ? (heightMatch[1] ?? heightMatch[2] ?? '') : '';
    const imgHtml = renderMdImageTag(imgSrc, imgAlt, repo, branch, imgW, imgH);
    return imgHtml ? hold(imgHtml) : '';
  });
  src = src.replace(/<a\b(?:[^>"']|"[^"]*"|'[^']*')*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/a>/gi, (_, h1, h2, inner) => {
    const rawHref = (h1 || h2 || '').trim();
    const cleanInner = restore(inner.replace(/<[^>]+>/g, '').trim());
    if (!cleanInner) return '';
    if (rawHref.startsWith('#')) {
      return hold(`<a class="enhance-md-link enhance-md-anchor" href="#" data-enhance-anchor="${enhanceEscape(normalizeAnchorSlug(rawHref))}">${cleanInner}</a>`);
    }
    const link = resolveEnhanceGithubUrl(rawHref, repo, branch, false);
    if (!link) return hold(cleanInner);
    if (isMediaSelfLink(link) && /^<img\b/i.test(cleanInner)) return hold(cleanInner);
    return hold(`<a class="enhance-md-link" href="#" data-action="openAntigravityEnhanceRepo" data-arg="${enhanceEscape(link)}">${cleanInner}</a>`);
  });
  src = src.replace(/\[([^\]]+)\]\(((?:[^\s()]+|\([^\s()]*\))+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const safeLabel = enhanceEscape(label);
    if (String(href).startsWith('#')) {
      return hold(`<a class="enhance-md-link enhance-md-anchor" href="#" data-enhance-anchor="${enhanceEscape(normalizeAnchorSlug(href))}">${safeLabel}</a>`);
    }
    const link = resolveEnhanceGithubUrl(href, repo, branch, false);
    if (!link) return safeLabel;
    return hold(`<a class="enhance-md-link" href="#" data-action="openAntigravityEnhanceRepo" data-arg="${enhanceEscape(link)}">${safeLabel}</a>`);
  });
  src = src.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, inner) => hold(`<strong>${restore(enhanceEscape(inner.replace(/<[^>]+>/g, '')))}</strong>`));
  src = src.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, inner) => hold(`<em>${restore(enhanceEscape(inner.replace(/<[^>]+>/g, '')))}</em>`));
  src = src.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_, inner) => hold(`<sub>${restore(enhanceEscape(inner.replace(/<[^>]+>/g, '')))}</sub>`));
  src = src.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (_, inner) => hold(`<sup>${restore(enhanceEscape(inner.replace(/<[^>]+>/g, '')))}</sup>`));
  src = src.replace(/<\/?(?:div|p|span|table|thead|tbody|tr|th|td|picture|source|center|h[1-6])\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, ' ');

  let out = enhanceEscape(src);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return restore(out);
}

function renderMdTable(lines, repo, branch) {
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const headers = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  const thead = `<thead><tr>${headers.map((h) => `<th>${renderMdInline(h, repo, branch)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderMdInline(c, repo, branch)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="enhance-md-table-wrap"><table class="enhance-md-table">${thead}${tbody}</table></div>`;
}

function extractTopLevelHtmlTables(markdownText) {
  const tables = [];
  const lines = String(markdownText || '').split('\n');
  const out = [];
  let inFence = false;
  let tableLines = null;
  let tableDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!tableLines && trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence) {
      const opens = (line.match(/<table\b[^>]*>/gi) || []).length;
      const closes = (line.match(/<\/table>/gi) || []).length;
      if (!tableLines && opens > 0 && /^<table\b/i.test(trimmed)) {
        tableLines = [line];
        tableDepth = opens - closes;
        if (tableDepth <= 0) {
          const idx = tables.length;
          tables.push(tableLines.join('\n'));
          out.push(`ENHANCEHTMLTABLE_${idx}_END`);
          tableLines = null;
          tableDepth = 0;
        }
        continue;
      }
      if (tableLines) {
        tableLines.push(line);
        tableDepth += opens - closes;
        if (tableDepth <= 0) {
          const idx = tables.length;
          tables.push(tableLines.join('\n'));
          out.push(`ENHANCEHTMLTABLE_${idx}_END`);
          tableLines = null;
          tableDepth = 0;
        }
        continue;
      }
    }
    out.push(line);
  }
  if (tableLines) out.push(...tableLines);
  return { text: out.join('\n'), tables };
}

function renderEnhanceGithubMarkdown(markdown, repo, branch) {
  const raw = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return '';
  const { text: withoutTables, tables: rawTables } = extractTopLevelHtmlTables(raw.replace(/<!--[\s\S]*?-->/g, ''));
  const cleaned = withoutTables
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n${'#'.repeat(Math.min(4, Number(lvl)))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<details\b[^>]*>/gi, '\n')
    .replace(/<\/details>/gi, '\n')
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_, s) => `\n#### ${s.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<\/?(?:div|center|p)\b[^>]*>/gi, '\n');

  const lines = cleaned.split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i += 1; continue; }

    const tblMatch = trimmed.match(/^ENHANCEHTMLTABLE_(\d+)_END$/);
    if (tblMatch) {
      const tableHtml = sanitizeEnhanceGithubHtml(rawTables[Number(tblMatch[1])] || '', repo, branch);
      if (tableHtml) html.push(tableHtml);
      i += 1;
      continue;
    }

    if (/^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/i.test(trimmed)) {
      html.push(`<p class="enhance-md-p"><a class="enhance-md-attachment-link" href="#" data-action="openAntigravityEnhanceRepo" data-arg="${enhanceEscape(trimmed)}">${antigravityEnhanceIcon('external', 13)}<span>${enhanceEscape(et('agEnhance.detailAttachmentCard'))}</span></a></p>`);
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      html.push(`<pre class="enhance-md-pre"><code>${enhanceEscape(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      html.push('<hr class="enhance-md-hr">');
      i += 1;
      continue;
    }

    const headMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headMatch) {
      const lvl = Math.min(4, headMatch[1].length);
      const slug = normalizeAnchorSlug(headMatch[2].replace(/<[^>]+>/g, ''));
      html.push(`<h${lvl} class="enhance-md-h${lvl}" data-anchor-id="${enhanceEscape(slug)}">${renderMdInline(headMatch[2], repo, branch)}</h${lvl}>`);
      i += 1;
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const tblLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && !lines[i].trim().startsWith('```')) {
        tblLines.push(lines[i]);
        i += 1;
      }
      html.push(renderMdTable(tblLines, repo, branch));
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        const q = lines[i].trim().replace(/^>\s?/, '').replace(/^\[![A-Z]+\]\s*/i, '');
        if (q) quoteLines.push(renderMdInline(q, repo, branch));
        i += 1;
      }
      if (quoteLines.length) html.push(`<blockquote class="enhance-md-quote">${quoteLines.join('<br>')}</blockquote>`);
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const tag = olMatch ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        const m = olMatch ? cur.match(/^\d+\.\s+(.+)$/) : cur.match(/^[-*+]\s+(.+)$/);
        if (!m) break;
        items.push(`<li>${renderMdInline(m[1], repo, branch)}</li>`);
        i += 1;
      }
      html.push(`<${tag} class="enhance-md-list">${items.join('')}</${tag}>`);
      continue;
    }

    const paraLines = [];
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (!cur || cur.startsWith('```') || /^#{1,4}\s+/.test(cur) || /^(?:---+|\*\*\*+)$/.test(cur)
        || cur.startsWith('>') || /^[-*+]\s+/.test(cur) || /^\d+\.\s+/.test(cur)
        || /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/i.test(cur)) {
        break;
      }
      if (cur.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) break;
      paraLines.push(cur);
      i += 1;
    }
    const rendered = renderMdInline(paraLines.join(' '), repo, branch).trim();
    if (rendered) {
      const isBadgeLine = /enhance-md-badge/.test(rendered) && !rendered.replace(/<[^>]+>/g, '').trim();
      html.push(`<p class="enhance-md-p${isBadgeLine ? ' is-badges' : ''}">${rendered}</p>`);
    }
  }

  return html.join('');
}

Object.assign(globalThis, {
  normalizeAnchorSlug,
  resolveEnhanceGithubUrl,
  sanitizeEnhanceGithubHtml,
  renderEnhanceGithubMarkdown
});
