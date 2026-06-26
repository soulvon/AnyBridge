const fs = require('fs');
const path = require('path');

const configDir = process.env.BYOK_CONFIG_DIR || 
  path.join(process.env.APPDATA || '', 'anybridge');

// Check proxy-routes.json
try {
  const f = path.join(configDir, 'proxy-routes.json');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log('=== Proxy Routes ===');
  const routes = Array.isArray(data) ? data : (data.routes || []);
  console.log('Route count:', routes.length);
  routes.forEach((r, i) => {
    console.log(`\n[${i}] id=${r.id} enabled=${r.enabled !== false}`);
    if (r.targets && Array.isArray(r.targets)) {
      r.targets.forEach((t, j) => {
        console.log(`  target[${j}]: provider=${t.providerId||t.provider} model=${t.model||'(default)'}`);
      });
    }
  });
} catch (e) {
  console.log('Proxy routes err:', e.message);
}

// Check the specific model deepseek-v4-flash
try {
  const f = path.join(configDir, 'proxy-routes.json');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  const routes = Array.isArray(data) ? data : (data.routes || []);
  const flash = routes.find(r => r.id === 'deepseek-v4-flash');
  if (flash) {
    console.log('\n=== deepseek-v4-flash route ===');
    console.log(JSON.stringify(flash, null, 2));
  } else {
    console.log('\ndeepseek-v4-flash not found in routes');
    console.log('Available IDs:', routes.map(r => r.id).join(', '));
  }
} catch (e) {
  console.log('Err:', e.message);
}
