const fs = require('fs');
const path = require('path');

// Read the gpt-5.5 template from models_cache.json
const cache = JSON.parse(fs.readFileSync('C:/Users/admin/.codex/models_cache.json', 'utf8'));
const template = cache.models.find(m => m.slug === 'gpt-5.5');
if (!template) {
  console.error('ERROR: gpt-5.5 template not found in models_cache.json');
  process.exit(1);
}

// Our custom models
const customModels = [
  { slug: 'minimax-m3', display_name: 'minimax-m3', context_window: 128000 },
  { slug: 'deepseek-v4-pro', display_name: 'deepseek-v4-pro', context_window: 128000 },
  { slug: 'deepseek-v4-flash', display_name: 'deepseek-v4-flash', context_window: 128000 },
  { slug: 'glm-5.2', display_name: 'glm-5.2', context_window: 128000 },
  { slug: 'glm-5.1', display_name: 'glm-5.1', context_window: 128000 },
  { slug: 'glm-5', display_name: 'glm-5', context_window: 128000 },
  { slug: 'kimi-k2.7-code', display_name: 'kimi-k2.7-code', context_window: 128000 },
  { slug: 'kimi-k2.6', display_name: 'kimi-k2.6', context_window: 128000 },
  { slug: 'kimi-k2.5', display_name: 'kimi-k2.5', context_window: 128000 },
  { slug: 'minimax-m2.7', display_name: 'minimax-m2.7', context_window: 128000 },
  { slug: 'minimax-m2.5', display_name: 'minimax-m2.5', context_window: 128000 },
  { slug: 'qwen3.7-max', display_name: 'qwen3.7-max', context_window: 128000 },
  { slug: 'qwen3.7-plus', display_name: 'qwen3.7-plus', context_window: 128000 },
  { slug: 'qwen3.6-plus', display_name: 'qwen3.6-plus', context_window: 128000 },
  { slug: 'qwen3.5-plus', display_name: 'qwen3.5-plus', context_window: 128000 },
  { slug: 'hy3-preview', display_name: 'hy3-preview', context_window: 128000 },
];

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
fs.writeFileSync(
  'C:/Users/admin/.codex/anybridge-model-catalog.json',
  JSON.stringify(catalog, null, 2)
);
console.log(`Catalog written as ModelsResponse format: ${models.length} models`);
console.log('First model keys:', Object.keys(models[0]).join(', '));
