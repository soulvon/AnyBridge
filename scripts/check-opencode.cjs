const fs = require('fs');
const path = require('path');
const { configDir } = require('./lib/config-dir.cjs');

const anybridgeConfigDir = configDir();

const providersFile = path.join(anybridgeConfigDir, 'providers.json');
const data = JSON.parse(fs.readFileSync(providersFile, 'utf8'));

const opencode = data.providers.find(p => p.id === 'p-1782238927068-ipois');
if (opencode) {
  console.log('=== OpenCode Provider ===');
  console.log('id:', opencode.id);
  console.log('name:', opencode.name);
  console.log('apiHost:', opencode.apiHost);
  console.log('apiPath:', opencode.apiPath);
  console.log('wireApi:', opencode.wireApi);
  console.log('defaultModel:', opencode.defaultModel);
  console.log('apiKey:', opencode.apiKey ? opencode.apiKey.substring(0, 15) + '...' : '(not set)');
  console.log('full config keys:', Object.keys(opencode));
  // Print full config minus apiKey
  const safe = { ...opencode };
  if (safe.apiKey) safe.apiKey = safe.apiKey.substring(0, 15) + '...';
  console.log('Full:', JSON.stringify(safe, null, 2));
}
