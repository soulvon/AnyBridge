import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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

const indexHtml = readFileSync('ui/index.html', 'utf8');
const scriptTags = scriptFiles.map(file => `<script src="./${file.replace('ui/', '')}"></script>`);
assertContainsInOrder(indexHtml, scriptTags, 'index.html script list');

const appCss = readFileSync('ui/assets/app.css', 'utf8');
const cssImports = styleFiles.map(file => `@import url('./styles/${file.split('/').pop()}');`);
assertContainsInOrder(appCss, cssImports, 'app.css import list');

for (const file of scriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) fail(`syntax error in ${file}`);
}

console.log(`UI check passed (${scriptFiles.length} scripts, ${styleFiles.length} styles).`);
