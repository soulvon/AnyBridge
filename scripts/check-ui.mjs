import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const i18nFiles = [
  'ui/assets/i18n/zh-CN.js',
  'ui/assets/i18n/en-US.js',
  'ui/assets/i18n/i18n.js',
];

// P4 shared layers + feature modules (main.js import order)
const moduleImportOrder = [
  'api/bridge.js',
  'ui/dom.js',
  'ui/feedback.js',
  'state/logs.js',
  '05-actions.js',
  '10-shell.js',
  '20-runtime.js',
  '30-providers-eval.js',
  '40-model-picker.js',
  '50-model-map.js',
  '52-proxy-routes.js',
  '55-platforms.js',
  '65-extensions.js',
  '60-updater.js',
  '70-healthcheck.js',
  '90-init.js',
];

const moduleFiles = [
  'ui/assets/scripts/main.js',
  'ui/assets/scripts/00-bridge.js',
  ...moduleImportOrder.map((f) => `ui/assets/scripts/${f}`),
];

const styleFiles = [
  'ui/assets/styles/00-foundation.css',
  'ui/assets/styles/10-shell.css',
  'ui/assets/styles/20-providers-models.css',
  'ui/assets/styles/30-pages.css',
  'ui/assets/styles/40-modals.css',
  'ui/assets/styles/50-platforms.css',
];

const requiredPageIds = [
  'page-platform-proxy',
  'page-providers',
  'page-provider-editor',
  'page-slot-editor',
  'page-model-slots',
  'page-models',
  'page-eval',
  'page-eval-history',
  'page-extensions',
  'page-proxy',
  'page-more-platforms',
  'page-platform-cursor',
  'page-platform-claude-code',
  'page-platform-codex',
  'page-platform-codebuddy',
  'page-platform-codebuddy-add',
  'page-platform-opencode',
  'page-platform-zcode',
  'page-platform-zcode-add',
  'page-platform-workbuddy',
  'page-platform-workbuddy-add',
  'page-settings',
];

function fail(message) {
  console.error(`UI check failed: ${message}`);
  process.exit(1);
}

function assertContainsInOrder(source, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    if (next < 0) fail(`${label} is missing ${needle}`);
    if (next < cursor) fail(`${label} has ${needle} out of order`);
    cursor = next;
  }
}

if (!existsSync('ui-src/index.html')) {
  fail('ui-src/index.html missing — HTML source of truth is ui-src/');
}

const buildCheck = spawnSync(process.execPath, ['scripts/build-ui.mjs', '--check'], {
  encoding: 'utf8',
});
if (buildCheck.status !== 0) {
  const msg = (buildCheck.stderr || buildCheck.stdout || '').trim();
  fail(msg || 'ui build is stale (run npm run build:ui)');
}

const indexHtml = readFileSync('ui/index.html', 'utf8');

const i18nTags = i18nFiles.map((file) => `<script src="./${file.replace('ui/', '')}"></script>`);
assertContainsInOrder(indexHtml, i18nTags, 'index.html i18n script list');

if (!indexHtml.includes('<script type="module" src="./assets/scripts/main.js"></script>')) {
  fail('index.html missing ES module entry <script type="module" src="./assets/scripts/main.js">');
}
if (indexHtml.includes('<script src="./assets/scripts/00-bridge.js"></script>')) {
  fail('index.html still loads classic 00-bridge.js; use main.js module entry only');
}

const mainJs = readFileSync('ui/assets/scripts/main.js', 'utf8');
assertContainsInOrder(
  mainJs,
  moduleImportOrder.map((f) => `import './${f}';`),
  'main.js import order',
);

for (const id of requiredPageIds) {
  if (!indexHtml.includes(`id="${id}"`)) fail(`index.html missing #${id}`);
}

const appCss = readFileSync('ui/assets/app.css', 'utf8');
const cssImports = styleFiles.map((file) => `@import url('./styles/${file.split('/').pop()}');`);
assertContainsInOrder(appCss, cssImports, 'app.css import list');

const allScriptFiles = new Set(moduleFiles);
function walkScripts(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name).replace(/\\/g, '/');
    if (ent.isDirectory()) walkScripts(p);
    else if (ent.name.endsWith('.js')) allScriptFiles.add(p);
  }
}
walkScripts('ui/assets/scripts');

for (const file of [...i18nFiles, ...allScriptFiles]) {
  if (!existsSync(file)) fail(`missing script file ${file}`);
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) fail(`syntax error in ${file}`);
}

const shell = readFileSync('ui-src/index.html', 'utf8');
const includeRe = /<!--\s*@include\s+([^\s]+)\s*-->/g;
let m;
while ((m = includeRe.exec(shell)) !== null) {
  const rel = m[1].replace(/\\/g, '/');
  const full = path.join('ui-src', rel);
  if (!existsSync(full)) fail(`@include missing file: ${full}`);
}

console.log(
  `UI check passed (${allScriptFiles.size} scripts + ${i18nFiles.length} i18n, ${styleFiles.length} styles, ${requiredPageIds.length} pages).`,
);
