const fs = require('fs');
const os = require('os');
const path = require('path');

// Align with Rust codex_home() / sidecar codex-home.js: CODEX_HOME, else ~/.codex
function codexHome() {
  const raw = process.env.CODEX_HOME;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) return path.resolve(trimmed);
  }
  return path.join(os.homedir(), '.codex');
}

const codexDir = codexHome();
const modelsCachePath = path.join(codexDir, 'models_cache.json');
const catalogOutPath = path.join(codexDir, 'anybridge-model-catalog.json');

if (!fs.existsSync(modelsCachePath)) {
  console.error(`ERROR: models_cache.json not found: ${modelsCachePath}`);
  console.error('Start Codex once to generate it, or set CODEX_HOME if non-default.');
  process.exit(1);
}

// Read the gpt-5.5 template from models_cache.json
const cache = JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'));
const template = cache.models.find(m => m.slug === 'gpt-5.5');
if (!template) {
  console.error(`ERROR: gpt-5.5 template not found in ${modelsCachePath}`);
  process.exit(1);
}

function isAmbiguousToken(token) {
  const t = String(token || '').toLowerCase();
  if (!t) return true;
  if (t.length <= 3) return true;
  if (t.length < 5 && !t.includes('-') && !t.includes('_') && !t.includes('/')) return true;
  if (/^[a-z]{0,2}\d+(\.\d+)+$/.test(t)) return true;
  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenMatches(id, token) {
  const t = String(token || '').toLowerCase();
  if (!t) return false;
  if (id === t) return true;
  if (isAmbiguousToken(t)) {
    return id.startsWith(`${t}-`) || id.startsWith(`${t}.`) || id.startsWith(`${t}_`);
  }
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`);
  return re.test(id);
}

// 按模型名推荐上下文（读 model-context-presets.json，边界匹配）
function recommendContext(slug) {
  const presetsPath = path.join(__dirname, '../ui/assets/model-context-presets.json');
  let presets = { defaults: { maxInputTokens: 128000 }, models: [], patterns: [] };
  try {
    presets = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
  } catch {}
  const id = String(slug || '').toLowerCase().replace(/\s+/g, '-');
  const fallback = Number(presets?.defaults?.maxInputTokens) || 128000;
  if (!id) return fallback;

  let best = null;
  let bestScore = -1;
  for (const entry of presets.models || []) {
    const tokens = Array.isArray(entry.match) && entry.match.length
      ? entry.match
      : [entry.id].filter(Boolean);
    for (const token of tokens) {
      const t = String(token || '').toLowerCase();
      if (!t || !tokenMatches(id, t)) continue;
      let score = -1;
      if (id === t) score = 1000 + t.length;
      else if (id.startsWith(t)) score = 200 + t.length;
      else score = 100 + t.length;
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
  }
  if (best) return Number(best.maxInputTokens) || fallback;

  for (const entry of presets.patterns || []) {
    const includes = entry.includesAny || [];
    if (!includes.some((x) => tokenMatches(id, String(x).toLowerCase()))) continue;
    const requires = entry.requiresAny || [];
    if (requires.length && !requires.some((x) => tokenMatches(id, String(x).toLowerCase()))) continue;
    return Number(entry.maxInputTokens) || fallback;
  }
  return fallback;
}

// Our custom models
const customModels = [
  { slug: 'minimax-m3', display_name: 'minimax-m3' },
  { slug: 'deepseek-v4-pro', display_name: 'deepseek-v4-pro' },
  { slug: 'deepseek-v4-flash', display_name: 'deepseek-v4-flash' },
  { slug: 'glm-5.2', display_name: 'glm-5.2' },
  { slug: 'glm-5.1', display_name: 'glm-5.1' },
  { slug: 'glm-5', display_name: 'glm-5' },
  { slug: 'kimi-k2.7-code', display_name: 'kimi-k2.7-code' },
  { slug: 'kimi-k2.6', display_name: 'kimi-k2.6' },
  { slug: 'kimi-k2.5', display_name: 'kimi-k2.5' },
  { slug: 'minimax-m2.7', display_name: 'minimax-m2.7' },
  { slug: 'minimax-m2.5', display_name: 'minimax-m2.5' },
  { slug: 'qwen3.7-max', display_name: 'qwen3.7-max' },
  { slug: 'qwen3.7-plus', display_name: 'qwen3.7-plus' },
  { slug: 'qwen3.6-plus', display_name: 'qwen3.6-plus' },
  { slug: 'qwen3.5-plus', display_name: 'qwen3.5-plus' },
  { slug: 'hy3-preview', display_name: 'hy3-preview' },
].map((m) => ({ ...m, context_window: recommendContext(m.slug) }));

// Deep copy template for each custom model
const models = customModels.map((m, i) => {
  const copy = JSON.parse(JSON.stringify(template));
  copy.slug = m.slug;
  copy.display_name = m.display_name;
  copy.description = m.display_name;
  copy.context_window = m.context_window;
  copy.max_context_window = m.context_window;
  copy.priority = 1000 + i;
  copy.visibility = 'list';
  copy.supported_in_api = true;
  return copy;
});

// Write as ModelsResponse format: {"models": [...]}
const catalog = { models };
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(catalogOutPath, JSON.stringify(catalog, null, 2));
console.log(`Catalog written as ModelsResponse format: ${models.length} models`);
console.log(`Path: ${catalogOutPath}`);
console.log('Contexts:', models.map(m => `${m.slug}=${m.context_window}`).join(', '));
console.log('First model keys:', Object.keys(models[0]).join(', '));
