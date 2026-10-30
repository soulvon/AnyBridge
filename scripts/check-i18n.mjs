// ═══════════════════════════════════════════════════════════════════
// i18n 门控：保证「界面翻译完整 + 字典干净 + 中英不夹注 + 债不增长」
//
// 正向（中文 → 英文）
//   1) 漏翻检测   —— ui-src 所有 HTML 的中文文本节点 / title / placeholder /
//                    aria-label / alt 必须能在 en-US 字典找到（中文原文即 key）
//   2) 未翻检测   —— en-US 字典 value 不允许残留中文（语言名称白名单除外）
//   3) 占位符一致 —— key 与 value 的 {placeholder} 集合必须一致
//   4) 空值检测   —— value 不允许为空
//
// 反向（英文 → 该不该出现）
//   5) 纯英文准入 —— 不含中文的界面文本必须精确命中 keep-en.txt（含 re: 正则）
//   6) 全大写禁令 —— BASIC / OPTIONAL 这类全大写英文标签直接失败
//   7) 夹注禁令   —— 「中文 (English)」括号夹注只允许快捷键 / 文件名 / 示例值
//
// 终态与债务
//   8) 契约校验   —— Rust 侧用户可见主句必须收录进字典
//   9) 文档双语   —— README.md 必须包含英文说明区
//  10) JS 债务基线 —— ui/assets/scripts 里的中文字符串数量只许减少，不许增加
//                     （--update-baseline 在确实降低后重写基线）
//
// 任何一项失败即 exit 1，接入 npm run check:fast + 打包前 build:desktop。
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const failures = [];
const warns = [];
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const fail = (msg) => failures.push(msg);

// ── 加载字典 ──
function loadDict(file) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window });
  return window.ByokI18nCatalog?.['en-US']?.translations || {};
}
const DICT_FILE = 'ui/assets/i18n/en-US.js';
const dict = loadDict(DICT_FILE);
const keys = new Set(Object.keys(dict));

// ── 加载纯英文白名单 ──
const KEEP_EN_FILE = 'ui/assets/i18n/keep-en.txt';
function loadKeepEn(file) {
  const exact = new Set();
  const patterns = [];
  if (!fs.existsSync(file)) return { exact, patterns };
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('re:')) {
      try { patterns.push(new RegExp(line.slice(3))); }
      catch (e) { fail(`白名单正则有误: ${line} → ${e.message}`); }
    } else exact.add(line);
  }
  return { exact, patterns };
}
const keepEn = loadKeepEn(KEEP_EN_FILE);

function allowedEnglish(text) {
  if (keepEn.exact.has(text)) return true;
  return keepEn.patterns.some((re) => re.test(text));
}

// ═══════════════════════════════════════════════════════════════════
// 2) 未翻检测：value 残留中文
// ═══════════════════════════════════════════════════════════════════
const VALUE_CJK_WHITELIST = new Set(['zh-CN']);
for (const [k, v] of Object.entries(dict)) {
  if (typeof v !== 'string' || !v.trim()) { fail(`空翻译: '${k}' → ''`); continue; }
  if (VALUE_CJK_WHITELIST.has(k)) continue;
  if (CJK.test(v)) fail(`疑似未翻译（value 仍含中文）: '${k}' → '${v}'`);
}

// ═══════════════════════════════════════════════════════════════════
// 3) 占位符一致性
// ═══════════════════════════════════════════════════════════════════
const PH = /\{(\w+)\}/g;
const placeholdersOf = (s) => new Set([...String(s).matchAll(PH)].map((m) => m[1]));
for (const [k, v] of Object.entries(dict)) {
  const kp = placeholdersOf(k);
  const vp = placeholdersOf(v);
  for (const p of kp) if (!vp.has(p)) fail(`占位符丢失: '${k}' 缺 {${p}}`);
  for (const p of vp) if (!kp.has(p)) fail(`多余占位符: '${k}' 多出 {${p}}`);
}

// ═══════════════════════════════════════════════════════════════════
// 采集 HTML 文本节点与属性（保留行号；剥 script/style/注释）
// ═══════════════════════════════════════════════════════════════════
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
const htmlFiles = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.html')) htmlFiles.push(p.replace(/\\/g, '/'));
  }
})('ui-src');

/** 等长空白替换：保持行号不变 */
const blank = (m) => m.replace(/[^\n]/g, ' ');

/** @returns {{kind:'text'|'attr', attr?:string, text:string, line:number}[]} */
function collectItems(file) {
  let html = fs.readFileSync(file, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, blank)
    .replace(/<style[\s\S]*?<\/style>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
  const items = [];
  const lines = html.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/>([^<>]+)</g)) {
      const text = decodeEntities(m[1]).trim();
      if (text) items.push({ kind: 'text', text, line: i + 1 });
    }
    for (const attr of ATTRS) {
      const re = new RegExp(`${attr}="([^"]*)"`, 'gi');
      let m;
      while ((m = re.exec(line))) {
        const text = decodeEntities(m[1]).trim();
        if (text) items.push({ kind: 'attr', attr, text, line: i + 1 });
      }
    }
  });
  return items;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&times;/g, 'x');
}

const inventory = htmlFiles.map((f) => ({ file: f, items: collectItems(f) }));

// ═══════════════════════════════════════════════════════════════════
// 1) 漏翻检测：中文文本必须在字典里
// ═══════════════════════════════════════════════════════════════════
const missing = new Map();
function addMissing(where, text) {
  const list = missing.get(where) || [];
  list.push(text);
  missing.set(where, list);
}
let cjkCount = 0;
for (const { file, items } of inventory) {
  for (const it of items) {
    if (!CJK.test(it.text)) continue;
    cjkCount++;
    if (!keys.has(it.text)) {
      addMissing(`${file} · ${it.kind === 'attr' ? it.attr : 'text'}`, it.text);
    }
  }
}
if (missing.size) {
  let count = 0;
  for (const [where, list] of missing) {
    const uniq = [...new Set(list)];
    count += uniq.length;
    console.log(`  ${where}（${uniq.length} 条）`);
    uniq.slice(0, 10).forEach((t) => console.log(`    '${t.slice(0, 80)}'`));
    if (uniq.length > 10) console.log(`    … 其余 ${uniq.length - 10} 条`);
  }
  fail(`i18n 漏翻 ${count} 条（把以上中文作为 key 补进 ${DICT_FILE}）`);
}

// ═══════════════════════════════════════════════════════════════════
// 5)/6)/7) 反向检查：纯英文准入 + 全大写禁令 + 夹注禁令
// ═══════════════════════════════════════════════════════════════════
const ALL_CAPS = /^[A-Z][A-Z0-9 _&/.\-]{2,}$/;
const ATTRIBUTION = /([\u4e00-\u9fff][^<>]{0,20})[（(]\s*([A-Za-z][A-Za-z0-9 /+.\-]{1,30})\s*[)）]/g;
const KEY_HINT = /^(Esc|Enter|Tab|Ctrl|Shift|Alt|Space)$/;
const FILE_HINT = /\.(json|toml|yaml|yml|md|js|ts|exe|dmg|msi|deb|AppImage)$/i;

const enNotAllowed = [];
const allCapsHits = [];
const attributionHits = [];

for (const { file, items } of inventory) {
  for (const it of items) {
    const { text, line } = it;
    if (CJK.test(text)) {
      // 7) 中文 + 括号英文夹注
      ATTRIBUTION.lastIndex = 0;
      let m;
      while ((m = ATTRIBUTION.exec(text))) {
        const inner = m[2].trim();
        if (KEY_HINT.test(inner)) continue;      // 快捷键
        if (FILE_HINT.test(inner)) continue;     // 文件名
        if (allowedEnglish(inner)) continue;     // 示例值 / 品牌 / 字段名
        attributionHits.push(`${file}:${line}  ${m[0].trim()}`);
      }
      continue;
    }
    // 仅含单个字母、纯符号、纯数字的忽略
    if (!/[A-Za-z]{2,}/.test(text)) continue;
    // 6) 全大写禁令
    if (ALL_CAPS.test(text) && !allowedEnglish(text)) {
      allCapsHits.push(`${file}:${line}  ${text}`);
    }
    // 5) 纯英文准入
    if (!allowedEnglish(text)) {
      const where = it.kind === 'attr' ? `@${it.attr}` : 'text';
      enNotAllowed.push(`${file}:${line}  ${where}  ${text.slice(0, 70)}`);
    }
  }
}

if (allCapsHits.length) {
  console.log('\n■ 全大写英文标签（禁止）');
  allCapsHits.slice(0, 20).forEach((s) => console.log('  ' + s));
  fail(`全大写英文标签 ${allCapsHits.length} 处（改成中文，或确认后加进 ${KEEP_EN_FILE}）`);
}

if (attributionHits.length) {
  console.log('\n■ 中英括号夹注（禁止）');
  attributionHits.slice(0, 20).forEach((s) => console.log('  ' + s));
  fail(`括号夹注 ${attributionHits.length} 处（英文挪进说明文字，或加进 ${KEEP_EN_FILE}）`);
}

if (enNotAllowed.length) {
  console.log('\n■ 未准入的纯英文界面文本');
  enNotAllowed.slice(0, 40).forEach((s) => console.log('  ' + s));
  if (enNotAllowed.length > 40) console.log(`  … 其余 ${enNotAllowed.length - 40} 处`);
  fail(`未准入纯英文 ${enNotAllowed.length} 处（改中文，或确认后加进 ${KEEP_EN_FILE}）`);
}

// ═══════════════════════════════════════════════════════════════════
// 8) 契约校验：Rust 侧用户可见主句必须收录进字典
// ═══════════════════════════════════════════════════════════════════
{
  const rustFile = 'src-tauri/src/commands/codex_desktop.rs';
  if (fs.existsSync(rustFile)) {
    const src = fs.readFileSync(rustFile, 'utf8');
    const re = /const\s+MSG_[A-Z_]+:\s*&str\s*=\s*"([^"]+)"/g;
    let m;
    let found = 0;
    while ((m = re.exec(src))) {
      found += 1;
      if (!keys.has(m[1])) {
        fail(`后端用户可见主句缺英文翻译: '${m[1]}'（补进 ${DICT_FILE}，${rustFile}）`);
      }
    }
    if (found === 0) fail(`未解析到 ${rustFile} 的 MSG_* 主句常量：契约检查已失效`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 9) 文档双语
// ═══════════════════════════════════════════════════════════════════
if (fs.existsSync('README.md')) {
  const md = fs.readFileSync('README.md', 'utf8');
  const hasEnglish = /##\s*(English|English Version)|English Version|README\.en\.md|README_EN/i.test(md)
    || fs.existsSync('README.en.md') || fs.existsSync('README_EN.md');
  if (!hasEnglish) fail('README.md 缺少英文说明区（添加 "## English Version" 段落或 README_EN.md）');
} else {
  warns.push('README.md 不存在（跳过文档双语检查）');
}

// ═══════════════════════════════════════════════════════════════════
// 10) JS 中文字符串债务基线：只许减少
// ═══════════════════════════════════════════════════════════════════
const JS_DIR = 'ui/assets/scripts';
const BASELINE_FILE = 'ui/assets/i18n/js-cjk-baseline.json';
const STRING_RE = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;

function scanJsCjk() {
  const counts = {};
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) files.push(p);
    }
  })(JS_DIR);
  let total = 0;
  let translated = 0;
  for (const f of files) {
    // key 用相对 JS_DIR 的路径，避免子目录同名文件互相覆盖
    const name = path.relative(JS_DIR, f).replace(/\\/g, '/');
    let n = 0;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      STRING_RE.lastIndex = 0;
      let m;
      while ((m = STRING_RE.exec(line))) {
        if (!CJK.test(m[2])) continue;
        n++;
        // 「字面量正好命中字典 key」= 该动态文案已具备英文译文
        if (keys.has(m[2])) translated++;
      }
    }
    if (n) counts[name] = n;
    total += n;
  }
  return { counts, total, translated };
}

const jsScan = scanJsCjk();
const jsCounts = jsScan.counts;
const jsTotal = jsScan.total;
const jsTranslated = jsScan.translated;

if (UPDATE_BASELINE) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({
    _doc: 'JS 中文字符串字面量基线。只许下降。修复后用 node scripts/check-i18n.mjs --update-baseline 重写。',
    total: jsTotal,
    files: jsCounts
  }, null, 2) + '\n', 'utf8');
  console.log(`\n✅ JS 中文债基线已更新：${jsTotal} 条 / ${Object.keys(jsCounts).length} 个文件`);
} else if (fs.existsSync(BASELINE_FILE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const grown = [];
  for (const [name, n] of Object.entries(jsCounts)) {
    const allowed = base.files?.[name] ?? 0;
    if (n > allowed) grown.push(`${name}  ${allowed} → ${n}（+${n - allowed}）`);
  }
  if (grown.length) {
    console.log('\n■ JS 中文文案超出基线');
    grown.forEach((s) => console.log('  ' + s));
    fail(`JS 中文文案增长（${base.total} → ${jsTotal}）。新文案请走 t() 并补 ${DICT_FILE}`);
  }
  const pct = jsTotal ? ((jsTranslated / jsTotal) * 100).toFixed(1) : '100.0';
  console.log(`ℹ JS 动态文案：${jsTotal} 条中文字面量，其中 ${jsTranslated} 条有英文译文（${pct}%），基线 ${base.total}`);
  if (jsTotal < base.total) {
    warns.push(`JS 中文债已下降 ${base.total} → ${jsTotal}，可运行 node scripts/check-i18n.mjs --update-baseline 收紧基线`);
  }
} else {
  warns.push(`${BASELINE_FILE} 不存在，跳过 JS 债基线检查`);
}

// ═══════════════════════════════════════════════════════════════════
// 输出
// ═══════════════════════════════════════════════════════════════════
if (!missing.size) {
  console.log(`✅ 正向覆盖：HTML 中文词条 ${cjkCount} 条全部命中字典（${keys.size} keys）`);
}
if (!allCapsHits.length && !attributionHits.length && !enNotAllowed.length) {
  console.log(`✅ 反向准入：纯英文界面文本全部在 ${KEEP_EN_FILE} 白名单内`);
}
if (warns.length) warns.forEach((w) => console.log(`ℹ ${w}`));
if (failures.length) {
  console.error(`\n❌ i18n 门控失败（${failures.length} 项）：`);
  failures.slice(0, 30).forEach((f) => console.error('  - ' + f));
  if (failures.length > 30) console.error(`  … 其余 ${failures.length - 30} 项`);
  process.exit(1);
}
console.log('✅ i18n 门控全部通过');
