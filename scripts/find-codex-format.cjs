const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findOnPath(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const out = execFileSync(lookup, [command], { encoding: 'utf8' });
  return out.trim().split(/\r?\n/)[0].trim();
}

function listJsFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  }
  return out;
}

function searchFiles(files, needle) {
  const matches = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle.toLowerCase())) {
        matches.push(`${file}:${index + 1}:${line.trim()}`);
      }
    });
  }
  return matches;
}

// 1. Find codex binary
try {
  const codexPath = findOnPath('codex');
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
      
      const matches = searchFiles(listJsFiles(p), 'model_catalog_json');
      console.log('Found references:');
      console.log(matches.slice(0, 80).join('\n') || '(none)');
      
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
  const out = execFileSync('codex', ['debug', 'models', '--bundled'], { timeout: 10000, encoding: 'utf8' });
  console.log('\n=== codex debug models --bundled ===');
  console.log(out.substring(0, 2000));
} catch (e) {
  console.log('\n=== codex debug models failed ===');
  console.log('stdout:', (e.stdout || '').substring(0, 1000));
  console.log('stderr:', (e.stderr || '').substring(0, 1000));
}
