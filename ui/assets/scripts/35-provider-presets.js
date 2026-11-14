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
  // Vertex 这类需要完整资源路径的供应商：预设带 path 时直接写入隐藏字段（{project} 由用户替换）
  const pathEl = document.getElementById('pf-path');
  if (pathEl && preset.path) pathEl.value = withPresetRegion(preset.path, preset.defaultRegion || '');
  // 拿不到模型列表接口的供应商（Vertex Express）：预设自带实测模型清单，一键勾选
  if (Array.isArray(preset.models) && preset.models.length && typeof globalThis.applyPresetModels === 'function') {
    globalThis.applyPresetModels(preset.models, preset.defaultModel);
  }
  renderProviderPresetStatus(preset);
  setProviderPresetModal(false);
  // 预设可能写入 Vertex 资源路径：同步「获取模型列表」的可用状态
  if (typeof globalThis.syncVertexModelListHint === 'function') globalThis.syncVertexModelListHint();
  // 预设声明了地区：长出「地区下拉 + 测速」一行
  if (typeof globalThis.syncVertexRegionPicker === 'function') globalThis.syncVertexRegionPicker();

  // 免密供应商直接引导去拉模型，其余先填密钥
  const target = preset.noKey
    ? document.getElementById('pf-fetch-btn')
    : document.getElementById('pf-key');
  if (target && typeof target.focus === 'function') target.focus();
};

// ── Vertex 地区选择与测速 ──
// Express Key 的模型按地区部署（Gemini 4 只在 global/us/eu 可用），各地延迟差异明显。
// 这里给一行「地区下拉 + 测速」：测速用最便宜的 flash-lite 打一发，按耗时排序并自动切到最快。
function withPresetRegion(template, region) {
  return String(template || '').replace('{region}', region || 'global');
}

function vertexRegionFromPath(pathValue) {
  const m = String(pathValue || '').match(/\/locations\/([^/]+)\//);
  return m ? m[1] : '';
}

function rewriteVertexRegion(pathValue, region) {
  const text = String(pathValue || '');
  if (!region || !/\/locations\/[^/]+\//.test(text)) return text;
  return text.replace(/\/locations\/[^/]+\//, `/locations/${region}/`);
}

/** 当前是否处于 Vertex 场景：模板声明了 regions，或路径/地址本身指向 Vertex。 */
function activeVertexRegionPreset() {
  const providers = (globalThis.PROVIDER_PRESET_CATALOG || {}).providers || [];
  const activeId = String(globalThis.PROVIDER_PRESET_ACTIVE_ID || '');
  const byActive = providers.find((p) => p.id === activeId);
  if (byActive && Array.isArray(byActive.regions) && byActive.regions.length) return byActive;
  const pathValue = document.getElementById('pf-path')?.value || '';
  const hostValue = document.getElementById('pf-host')?.value || '';
  if (/\/publishers\/google\/models/.test(pathValue) || /aiplatform\.googleapis\.com/.test(hostValue)) {
    return providers.find((p) => p.id === 'vertexai' && Array.isArray(p.regions)) || null;
  }
  return null;
}

globalThis.syncVertexRegionPicker = function () {
  const preset = activeVertexRegionPreset();
  const hostEl = document.getElementById('pf-host');
  const field = hostEl && hostEl.closest('.field');
  if (!field) return;
  const existing = document.getElementById('pf-vertex-region-row');
  if (!preset) {
    if (existing) existing.remove();
    return;
  }
  const pathEl = document.getElementById('pf-path');
  // 编辑已有卡时 pf-path 可能为空、完整路径在显示用的 API 地址里，两处都要反解
  const current = vertexRegionFromPath(pathEl && pathEl.value)
    || vertexRegionFromPath(hostEl && hostEl.value)
    || preset.defaultRegion
    || preset.regions[0].id;
  const options = preset.regions
    .map((r) => `<option value="${escAttr(r.id)}">${escapeHtml(r.label || r.id)}</option>`)
    .join('');
  let row = existing;
  if (!row) {
    row = document.createElement('div');
    row.id = 'pf-vertex-region-row';
    row.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:var(--text-secondary);';
    const label = document.createElement('span');
    label.textContent = '地区';
    label.style.cssText = 'white-space:nowrap;';
    const select = document.createElement('select');
    select.id = 'pf-vertex-region';
    select.style.cssText = 'height:30px; padding:0 8px; border-radius:8px; border:1px solid var(--border); background:var(--bg-input); color:var(--text-primary); font-size:12px;';
    select.addEventListener('change', () => {
      const target = document.getElementById('pf-path');
      if (target) target.value = rewriteVertexRegion(target.value, select.value);
      const resultEl = document.getElementById('pf-vertex-latency-result');
      if (resultEl) resultEl.textContent = '';
    });
    const probeBtn = document.createElement('button');
    probeBtn.type = 'button';
    probeBtn.id = 'pf-vertex-latency';
    probeBtn.textContent = '测速';
    probeBtn.style.cssText = 'height:30px; padding:0 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg-card); color:var(--text-primary); font-size:12px; cursor:pointer;';
    probeBtn.addEventListener('click', () => probeVertexRegions(preset));
    const resultEl = document.createElement('span');
    resultEl.id = 'pf-vertex-latency-result';
    row.append(label, select, probeBtn, resultEl);
    field.insertAdjacentElement('afterend', row);
  }
  const select = row.querySelector('#pf-vertex-region');
  if (select) {
    select.innerHTML = options;
    if (preset.regions.some((r) => r.id === current)) select.value = current;
  }
};

/** 用最便宜的轻量模型并发探测各地区，按耗时排序并把路径切到最快地区。 */
async function probeVertexRegions(preset) {
  const call = typeof invoke === 'function' ? invoke : null;
  const resultEl = document.getElementById('pf-vertex-latency-result');
  const btn = document.getElementById('pf-vertex-latency');
  const setResult = (text) => { if (resultEl) resultEl.textContent = text; };
  if (!call) { setResult('应用通道未就绪'); return; }
  const hostValue = (document.getElementById('pf-host')?.value || '').trim();
  const apiKey = (document.getElementById('pf-key')?.value || '').trim();
  const pathValue = document.getElementById('pf-path')?.value || '';
  if (!hostValue || !apiKey) { setResult('先填 API 地址与密钥再测速'); return; }
  if (hostValue.includes('{project}') || pathValue.includes('{project}')) { setResult('先把路径里的 {project} 换成项目 ID'); return; }
  // 编辑已有卡时「API 地址」框是 host+path 拼接的显示值：正则抓出完整资源路径，host 取 origin
  const joined = `${hostValue} ${pathValue}`;
  const pathMatch = joined.match(/\/v1\/projects\/[^/\s]+\/locations\/[^/\s]+\/publishers\/google\/models/);
  const basePath = pathMatch ? pathMatch[0] : '';
  if (!basePath) { setResult('没解析出 Vertex 资源路径，检查 API 地址是否完整'); return; }
  const apiHost = (typeof globalThis.providerEndpointParts === 'function'
    ? globalThis.providerEndpointParts(hostValue, 'gemini', pathValue || null).apiHost
    : hostValue.replace(/\/v1\/.*$/, ''));
  const model = preset.probeModel || 'gemini-3.5-flash-lite';
  const regions = preset.regions.slice();
  if (btn) { btn.disabled = true; btn.textContent = '测速中…'; }
  setResult(`正在用 ${model} 探测 ${regions.length} 个地区…`);
  const results = [];
  const queue = regions.slice();
  const worker = async () => {
    while (queue.length) {
      const region = queue.shift();
      const started = Date.now();
      try {
        const r = await call('test_connection', {
          args: {
            host: apiHost,
            api_key: apiKey,
            path: rewriteVertexRegion(basePath, region.id),
            api_format: 'gemini',
            model,
          },
        });
        results.push({ region: region.id, label: region.label || region.id, ms: Number(r && r.latencyMs) || (Date.now() - started) });
      } catch (err) {
        results.push({ region: region.id, label: region.label || region.id, ms: Infinity, error: String(err || '') });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const ok = results.filter((r) => Number.isFinite(r.ms)).sort((a, b) => a.ms - b.ms);
  const failed = results.length - ok.length;
  if (btn) { btn.disabled = false; btn.textContent = '测速'; }
  if (!ok.length) {
    const firstError = (results.find((r) => r.error) || {}).error || '';
    setResult(`所有地区都失败：${firstError.slice(0, 120) || '检查密钥与网络'}`);
    return;
  }
  const fastest = ok[0];
  const summary = ok.map((r) => `${r.label} ${(r.ms / 1000).toFixed(1)}s`).join(' · ');
  setResult(`${summary}${failed ? `｜${failed} 个失败` : ''}（已选最快：${fastest.label}）`);
  const select = document.getElementById('pf-vertex-region');
  if (select && regions.some((r) => r.id === fastest.region)) select.value = fastest.region;
  const pathEl = document.getElementById('pf-path');
  if (pathEl) pathEl.value = rewriteVertexRegion(basePath, fastest.region);
}

globalThis.resetProviderPresetUi = function (isNewProvider) {
  const field = document.getElementById('providerPresetField');
  if (field) field.hidden = !isNewProvider;
  globalThis.PROVIDER_PRESET_ACTIVE_ID = '';
  globalThis.PROVIDER_PRESET_KEYWORD = '';
  renderProviderPresetStatus(null);
  setProviderPresetModal(false);
};
