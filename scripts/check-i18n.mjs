// ═══════════════════════════════════════════════════════════════════
// i18n 门控：保证「界面翻译完整 + 字典干净 + 文档双语」
//
// 1) 漏翻检测   —— ui-src 所有 HTML 的中文文本节点 / title / placeholder /
//                  aria-label / alt 必须能在 en-US 字典中找到（中文原文即 key）
// 2) 未翻检测   —— en-US 字典的 value 不允许残留中文（语言名称白名单除外）
// 3) 占位符一致 —— key 与 value 的 {placeholder} 集合必须一致
// 4) 空值检测   —— value 不允许为空
// 5) 文档双语   —— README.md 必须包含英文说明区
// 任何一项失败即 exit 1，接入 npm run check:fast。
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const failures = [];
const warns = [];

function fail(msg) { failures.push(msg); }

// ── 加载字典（mock window，避免改文件结构） ──
function loadDict(file) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window });
  return window.ByokI18nCatalog?.['en-US']?.translations || {};
}
const dict = loadDict('ui/assets/i18n/en-US.js');
const keys = new Set(Object.keys(dict));

// ── 2) 未翻检测：value 残留中文 ──
// 白名单：语言自身名称等合理保留中文的词条
const VALUE_CJK_WHITELIST = new Set(['zh-CN']);
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

for (const [k, v] of Object.entries(dict)) {
  if (typeof v !== 'string' || !v.trim()) {
    fail(`空翻译: '${k}' → ''`);
    continue;
  }
  if (VALUE_CJK_WHITELIST.has(k)) continue;
  if (CJK.test(v)) fail(`疑似未翻译（value 仍含中文）: '${k}' → '${v}'`);
}

// ── 3) 占位符一致性 ──
const PH = /\{(\w+)\}/g;
const placeholdersOf = (s) => new Set([...String(s).matchAll(PH)].map(m => m[1]));
for (const [k, v] of Object.entries(dict)) {
  const kp = placeholdersOf(k);
  const vp = placeholdersOf(v);
  for (const p of kp) if (!vp.has(p)) fail(`占位符丢失: '${k}' 缺 {${p}}`);
  for (const p of vp) if (!kp.has(p)) fail(`多余占位符: '${k}' 多出 {${p}}`);
}

// ── 1) 漏翻检测：扫描 ui-src 的 HTML ──
const attrNames = ['title', 'placeholder', 'aria-label', 'alt'];
const htmlFiles = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.html')) htmlFiles.push(p.replace(/\\/g, '/'));
  }
})('ui-src');
// 构建产物 ui/index.html 不扫（内容与 ui-src 重复，改源即生效）

const missing = new Map();
function addMissing(where, text) {
  const list = missing.get(where) || [];
  list.push(text);
  missing.set(where, list);
}

for (const file of htmlFiles) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  // 文本节点（>…< 之间）；同时剥掉所在行的 data-i18n-ignore 容器内容由运行时负责，这里不做 DOM 级解析
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const text = m[1].trim();
    if (text && CJK.test(text) && !keys.has(text)) addMissing(`${file} · text`, text);
  }
  for (const attr of attrNames) {
    const re = new RegExp(`${attr}="([^"]*)"`, 'gi');
    for (const m of html.matchAll(re)) {
      const val = m[1].trim();
      if (val && CJK.test(val) && !keys.has(val)) addMissing(`${file} · ${attr}`, val);
    }
  }
}

if (missing.size) {
  let count = 0;
  console.log('\n■ i18n 漏翻清单（中文原文不在 en-US 字典中）');
  for (const [where, list] of missing) {
    const uniq = [...new Set(list)];
    count += uniq.length;
    console.log(`  ${where}（${uniq.length} 条）`);
    uniq.slice(0, 10).forEach(t => console.log(`    '${t.slice(0, 80)}'`));
    if (uniq.length > 10) console.log(`    … 其余 ${uniq.length - 10} 条`);
  }
  fail(`i18n 漏翻 ${count} 条（把以上中文作为 key 补进 ui/assets/i18n/en-US.js）`);
} else {
  console.log(`✅ i18n 覆盖：HTML 中文词条全部命中字典（${keys.size} keys）`);
}

// ── 5) 文档双语 ──
if (fs.existsSync('README.md')) {
  const md = fs.readFileSync('README.md', 'utf8');
  const hasEnglish = /##\s*(English|English Version)|English Version|README\.en\.md|README_EN/i.test(md)
    || fs.existsSync('README.en.md') || fs.existsSync('README_EN.md');
  if (!hasEnglish) fail('README.md 缺少英文说明区（添加 "## English Version" 段落或 README_EN.md）');
  else console.log('✅ README 双语说明存在');
} else {
  warns.push('README.md 不存在（跳过文档双语检查）');
}

// ── 输出 ──
if (warns.length) warns.forEach(w => console.log(`ℹ ${w}`));
if (failures.length) {
  console.error(`\n❌ i18n 门控失败（${failures.length} 项）：`);
  failures.slice(0, 30).forEach(f => console.error('  - ' + f));
  if (failures.length > 30) console.error(`  … 其余 ${failures.length - 30} 项`);
  process.exit(1);
}
console.log('✅ i18n 门控全部通过');
