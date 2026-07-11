/**
 * Split ui-src/partials/body-tail.html into modals + scripts,
 * and extract page-extensions from eval-history.
 * Zero-regression: rebuild must match previous ui/index.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'ui-src');
const partials = path.join(srcRoot, 'partials');
const modalsDir = path.join(partials, 'modals');
const pagesDir = path.join(partials, 'pages');

function readLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, nl };
}

function writeLines(filePath, lines, nl) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.length ? lines.join(nl) + nl : '', 'utf8');
}

// ── 1) Extract page-extensions from eval-history ──────────────────────────
const evalHistPath = path.join(pagesDir, 'eval-history.html');
const { lines: evalLines, nl } = readLines(evalHistPath);

let extStart = -1;
for (let i = 0; i < evalLines.length; i++) {
  if (evalLines[i].includes('id="page-extensions"')) {
    // include blank line before if present
    extStart = i > 0 && evalLines[i - 1].trim() === '' ? i - 1 : i;
    break;
  }
}
if (extStart < 0) {
  console.log('page-extensions already extracted or missing');
} else {
  // find end of page-extensions: last non-empty content after start
  // The extensions page runs to end of file
  const before = evalLines.slice(0, extStart);
  // drop trailing blank lines from before if we took the blank into extensions
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  // keep one trailing blank in eval-history for readability? preserve exact:
  // original: eval-history ends with </div>\n\n        <div page-extensions...
  // after split: eval-history ends with </div>\n, extensions starts with blank?\n        <div...
  // For exact rebuild, the blank line between pages must remain somewhere.
  // Put blank line at start of extensions file to preserve order.
  const extChunk = evalLines.slice(extStart);
  // Ensure first line of ext is the blank if we included it
  writeLines(evalHistPath, before, nl);
  writeLines(path.join(pagesDir, 'extensions.html'), extChunk, nl);
  console.log(`Extracted extensions: ${extChunk.length} lines from eval-history`);
}

// ── 2) Split body-tail ────────────────────────────────────────────────────
const bodyTailPath = path.join(partials, 'body-tail.html');
if (!fs.existsSync(bodyTailPath)) {
  console.error('body-tail.html missing — already split?');
  process.exit(1);
}

const { lines: bt } = readLines(bodyTailPath);
console.log(`body-tail: ${bt.length} lines`);

// Markers: top-level modal starts and script blocks
// Structure of body-tail:
// L1-2: closing divs (workspace-shell / app)
// L3: blank
// then modals with <!-- comments -->
// i18n scripts mid-file
// more modals
// classic scripts at end

const blocks = [];
// shell close: first non-empty structural closings until first modal/comment about modal
let i = 0;
// collect leading blank + closing divs
const shellClose = [];
while (i < bt.length) {
  const t = bt[i].trim();
  if (t === '' || t === '</div>') {
    shellClose.push(bt[i]);
    i++;
    continue;
  }
  break;
}
// keep trailing blank of shellClose as separator if next is comment
blocks.push({ name: 'shell-close', file: 'partials/shell-close.html', lines: shellClose });

// Now parse remaining into modal/script chunks
// Strategy: walk lines; when we see a top-level modal open or script or comment that starts a section, cut

function isTopLevelModalOpen(line) {
  // top-level modals in body-tail are indented with 2 spaces typically: "  <div id=... modal-overlay"
  // or "        <div id=\"extension-..." (more indent for extension ones)
  // or "<!-- CPA 部署"
  return /class="[^"]*modal-overlay/.test(line) && /<div\b/.test(line);
}

function isScriptLine(line) {
  return /<script\s+src=/.test(line);
}

function isSectionComment(line) {
  return /^\s*<!--/.test(line) && !/^\s*<!--\s*@include/.test(line);
}

// Remaining content from i
const rest = bt.slice(i);

// Find all cut points: section comments that precede modals, or modal opens without comment, or script groups
// Simpler approach: identify contiguous top-level blocks by tracking div depth from known modal roots.

// Manual named ranges by scanning for known modal ids and script groups
const modalIds = [
  'eval-check-modal',
  'custom-alert-modal',
  'kite-plugin-modal',
  'custom-confirm-modal',
  'cpa-version-modal',
  'proxy-route-editor-modal',
  'proxy-route-backup-picker-modal',
  'notification-center-modal',
  'log-viewer-modal',
  'onboarding-guide-modal',
  'ide-restart-modal',
  'update-jump-modal',
  'updater-prompt-modal',
  'extension-settings-modal',
  'extension-detail-modal',
  'cpa-deploy-modal',
];

// Find start index of each modal in rest (absolute in bt = i + local)
const modalStarts = [];
for (let li = 0; li < rest.length; li++) {
  for (const id of modalIds) {
    if (rest[li].includes(`id="${id}"`) && rest[li].includes('modal-overlay')) {
      // include preceding comment + blank lines that belong to this modal
      let start = li;
      // walk back over blanks and a single HTML comment block
      let j = li - 1;
      while (j >= 0 && rest[j].trim() === '') j--;
      if (j >= 0 && isSectionComment(rest[j])) {
        // include comment and any blanks between comment and modal
        start = j;
        // also include blank line before comment if any (except at very start handled by shell)
        if (start > 0 && rest[start - 1].trim() === '') start = start - 1;
      } else if (li > 0 && rest[li - 1].trim() === '') {
        start = li - 1;
      }
      modalStarts.push({ id, localStart: start, openLocal: li });
      break;
    }
  }
}

// scripts: i18n group and classic group
const scriptStarts = [];
for (let li = 0; li < rest.length; li++) {
  if (isScriptLine(rest[li])) {
    // start of a script run
    if (scriptStarts.length === 0 || scriptStarts[scriptStarts.length - 1].endLocal < li) {
      // find continuous script block (allow blanks between scripts)
      let s = li;
      if (s > 0 && rest[s - 1].trim() === '') s = s - 1;
      let e = li;
      while (e + 1 < rest.length && (isScriptLine(rest[e + 1]) || rest[e + 1].trim() === '')) {
        e++;
      }
      // trim trailing blanks from end into next section? keep blanks that are between scripts only
      while (e > li && rest[e].trim() === '') e--;
      scriptStarts.push({
        name: rest[li].includes('i18n') ? 'scripts-i18n' : 'scripts-app',
        localStart: s,
        endLocal: e,
      });
      li = e;
    }
  }
}

console.log('Modals found:', modalStarts.map((m) => m.id).join(', '));
console.log('Script blocks:', scriptStarts.map((s) => `${s.name}@${s.localStart + 1}-${s.endLocal + 1}`).join(', '));

// Build ordered segments covering all of rest without gaps
const events = [];
for (const m of modalStarts) {
  events.push({ type: 'modal', id: m.id, start: m.localStart });
}
for (const s of scriptStarts) {
  events.push({ type: 'scripts', id: s.name, start: s.localStart, end: s.endLocal });
}
events.sort((a, b) => a.start - b.start);

// Deduce end of each event as start of next - 1, or EOF
const segments = [];
for (let ei = 0; ei < events.length; ei++) {
  const ev = events[ei];
  const nextStart = ei + 1 < events.length ? events[ei + 1].start : rest.length;
  let end = nextStart - 1;
  // for scripts with known end, use max(end, known)
  if (ev.type === 'scripts' && typeof ev.end === 'number') {
    // end is at least script end; trailing blanks until next belong to... next's leading blank
    // To avoid double-counting blanks: segment is [start, nextStart-1]
    end = nextStart - 1;
  }
  const chunk = rest.slice(ev.start, end + 1);
  segments.push({ type: ev.type, id: ev.id, start: ev.start, end, chunk });
}

// Verify full coverage
let covered = new Array(rest.length).fill(false);
for (const seg of segments) {
  for (let k = seg.start; k <= seg.end; k++) covered[k] = true;
}
const gaps = [];
for (let k = 0; k < covered.length; k++) if (!covered[k]) gaps.push(k);
if (gaps.length) {
  console.warn('Uncovered lines in body-tail rest:', gaps.slice(0, 20).map((g) => g + 1));
  // dump gap content
  for (const g of gaps.slice(0, 10)) console.warn(' ', g + 1, rest[g].slice(0, 80));
}

// Write modal files
fs.mkdirSync(modalsDir, { recursive: true });
const includeOrder = [];

// shell-close already in blocks
includeOrder.push('partials/shell-close.html');
writeLines(path.join(srcRoot, 'partials/shell-close.html'), shellClose, nl);

for (const seg of segments) {
  if (seg.type === 'modal') {
    const rel = `partials/modals/${seg.id}.html`;
    writeLines(path.join(srcRoot, rel), seg.chunk, nl);
    includeOrder.push(rel);
    console.log(`  wrote ${rel} (${seg.chunk.length} lines)`);
  } else {
    const rel = `partials/${seg.id}.html`;
    writeLines(path.join(srcRoot, rel), seg.chunk, nl);
    includeOrder.push(rel);
    console.log(`  wrote ${rel} (${seg.chunk.length} lines)`);
  }
}

// Update shell index.html includes
const shellPath = path.join(srcRoot, 'index.html');
const { lines: shellLines } = readLines(shellPath);

// Insert extensions include after eval-history if missing
const newShell = [];
let sawEvalHistory = false;
let sawExtensions = false;
let sawBodyTail = false;
for (const line of shellLines) {
  if (line.includes('partials/pages/extensions.html')) sawExtensions = true;
  if (line.includes('partials/body-tail.html')) {
    sawBodyTail = true;
    // replace body-tail with expanded includes
    if (!sawExtensions && sawEvalHistory) {
      newShell.push('    <!-- @include partials/pages/extensions.html -->');
      sawExtensions = true;
    }
    for (const rel of includeOrder) {
      newShell.push(`    <!-- @include ${rel} -->`);
    }
    continue;
  }
  if (line.includes('partials/pages/eval-history.html')) {
    sawEvalHistory = true;
    newShell.push(line);
    // if next lines don't have extensions, we'll add after body-tail replacement or here
    continue;
  }
  newShell.push(line);
}

// If eval-history was seen and extensions not yet added before body-tail replacement
if (sawEvalHistory && !sawExtensions) {
  // find eval-history line and insert after
  const idx = newShell.findIndex((l) => l.includes('partials/pages/eval-history.html'));
  if (idx >= 0) {
    newShell.splice(idx + 1, 0, '    <!-- @include partials/pages/extensions.html -->');
  }
}

writeLines(shellPath, newShell, nl);
console.log('Updated ui-src/index.html includes');

// Remove body-tail.html (now fully split)
fs.unlinkSync(bodyTailPath);
console.log('Removed partials/body-tail.html');

// Update manifest lightly
const manifestPath = path.join(srcRoot, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  man.bodyTail = { split: true, includes: includeOrder };
  man.extensionsExtracted = true;
  fs.writeFileSync(manifestPath, JSON.stringify(man, null, 2) + nl, 'utf8');
}

console.log('\nDone. Run: node scripts/build-ui.mjs --compare-baseline');
