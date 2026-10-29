/**
 * 供应商预设目录
 * 数据源：../provider-presets.json（只维护稳定信息，模型走「获取模型列表」实时拉取）
 * 职责：把「名称 + API 地址 + 协议」一键填进供应商编辑页，并给出申请密钥入口。
 */
import { escapeHtml, escAttr } from './ui/dom.js';

globalThis.PROVIDER_PRESET_CATALOG = { groups: [], providers: [] };
globalThis.PROVIDER_PRESET_KEYWORD = '';
globalThis.PROVIDER_PRESET_ACTIVE_ID = '';
/** 当前分组筛选，空串 = 全部。62 家时靠滚动找太慢，分组页签比滚动快得多。 */
globalThis.PROVIDER_PRESET_GROUP = '';

/** 加载失败的原因要留下来给用户看，不能只打 console —— 否则列表只是"空的"，用户不知道是没数据还是取不到。 */
globalThis.PROVIDER_PRESET_LOAD_ERROR = '';

function applyPresetCatalog(data) {
  globalThis.PROVIDER_PRESET_CATALOG = {
    groups: Array.isArray(data.groups) ? data.groups : [],
    providers: Array.isArray(data.providers)
      ? data.providers.filter((p) => p && p.id && p.name && p.url)
      : [],
  };
}

/** 构建期由 build-ui.mjs 的 @inline 写入 <script type="application/json">，运行时零请求。 */
function readInlinePresetCatalog() {
  const holder = document.getElementById('providerPresetsData');
  if (!holder) return null;
  try {
    const data = JSON.parse(holder.textContent || '');
    return data && Array.isArray(data.providers) ? data : null;
  } catch (err) {
    console.warn('[provider-presets] 内联数据解析失败', err);
    return null;
  }
}

async function loadProviderPresetCatalog() {
  // 1) 内联数据（正常路径）。Tauri 资源协议下 fetch 同源 JSON 会失败，
  //    所以不能把这一步省略成"先 fetch 再兜底内联"。
  const inline = readInlinePresetCatalog();
  if (inline) {
    applyPresetCatalog(inline);
    globalThis.PROVIDER_PRESET_LOAD_ERROR = '';
    return;
  }

  // 2) 回退：直接用浏览器打开 ui/index.html 调试时才会走到这里
  try {
    const res = await fetch(new URL('../provider-presets.json', import.meta.url), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyPresetCatalog(await res.json());
    globalThis.PROVIDER_PRESET_LOAD_ERROR = '';
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    globalThis.PROVIDER_PRESET_LOAD_ERROR = message;
    globalThis.PROVIDER_PRESET_CATALOG = { groups: [], providers: [] };
    console.warn('[provider-presets] 加载失败', err);
    if (typeof addLog === 'function') {
      addLog('warn', `供应商预设加载失败：${message}`);
    }
  }
}

await loadProviderPresetCatalog();

globalThis.reloadProviderPresetCatalog = async function () {
  await loadProviderPresetCatalog();
  renderProviderPresetList();
};

function presetHostLabel(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return String(url || '');
  }
}

/**
 * 服务商品牌图标；没有对应 SVG 时退回首字母块。
 * 兜底不省略：23 家里有 3 家（商汤 / 302.AI / LM Studio）没有现成品牌图标，
 * 缺图标会让网格出现空洞，首字母块能保持行内节奏一致。
 */
function presetIconHtml(preset) {
  const svg = (globalThis.PROVIDER_ICON_SVGS || {})[String(preset.icon || '')];
  if (svg) {
    return `<span class="preset-item-icon" aria-hidden="true">${svg}</span>`;
  }
  const initial = String(preset.name || preset.id || '?').trim().charAt(0).toUpperCase();
  return `<span class="preset-item-icon is-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

function presetGroupLabel(groupId) {
  const hit = (globalThis.PROVIDER_PRESET_CATALOG.groups || []).find((g) => g.id === groupId);
  return hit ? hit.label : '其它';
}

/** 分组页签：全部 + 目录里声明的各组 */
function renderProviderPresetTabs() {
  const tabsEl = document.getElementById('providerPresetTabs');
  if (!tabsEl) return;
  const groups = globalThis.PROVIDER_PRESET_CATALOG.groups || [];
  const providers = globalThis.PROVIDER_PRESET_CATALOG.providers || [];
  const active = String(globalThis.PROVIDER_PRESET_GROUP || '');
  const tabs = [{ id: '', label: '全部', count: providers.length }].concat(
    groups.map((g) => ({
      id: g.id,
      label: g.label,
      count: providers.filter((p) => p.group === g.id).length,
    }))
  );
  tabsEl.innerHTML = tabs
    .map(
      (tab) => `<button type="button" class="preset-tab${tab.id === active ? ' active' : ''}"
        role="tab" aria-selected="${tab.id === active}"
        data-action="chooseProviderPresetGroup" data-arg="${escAttr(tab.id)}">${escapeHtml(tab.label)}${
        tab.count ? `<span class="preset-tab-count">${tab.count}</span>` : ''
      }</button>`
    )
    .join('');
}

globalThis.chooseProviderPresetGroup = function (groupId) {
  globalThis.PROVIDER_PRESET_GROUP = String(groupId || '');
  renderProviderPresetTabs();
  renderProviderPresetList();
};

function renderProviderPresetList() {
  const listEl = document.getElementById('providerPresetList');
  if (!listEl) return;
  const keyword = String(globalThis.PROVIDER_PRESET_KEYWORD || '').trim().toLowerCase();
  const all = globalThis.PROVIDER_PRESET_CATALOG.providers || [];
  const groupFilter = String(globalThis.PROVIDER_PRESET_GROUP || '');
  const scoped = groupFilter ? all.filter((p) => p.group === groupFilter) : all;
  const matched = keyword
    ? scoped.filter((p) =>
        [p.name, p.id, p.url, presetGroupLabel(p.group)]
          .some((v) => String(v || '').toLowerCase().includes(keyword))
      )
    : scoped;

  // 副标题随搜索/分组联动：用户能立刻看出是筛掉了还是压根没数据
  const kicker = document.getElementById('providerPresetKicker');
  if (kicker) {
    if (globalThis.PROVIDER_PRESET_LOAD_ERROR) {
      kicker.textContent = '模板数据未加载';
    } else if (keyword) {
      kicker.textContent = `匹配 ${matched.length} / 共 ${scoped.length} 个模板`;
    } else if (groupFilter) {
      kicker.textContent = `${presetGroupLabel(groupFilter)} · ${scoped.length} 个模板`;
    } else {
      kicker.textContent = `${all.length} 个模板 · 选中后自动填写地址与协议`;
    }
  }

  if (!matched.length) {
    // 三种空态要分开：加载失败 / 搜索无结果 / 目录为空
    if (globalThis.PROVIDER_PRESET_LOAD_ERROR) {
      listEl.innerHTML = `<div class="preset-empty is-error">
        <div>预设数据加载失败：${escapeHtml(globalThis.PROVIDER_PRESET_LOAD_ERROR)}</div>
        <button type="button" class="preset-retry-btn" data-action="reloadProviderPresetCatalog">重新加载</button>
      </div>`;
      return;
    }
    listEl.innerHTML = keyword
      ? `<div class="preset-empty">没有匹配的服务商，换个关键词或直接手动填写</div>`
      : `<div class="preset-empty">预设目录为空，可直接手动填写</div>`;
    return;
  }

  // 按 groups 声明顺序分组，未声明的归到末尾
  const order = (globalThis.PROVIDER_PRESET_CATALOG.groups || []).map((g) => g.id);
  const buckets = new Map();
  matched.forEach((p) => {
    const key = p.group || '__other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  });
  const keys = [...buckets.keys()].sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  listEl.innerHTML = keys
    .map((key) => {
      const items = buckets.get(key).map((p) => `
        <button type="button" class="preset-item" data-action="applyProviderPreset" data-args="${escAttr(JSON.stringify([p.id]))}">
          ${presetIconHtml(p)}
          <span class="preset-item-text">
            <span class="preset-item-name">${escapeHtml(p.name)}</span>
            <span class="preset-item-url">${escapeHtml(presetHostLabel(p.url))}</span>
          </span>
        </button>`).join('');
      return `
        <div class="preset-group">
          <div class="preset-group-label">${escapeHtml(presetGroupLabel(key))}</div>
          <div class="preset-group-items">${items}</div>
        </div>`;
    })
    .join('');
}

function setProviderPresetModal(open) {
  const modal = document.getElementById('providerPresetModal');
  if (!modal) return;
  globalThis.PROVIDER_PRESET_OPEN = !!open;
  modal.classList.toggle('active', !!open);
  if (open) {
    renderProviderPresetTabs();
    renderProviderPresetList();
    const search = document.getElementById('providerPresetSearch');
    if (search) {
      search.value = globalThis.PROVIDER_PRESET_KEYWORD || '';
      // 弹窗有显示过渡，等一帧再聚焦，否则焦点会丢在遮罩上
      setTimeout(() => search.focus(), 60);
    }
    if (!window._providerPresetEscBound) {
      window._providerPresetEscBound = true;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && globalThis.PROVIDER_PRESET_OPEN) setProviderPresetModal(false);
      });
    }
  }
}

globalThis.openProviderPresetModal = function (event) {
  if (event) event.stopPropagation();
  setProviderPresetModal(true);
};

globalThis.closeProviderPresetModal = function () {
  setProviderPresetModal(false);
};

globalThis.onProviderPresetSearch = function () {
  const search = document.getElementById('providerPresetSearch');
  globalThis.PROVIDER_PRESET_KEYWORD = search ? search.value : '';
  renderProviderPresetList();
};

function renderProviderPresetStatus(preset) {
  const statusEl = document.getElementById('providerPresetStatus');
  const labelEl = document.getElementById('providerPresetTriggerLabel');
  if (labelEl) labelEl.textContent = preset ? preset.name : '从模板库选择';
  if (!statusEl) return;
  if (!preset) {
    statusEl.hidden = true;
    statusEl.innerHTML = '';
    return;
  }
  const keyLink = preset.keyUrl
    ? `<a class="preset-key-link" href="${escAttr(preset.keyUrl)}" target="_blank" rel="noreferrer">去申请密钥</a>`
    : '';
  const hint = preset.hint
    ? `<span class="preset-hint">${escapeHtml(preset.hint)}</span>`
    : '';
  statusEl.innerHTML = `
    <span class="preset-status-main">已填入 ${escapeHtml(preset.name)}</span>
    ${keyLink}
    ${hint}`;
  statusEl.hidden = false;
}

globalThis.applyProviderPreset = function (id) {
  const preset = (globalThis.PROVIDER_PRESET_CATALOG.providers || []).find((p) => p.id === id);
  if (!preset) return;

  const nameEl = document.getElementById('pf-name');
  const hostEl = document.getElementById('pf-host');
  const fmtEl = document.getElementById('pf-format');
  if (nameEl) nameEl.value = preset.name;
  if (hostEl) hostEl.value = preset.url;
  if (fmtEl && preset.format) {
    // 预设给了协议就锁定：open.bigmodel.cn/api/paas/v4 这类地址自动识别会误判成 anthropic
    fmtEl.value = preset.format;
    fmtEl.dataset.locked = '1';
  }

  globalThis.PROVIDER_PRESET_ACTIVE_ID = preset.id;
  if (typeof onFormatChange === 'function') onFormatChange();
  if (typeof syncFormatDropdownUi === 'function') syncFormatDropdownUi(preset.format || 'auto');
  renderProviderPresetStatus(preset);
  setProviderPresetModal(false);

  // 免密供应商直接引导去拉模型，其余先填密钥
  const target = preset.noKey
    ? document.getElementById('pf-fetch-btn')
    : document.getElementById('pf-key');
  if (target && typeof target.focus === 'function') target.focus();
};

globalThis.resetProviderPresetUi = function (isNewProvider) {
  const field = document.getElementById('providerPresetField');
  if (field) field.hidden = !isNewProvider;
  globalThis.PROVIDER_PRESET_ACTIVE_ID = '';
  globalThis.PROVIDER_PRESET_KEYWORD = '';
  renderProviderPresetStatus(null);
  setProviderPresetModal(false);
};
