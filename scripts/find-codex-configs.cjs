const fs = require('fs');
const path = require('path');

const root = 'e:/project/AnyBridge';
const out = [];
function walk(d, depth) {
  if (depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', 'out', '.next'].includes(e.name)) continue;
      walk(full, depth + 1);
    } else if (/\.(json|js|ts|cjs|mjs)$/.test(e.name)) {
      try {
        const content = fs.readFileSync(full, 'utf8');
        if (/codexConfig|codex_configs|codexConfigs|currentCodex/.test(content)) {
          out.push(full);
        }
      } catch (err) {}
    }
  }
}
walk(root, 0);
console.log('files mentioning codexConfig:');
out.forEach(f => console.log(' -', f));
