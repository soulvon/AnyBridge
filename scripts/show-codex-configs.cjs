// 显示 providers.json 的 codexConfigs
const fs = require('fs');
const path = require('path');
const { configDir } = require('./lib/config-dir.cjs');

const providersPath = path.join(configDir(), 'providers.json');

console.log('config dir:', configDir);
console.log('providers path:', providersPath);
console.log('exists:', fs.existsSync(providersPath));
console.log('---');

if (!fs.existsSync(providersPath)) {
  console.log('providers.json 不存在');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
console.log('top-level keys:', Object.keys(data));
console.log('codexConfigs:', JSON.stringify(data.codexConfigs || [], null, 2));
console.log('---');
console.log('providers count:', (data.providers || []).length);
console.log('provider names:', (data.providers || []).map(p => p.name));
