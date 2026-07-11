import fs from 'node:fs';

const n = (s) => s.replace(/\r\n/g, '\n');
const a = n(fs.readFileSync('ui/index.html.baseline', 'utf8')).split('\n');
const b = n(fs.readFileSync('ui/index.html', 'utf8')).split('\n');
console.log('lens', a.length, b.length);
let diffs = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    diffs++;
    if (diffs <= 20) {
      console.log('--- line', i + 1);
      console.log('BASE', JSON.stringify((a[i] || '').slice(0, 120)));
      console.log('OUT ', JSON.stringify((b[i] || '').slice(0, 120)));
    }
  }
}
console.log('total diffs', diffs);
