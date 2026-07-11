/**
 * Build ui/index.html from ui-src by expanding <!-- @include path --> directives.
 * Assets stay in ui/assets (not copied). Only index.html is generated.
 *
 *   npm run build:ui
 *   npm run build:ui:watch
 *   node scripts/build-ui.mjs --check
 *   node scripts/build-ui.mjs --compare-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'ui-src');
const outFile = path.join(root, 'ui', 'index.html');
const srcEntry = path.join(srcRoot, 'index.html');

const INCLUDE_RE = /<!--\s*@include\s+([^\s]+)\s*-->/;

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Expand includes line-by-line. Include paths are relative to ui-src/.
 */
function expandFile(filePath, stack = []) {
  const resolved = path.resolve(filePath);
  if (stack.includes(resolved)) {
    throw new Error(`Circular @include: ${[...stack, resolved].join(' -> ')}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`@include not found: ${resolved}`);
  }

  const text = readText(resolved);
  let lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const out = [];
  for (const line of lines) {
    const m = line.match(INCLUDE_RE);
    if (!m) {
      out.push(line);
      continue;
    }
    const rel = m[1].replace(/\\/g, '/');
    const incPath = path.join(srcRoot, rel);
    const expanded = expandFile(incPath, [...stack, resolved]);
    out.push(...expanded);
  }
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeForCompare(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildOnce({ quiet = false } = {}) {
  if (!fs.existsSync(srcEntry)) {
    throw new Error('Missing ui-src/index.html');
  }

  const lines = expandFile(srcEntry);
  const shellText = readText(srcEntry);
  const nl = detectNewline(shellText);
  const output = lines.join(nl) + nl;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output, 'utf8');
  if (!quiet) {
    console.log(`Built ${path.relative(root, outFile)} (${lines.length} lines)`);
    console.log(`sha256: ${sha256(Buffer.from(output, 'utf8'))}`);
  }
  return output;
}

function checkUpToDate() {
  if (!fs.existsSync(outFile)) {
    console.error('ui/index.html missing');
    process.exit(1);
  }
  const lines = expandFile(srcEntry);
  const shellText = readText(srcEntry);
  const nl = detectNewline(shellText);
  const output = lines.join(nl) + nl;
  const existing = readText(outFile);
  if (normalizeForCompare(existing) !== normalizeForCompare(output)) {
    console.error('UI build is stale: ui/index.html does not match ui-src. Run: npm run build:ui');
    process.exit(1);
  }
  console.log('UI build check passed (ui/index.html is up to date).');
}

function compareBaseline(output) {
  const baselinePath = path.join(root, 'ui', 'index.html.baseline');
  if (!fs.existsSync(baselinePath)) {
    console.error('No baseline at ui/index.html.baseline');
    process.exit(1);
  }
  const base = readText(baselinePath);
  const a = normalizeForCompare(base);
  const b = normalizeForCompare(output);
  if (a === b) {
    console.log('Baseline compare: EXACT MATCH (normalized newlines)');
    return;
  }
  const al = a.split('\n');
  const bl = b.split('\n');
  const max = Math.max(al.length, bl.length);
  let first = -1;
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) {
      first = i;
      break;
    }
  }
  console.error(`Baseline compare: MISMATCH at line ${first + 1}`);
  console.error(`  baseline(${al.length}): ${(al[first] || '').slice(0, 120)}`);
  console.error(`  built   (${bl.length}): ${(bl[first] || '').slice(0, 120)}`);
  process.exit(1);
}

function watch() {
  buildOnce();
  console.log('Watching ui-src/ for changes...');
  let timer = null;
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        buildOnce({ quiet: false });
      } catch (err) {
        console.error(err.message || err);
      }
    }, 80);
  };
  fs.watch(srcRoot, { recursive: true }, rebuild);
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const compare = process.argv.includes('--compare-baseline');
  const watchMode = process.argv.includes('--watch');

  try {
    if (checkOnly) {
      checkUpToDate();
      return;
    }
    if (watchMode) {
      watch();
      return;
    }
    const output = buildOnce();
    if (compare) compareBaseline(output);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
