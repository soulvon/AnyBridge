import fs from 'node:fs';

const a = fs.readFileSync('ui/index.html', 'utf8');
const b = fs.readFileSync('ui/index.html.baseline', 'utf8');
const n = (s) => s.replace(/\r\n/g, '\n');
const match = n(a) === n(b);
const onclick = (a.match(/onclick=/g) || []).length;
const onchange = (a.match(/onchange=/g) || []).length;
console.log(
  JSON.stringify(
    {
      match,
      lines: a.split(/\r?\n/).length,
      onclick,
      onchange,
      bytes: Buffer.byteLength(a),
    },
    null,
    2,
  ),
);
if (!match) process.exit(1);
