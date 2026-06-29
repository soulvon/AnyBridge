// 直接往 providers.json 的 codexConfigs 数组添加一个基于 OpenCode 供应商的 Codex 配置
const fs = require('fs');
const path = require('path');
const { configDir } = require('./lib/config-dir.cjs');

const providersPath = path.join(configDir(), 'providers.json');

const data = JSON.parse(fs.readFileSync(providersPath, 'utf8'));

// 找 OpenCode 供应商
const openCodeProvider = (data.providers || []).find(p => p && p.name === 'OpenCode');
if (!openCodeProvider) {
  console.error('未找到 OpenCode 供应商');
  process.exit(1);
}

console.log('OpenCode 供应商信息:');
console.log('  id:', openCodeProvider.id);
console.log('  name:', openCodeProvider.name);
console.log('  apiHost:', openCodeProvider.apiHost);
console.log('  apiPath:', openCodeProvider.apiPath);
console.log('  apiKey:', (openCodeProvider.apiKey || '').slice(0, 10) + '...');
console.log('  models:', JSON.stringify(openCodeProvider.models || []));
console.log('  wireApi:', openCodeProvider.wireApi);

// 构造 codexConfig，完全模拟 saveCodexConfigEditor 的逻辑
// providerEndpointParts(baseUrl, 'openai', '/v1') 的逻辑：
// baseUrl = codexConfigDisplayBaseUrl(source) = codexTargetBaseUrl(source) = platformJoinUrl(apiHost, apiPath) + 确保以 /v1 结尾
// platformJoinUrl('https://opencode.ai', '/zen/go') = 'https://opencode.ai/zen/go'
// codexTargetBaseUrl: 'https://opencode.ai/zen/go' 不以 /v1 结尾 → 'https://opencode.ai/zen/go/v1'
// 然后 providerEndpointParts('https://opencode.ai/zen/go/v1', 'openai', '/v1')
//   → apiHost: 'https://opencode.ai', apiPath: '/zen/go/v1'

const baseUrl = 'https://opencode.ai/zen/go/v1';
// 正确模拟 providerEndpointParts (40-model-picker.js L719)
function providerEndpointParts(baseUrl) {
  let apiHost = baseUrl;
  let parsedPath = '';
  try {
    const url = new URL(String(baseUrl || '').startsWith('http') ? baseUrl : 'https://' + baseUrl);
    apiHost = url.origin;
    const pathname = url.pathname;
    const raw = String(pathname || '').trim();
    parsedPath = (!raw || raw === '/') ? '' : '/' + raw.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {}
  const apiPath = parsedPath || '/v1';
  return { apiHost, apiPath };
}

const endpoint = providerEndpointParts(baseUrl);
console.log('\n解析后的 endpoint:');
console.log('  apiHost:', endpoint.apiHost);
console.log('  apiPath:', endpoint.apiPath);

const newConfig = {
  id: `codex-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  name: openCodeProvider.name,
  apiHost: endpoint.apiHost,
  apiKey: openCodeProvider.apiKey || '',
  apiPath: endpoint.apiPath || '/v1',
  defaultModel: (openCodeProvider.models || [])[0] || 'minimax-m3',
  models: openCodeProvider.models || [],
  wireApi: openCodeProvider.wireApi || 'responses',
  sourceProviderId: openCodeProvider.id,
  sourceProviderName: openCodeProvider.name,
};

console.log('\n新增 codexConfig:');
console.log(JSON.stringify(newConfig, null, 2));

// 确保有 codexConfigs 数组
if (!Array.isArray(data.codexConfigs)) data.codexConfigs = [];

// 检查是否已存在同名配置
const existing = data.codexConfigs.find(c => c && c.name === newConfig.name);
if (existing) {
  console.log('\n已存在同名配置，将更新');
  Object.assign(existing, newConfig);
} else {
  data.codexConfigs.push(newConfig);
  console.log('\n已添加新配置');
}

// 写回
fs.writeFileSync(providersPath, JSON.stringify(data, null, 2), 'utf8');
console.log('\n已写入 providers.json');
console.log('当前 codexConfigs 数量:', data.codexConfigs.length);
data.codexConfigs.forEach((c, i) => {
  console.log(`  [${i}] ${c.name} (id: ${c.id}, apiHost: ${c.apiHost}, apiPath: ${c.apiPath}, defaultModel: ${c.defaultModel}, wireApi: ${c.wireApi})`);
});
