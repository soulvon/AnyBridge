import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const scriptFiles = [
  'ui/assets/i18n/zh-CN.js',
  'ui/assets/i18n/en-US.js',
  'ui/assets/i18n/i18n.js',
  'ui/assets/scripts/00-bridge.js',
  'ui/assets/scripts/10-shell.js',
  'ui/assets/scripts/20-runtime.js',
  'ui/assets/scripts/30-providers-eval.js',
  'ui/assets/scripts/40-model-picker.js',
  'ui/assets/scripts/50-model-map.js',
  'ui/assets/scripts/52-proxy-routes.js',
  'ui/assets/scripts/55-platforms.js',
  'ui/assets/scripts/65-extensions.js',
  'ui/assets/scripts/60-updater.js',
  'ui/assets/scripts/70-healthcheck.js',
  'ui/assets/scripts/90-init.js',
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

// 1) ui-src must exist and build must be up to date
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
const scriptTags = scriptFiles.map((file) => `<script src="./${file.replace('ui/', '')}"></script>`);
assertContainsInOrder(indexHtml, scriptTags, 'index.html script list');

for (const id of requiredPageIds) {
  if (!indexHtml.includes(`id="${id}"`)) fail(`index.html missing #${id}`);
}

const appCss = readFileSync('ui/assets/app.css', 'utf8');
const cssImports = styleFiles.map((file) => `@import url('./styles/${file.split('/').pop()}');`);
assertContainsInOrder(appCss, cssImports, 'app.css import list');

for (const file of scriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) fail(`syntax error in ${file}`);
}

// Source partials referenced by shell must exist
const shell = readFileSync('ui-src/index.html', 'utf8');
const includeRe = /<!--\s*@include\s+([^\s]+)\s*-->/g;
let m;
while ((m = includeRe.exec(shell)) !== null) {
  const rel = m[1].replace(/\\/g, '/');
  const full = path.join('ui-src', rel);
  if (!existsSync(full)) fail(`@include missing file: ${full}`);
}

console.log(
  `UI check passed (${scriptFiles.length} scripts, ${styleFiles.length} styles, ${requiredPageIds.length} pages).`,
);
