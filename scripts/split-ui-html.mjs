/**
 * One-shot splitter: ui/index.html -> ui-src partials + shell with @include.
 * Preserves exact line content and order for zero-regression rebuild.
 *
 * Usage (rare — only when re-slicing from a monolithic index.html):
 *   node scripts/split-ui-html.mjs
 * Then:
 *   node scripts/build-ui.mjs --compare-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcHtml = path.join(root, 'ui', 'index.html');
const outRoot = path.join(root, 'ui-src');

const text = fs.readFileSync(srcHtml, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';
const endsWithNl = /\r?\n$/.test(text);
const lines = text.split(/\r?\n/);
if (endsWithNl && lines[lines.length - 1] === '') lines.pop();

console.log(`Source: ${lines.length} lines, newline=${nl === '\r\n' ? 'CRLF' : 'LF'}`);

const pageStarts = [];
for (let i = 0; i < lines.length; i++) {
  if (/<!-- ═+ PAGE:/.test(lines[i])) {
    const name = lines[i]
      .replace(/.*PAGE:\s*/, '')
      .replace(/\s*═.*$/, '')
      .trim();
    pageStarts.push({ line: i + 1, name, index: i });
  }
}

console.log('Pages found:', pageStarts.length);
for (const p of pageStarts) console.log(`  L${p.line}: ${p.name}`);

let mainOpen = -1;
let mainClose = -1;
let bodyClose = -1;

for (let i = 0; i < lines.length; i++) {
  if (mainOpen < 0 && /<main\b/.test(lines[i])) mainOpen = i;
  if (/<\/main>/.test(lines[i])) mainClose = i;
  if (/<\/body>/.test(lines[i])) bodyClose = i;
}

const nameMap = {
  'PLATFORM · WINDSURF / DEVIN': 'platform-proxy',
  PROVIDERS: 'providers',
  'PROVIDER EDITOR (新增/编辑供应商)': 'provider-editor',
  'SLOT MAPPING EDITOR (添加/编辑映射)': 'slot-editor',
  'MODEL SLOT MANAGEMENT': 'model-slots',
  'MODEL MAP': 'models',
  EVALUATION: 'eval',
  'EVALUATION HISTORY': 'eval-history',
  PROXY: 'proxy',
  'PLATFORM OVERVIEW': 'more-platforms',
  'PLATFORM · CURSOR': 'platform-cursor',
  'PLATFORM · CLAUDE CODE': 'platform-claude',
  'PLATFORM · CODEX': 'platform-codex',
  'PLATFORM · GEMINI CLI': 'platform-gemini',
  'PLATFORM · OPENCODE': 'platform-opencode',
  'PLATFORM · CODEBUDDY': 'platform-codebuddy',
  'PLATFORM · CODEBUDDY · 添加模型（独立页面）': 'platform-codebuddy-add',
  'PLATFORM · QODER': 'platform-qoder',
  'PLATFORM · KIRO': 'platform-kiro',
  'PLATFORM · TRAE': 'platform-trae',
  'PLATFORM · ZCODE': 'platform-zcode',
  'PLATFORM · ZCODE · 添加模型（独立页面）': 'platform-zcode-add',
  'PLATFORM · WORKBUDDY': 'platform-workbuddy',
  'PLATFORM · WORKBUDDY · 添加模型（独立页面）': 'platform-workbuddy-add',
  SETTINGS: 'settings',
};

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[·•]/g, ' ')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function pageFileName(name) {
  if (nameMap[name]) return nameMap[name];
  const s = slugify(name);
  if (!s) console.warn(`  warn: unmapped page name: ${name}`);
  return s || 'page-unknown';
}

const pageBlocks = [];
for (let i = 0; i < pageStarts.length; i++) {
  const start = pageStarts[i].index;
  const end =
    i + 1 < pageStarts.length
      ? pageStarts[i + 1].index - 1
      : mainClose > 0
        ? mainClose - 1
        : start;
  pageBlocks.push({
    name: pageStarts[i].name,
    file: pageFileName(pageStarts[i].name),
    start,
    end,
  });
}

const afterMainStart = mainClose + 1;
const afterMainEnd = bodyClose - 1;

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function writeLines(filePath, lineArr) {
  ensureDir(path.dirname(filePath));
  const content = lineArr.length === 0 ? '' : lineArr.join(nl) + nl;
  fs.writeFileSync(filePath, content, 'utf8');
}

if (fs.existsSync(outRoot)) {
  fs.rmSync(outRoot, { recursive: true, force: true });
}
ensureDir(path.join(outRoot, 'partials', 'pages'));

const headThroughMainOpen = lines.slice(0, mainOpen + 1);
const includeLines = [];
for (const block of pageBlocks) {
  const chunk = lines.slice(block.start, block.end + 1);
  const rel = `partials/pages/${block.file}.html`;
  writeLines(path.join(outRoot, rel), chunk);
  includeLines.push(`    <!-- @include ${rel} -->`);
  console.log(`  wrote ${rel} (${chunk.length} lines) L${block.start + 1}-${block.end + 1}`);
}

const bodyTail = lines.slice(afterMainStart, afterMainEnd + 1);
writeLines(path.join(outRoot, 'partials/body-tail.html'), bodyTail);
console.log(`  wrote partials/body-tail.html (${bodyTail.length} lines)`);

const shell = [];
const prePage = lines.slice(mainOpen + 1, pageBlocks[0].start);
const postPages = lines.slice(pageBlocks[pageBlocks.length - 1].end + 1, mainClose);

for (const line of headThroughMainOpen) shell.push(line);
for (const line of prePage) shell.push(line);
for (const line of includeLines) shell.push(line);
for (const line of postPages) shell.push(line);
shell.push(lines[mainClose]);
shell.push(`    <!-- @include partials/body-tail.html -->`);
for (let i = bodyClose; i < lines.length; i++) shell.push(lines[i]);

writeLines(path.join(outRoot, 'index.html'), shell);

const manifest = {
  sourceLines: lines.length,
  newline: nl === '\r\n' ? 'CRLF' : 'LF',
  pages: pageBlocks.map((b) => ({
    file: b.file,
    name: b.name,
    start: b.start + 1,
    end: b.end + 1,
    lines: b.end - b.start + 1,
  })),
  bodyTail: { start: afterMainStart + 1, end: afterMainEnd + 1, lines: bodyTail.length },
};
fs.writeFileSync(
  path.join(outRoot, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + nl,
  'utf8',
);

console.log(`\nShell: ui-src/index.html (${shell.length} lines)`);
console.log('Done. Run: node scripts/build-ui.mjs');
