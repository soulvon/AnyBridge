/* byok-cards.js — IDE 模型选择面板卡片的纯视觉改写。
 *
 * 由 AnyBridge 注入到 workbench.html（独立于汉化插件 ws-better）。
 * 目标：把冒名的 Claude Opus 4.6/4.7/4.8（实际复用 GPT-5.1 槽位）的列表项和
 * 详情卡，伪装成官方 Opus 卡片信息，并隐藏推理档位区。全部是显示层覆盖，
 * 不触碰 modelUid / 路由 / 真实档位逻辑。
 *
 * 真实 DOM 结构（实测 dump）：
 *   列表项：button[data-kb-navigate] 内 span.truncate，含主名 + <span.opacity-60> 后缀</span>
 *   详情卡：div.w-48，hover/展开时显示，结构：
 *     - 标题块  div.flex.items-start > span.text-sm.font-medium（含主名 + opacity-60 后缀）
 *     - 上下文  紧邻 span.text-xs > span.opacity-60（如 "384K 上下文"）
 *     - 档位区  div.m-1 内含 [data-ws-orig="Reasoning Effort"] 与 Fast Mode
 *     - 成本    滑块标签 span（文本=模型名，如 "GPT-5.1"）+ 价格 grid（$x / 1M tokens）
 *               官方 4.8 槽位是三格[输入/缓存输入/输出]；4.6/4.7 槽位只有两格
 *               [输入/输出]，运行时克隆「输入」格补出「缓存输入」格统一成三格。
 *   列表项与其详情卡同处一个 [aria-expanded] 容器内，故详情卡可借此反查归属。
 *
 * 实现约束：只改 textContent / 隐藏元素，不用 innerHTML（避开 Trusted-Types）。
 */
(function () {
  'use strict';

  var TAG = '[byok-cards]';
  var DONE = '__byokDone';

  // 各冒名模型的目标卡片信息。键为主名（去后缀）。
  var SPEC = {
    'Claude Opus 4.6': { ctx: '200K 上下文', ctxEn: '200K context', input: '$5', cached: '$0.5', output: '$25' },
    'Claude Opus 4.7': { ctx: '1M 上下文', ctxEn: '1M context', input: '$5', cached: '$0.5', output: '$25' },
    'Claude Opus 4.8': { ctx: '1M 上下文', ctxEn: '1M context', input: '$5', cached: '$0.5', output: '$25' },
  };
  var NAMES = Object.keys(SPEC);

  function matchName(text) {
    if (!text) return null;
    for (var i = 0; i < NAMES.length; i++) {
      if (text.indexOf(NAMES[i]) !== -1) return NAMES[i];
    }
    return null;
  }

  // ── 列表项：去标题后缀 ──────────────────────────────────────
  // span.truncate 内含主名 + <span class="opacity-60"> 后缀</span>，删掉后缀 span。
  function fixListItems(root) {
    var spans = root.querySelectorAll('span.truncate');
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (sp[DONE]) continue;
      var name = matchName(sp.textContent);
      if (!name) continue;
      // 移除主名之后的 opacity-60 后缀 span（如 " Medium"）
      var subs = sp.querySelectorAll('span.opacity-60');
      for (var j = 0; j < subs.length; j++) {
        var t = subs[j].textContent || '';
        if (/Thinking|Medium|Max|High|XHigh|Low|Fast/i.test(t)) subs[j].textContent = '';
      }
      sp[DONE] = 1;
    }
  }

  // ── 详情卡：判定归属 + 改信息 + 隐档位 ──────────────────────
  // 归属关系（实测）：列表项 wrapper `div[aria-controls]` 的标题命中 Claude Opus 4.x，
  // 其紧邻的 nextElementSibling（aria-hidden 容器）里的所有 div.w-48 即该模型的详情卡组。
  function fixDetailCards(root) {
    var cards = root.querySelectorAll('div.w-48');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card[DONE]) continue;
      // 只处理「当前可见」的卡（隐藏在 -9999px 容器里的不动，等它显示时再改）
      if (!isVisible(card)) continue;
      var owner = resolveOwner(card);
      if (owner) applyCard(card, owner);
    }
  }

  // 判定卡的归属 Claude Opus 主名。两条路任一命中即可：
  //  路1：卡处在某个「展开的 Claude Opus 列表项」的兄弟容器内
  //       → 从卡向上找 aria-hidden 容器(holder)，再取 holder 的前一个兄弟（列表项）标题。
  //  路2：卡内标题/滑块本身已是 "Claude Opus 4.x"（适配官方已命名的卡）。
  function resolveOwner(card) {
    // 路1
    var holder = card.parentElement;
    while (holder && holder !== document.body) {
      if (holder.getAttribute && holder.getAttribute('aria-hidden') === 'true') break;
      holder = holder.parentElement;
    }
    if (holder) {
      var prev = holder.previousElementSibling;
      // 列表项可能套了几层，向内找 span.truncate
      while (prev) {
        var tr = prev.querySelector ? prev.querySelector('span.truncate') : null;
        var nm = tr ? matchName(tr.textContent) : null;
        if (nm) return nm;
        // 也可能 prev 自身不含，往前再退一个
        prev = prev.previousElementSibling;
        if (prev && prev.querySelector && prev.querySelector('div.w-48')) break; // 撞到另一组卡，停
      }
    }
    // 路2：卡内标题
    var t = card.querySelector('span.text-sm.font-medium');
    var n2 = t ? matchName(t.textContent) : null;
    if (n2) return n2;
    return null;
  }

  function isVisible(el) {
    if (!el.getBoundingClientRect) return true; // 非浏览器环境(测试)放行
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top > -9000;
  }

  function applyCard(card, owner) {
    if (card[DONE]) return;
    var spec = SPEC[owner];
    if (!spec) return;

    // 1) 卡内标题 span.text-sm.font-medium：改主名 + 去后缀
    var titleSpan = card.querySelector('span.text-sm.font-medium');
    if (titleSpan) {
      var suf = titleSpan.querySelector('span.opacity-60');
      if (suf) suf.textContent = '';
      setLeadingText(titleSpan, owner);
    }

    // 2) 上下文：标题块后的 span.text-xs > span.opacity-60
    var ctxWrap = card.querySelector('span.text-xs');
    if (ctxWrap) {
      var ctxSpan = ctxWrap.querySelector('span.opacity-60') || ctxWrap;
      var cur = ctxSpan.textContent || '';
      ctxSpan.textContent = /context/i.test(cur) && !/上下文/.test(cur) ? spec.ctxEn : spec.ctx;
    }

    // 3) 隐藏档位区 + Fast Mode
    hideEffort(card);

    // 4) 成本滑块标签：成本区那个绝对定位的模型名 span（class 含 leading-[14px]
    //    且无子元素），无条件改成主名。
    var allSpans = card.querySelectorAll('span');
    for (var s = 0; s < allSpans.length; s++) {
      var sp2 = allSpans[s];
      if (sp2.children.length !== 0) continue;
      var cls = sp2.className || '';
      var txt = (sp2.textContent || '').trim();
      // 滑块标签：绝对定位、leading-[14px]、内容是模型名（非价格、非"输入"等标签）
      if (cls.indexOf('leading-[14px]') !== -1 && cls.indexOf('absolute') !== -1 && txt && !/^\$|tokens|输入|输出|缓存/.test(txt)) {
        sp2.textContent = owner;
      }
    }

    // 5) 价格 grid：官方 4.8 是三格[输入/缓存输入/输出]，4.6/4.7 只有两格
    //    [输入/输出]。统一补成三格：在「输入」后插入克隆的「缓存输入」格。
    var grids = card.querySelectorAll('div.grid');
    for (var g = 0; g < grids.length; g++) {
      var grid = grids[g];
      var cells = grid.children;
      if (cells.length === 2) {
        ensureCachedCell(grid);
        cells = grid.children;
      }
      if (cells.length === 3) {
        setPrice(cells[0], spec.input);
        setPrice(cells[1], spec.cached);
        setPrice(cells[2], spec.output);
      }
    }

    card[DONE] = 1;
  }

  // 把元素的「第一个文本节点」改成给定文本（保留子 span 等结构）。
  function setLeadingText(el, text) {
    for (var k = 0; k < el.childNodes.length; k++) {
      var nd = el.childNodes[k];
      if (nd.nodeType === 3) { // text node
        if ((nd.nodeValue || '').trim()) { nd.nodeValue = text; return; }
      }
    }
    // 没有现成文本节点则插入一个
    el.insertBefore(document.createTextNode(text), el.firstChild);
  }

  // 两格价格 grid（输入/输出）补成三格：克隆「输入」格当作「缓存输入」格，
  // 插到输入格之后，改其标签文本，并把 grid 列数从 2 改成 3。
  function ensureCachedCell(grid) {
    var cells = grid.children;
    if (cells.length !== 2) return;
    var inputCell = cells[0];
    var clone = inputCell.cloneNode(true);
    // 改克隆格的标签文本（含 "输入"/"Input" 的那个 span，不是价格 span）
    var labelSpans = clone.querySelectorAll('span');
    for (var i = 0; i < labelSpans.length; i++) {
      var sp = labelSpans[i];
      if (sp.children.length !== 0) continue;
      var t = (sp.textContent || '').trim();
      if (t === '输入') { sp.textContent = '缓存输入'; break; }
      if (/^input$/i.test(t)) { sp.textContent = 'Cached Input'; break; }
    }
    inputCell.parentNode.insertBefore(clone, inputCell.nextSibling);
    // grid 列数：grid-cols-2 → grid-cols-3
    var cls = grid.getAttribute('class') || '';
    if (cls.indexOf('grid-cols-2') !== -1) {
      grid.setAttribute('class', cls.replace('grid-cols-2', 'grid-cols-3'));
    }
  }

  // 价格格：结构是 <div><span 标签></span><span 价格 "$x " <span 单位/1M></span></span></div>
  // 价格 span 里可能有多个文本节点（如被改名拆成 "$" + "1.25"）。
  // 清掉 span 内所有文本节点（保留子 span 单位），再在最前插入新价格文本。
  function setPrice(cell, price) {
    var priceSpan = cell.querySelector('span.text-xs.font-medium');
    if (!priceSpan) {
      var spans = cell.querySelectorAll('span');
      priceSpan = spans[spans.length - 1];
    }
    if (!priceSpan) return;
    // 移除所有直接文本节点
    var kids = [];
    for (var k = 0; k < priceSpan.childNodes.length; k++) kids.push(priceSpan.childNodes[k]);
    for (var j = 0; j < kids.length; j++) {
      if (kids[j].nodeType === 3) priceSpan.removeChild(kids[j]);
    }
    // 在最前插入新价格（带尾空格，和单位 span 隔开）
    priceSpan.insertBefore(document.createTextNode(price + ' '), priceSpan.firstChild);
  }

  // 隐藏档位区：找含 推理强度/Reasoning Effort 文本的块，藏其所在的 div.flex.flex-col；
  // 同时藏 Fast Mode 行。两者都在 div.m-1 容器内。
  function hideEffort(card) {
    var spans = card.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var txt = (spans[i].textContent || '').trim();
      if (txt === '推理强度' || txt === 'Reasoning Effort') {
        var block = spans[i].closest ? spans[i].closest('div.flex.flex-col.gap-1') : spans[i].parentElement;
        if (block) block.style.display = 'none';
      }
      if (txt === 'Fast Mode') {
        var row = spans[i].parentElement; // 含 Fast Mode 标签与开关
        if (row) row.style.display = 'none';
      }
    }
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    try { fixListItems(root); } catch (e) {}
    try { fixDetailCards(root); } catch (e) {}
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () { scheduled = false; scan(document.body); }, 50);
  }

  function start() {
    try {
      scan(document.body);
      new MutationObserver(schedule).observe(document.body, {
        childList: true, subtree: true, characterData: true,
      });
      console.log(TAG, 'observer started');
    } catch (e) {
      console.log(TAG, 'start failed', e);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { setTimeout(start, 800); });
  } else {
    setTimeout(start, 800);
  }
})();
