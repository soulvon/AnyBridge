const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Find codex binary
try {
  const codexPath = execSync('where codex', { encoding: 'utf8' }).trim().split('\n')[0].trim();
  console.log('Codex binary:', codexPath);
  
  // Try to find the JS package
  const dir = path.dirname(codexPath);
  const possiblePaths = [
    path.join(dir, '..', 'lib', 'node_modules', '@openai', 'codex'),
    path.join(dir, '..', 'node_modules', '@openai', 'codex'),
    path.join(dir, '..', '..', 'lib', 'node_modules', '@openai', 'codex'),
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log('Package dir:', p);
      const pkgJson = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'));
      console.log('Version:', pkgJson.version);
      
      // Search for model_catalog_json in the source
      try {
        const grepResult = execSync(`findstr /s /i "model_catalog_json" "${p}\\*.js"`, { encoding: 'utf8', timeout: 10000 });
        console.log('Found references:');
        console.log(grepResult.substring(0, 3000));
      } catch (e) {
        console.log('findstr in JS files:', e.stdout || e.message);
      }
      
      // Also search in the main bundle
      const mainFile = path.join(p, pkgJson.main || 'index.js');
      if (fs.existsSync(mainFile)) {
        console.log('Main file:', mainFile, 'size:', fs.statSync(mainFile).size);
        const content = fs.readFileSync(mainFile, 'utf8');
        // Search for model_catalog_json
        const idx = content.indexOf('model_catalog_json');
        if (idx >= 0) {
          console.log('Found model_catalog_json at index', idx);
          console.log('Context:', content.substring(Math.max(0, idx - 200), idx + 500));
        }
      }
      break;
    }
  }
} catch (e) {
  console.log('Error:', e.message);
}

// 2. Try codex debug models
try {
  const out = execSync('codex debug models --bundled 2>&1', { timeout: 10000, encoding: 'utf8' });
  console.log('\n=== codex debug models --bundled ===');
  console.log(out.substring(0, 2000));
} catch (e) {
  console.log('\n=== codex debug models failed ===');
  console.log('stdout:', (e.stdout || '').substring(0, 1000));
  console.log('stderr:', (e.stderr || '').substring(0, 1000));
}
