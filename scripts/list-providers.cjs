const fs = require('fs');
const path = require('path');
const p = path.join(process.env.APPDATA, 'anybridge', 'providers.json');
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
const providers = data.providers || [];
console.log('=== 供应商列表 ===');
providers.forEach(function(pr) {
  if (pr.meta && pr.meta.codexConfig) return;
  console.log('ID:', pr.id);
  console.log('  Name:', pr.name);
  console.log('  Host:', pr.apiHost);
  console.log('  Models:', (pr.models || []).join(', '));
  console.log('  Enabled:', pr.enabled);
  console.log('---');
});
