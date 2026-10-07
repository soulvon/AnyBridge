// 文档站首页静态校验：标签平衡、锚点、重复 id、图片引用与 SEO 元信息
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'docs', 'index.html');
const s = fs.readFileSync(file, 'utf8');
const problems = [];

const tags = ['html', 'head', 'body', 'main', 'section', 'article', 'div', 'figure', 'header', 'footer', 'nav', 'script', 'style', 'ul', 'ol', 'li', 'p', 'h1', 'h2', 'h3'];
for (const t of tags) {
  const open = (s.match(new RegExp('<' + t + '[\\s>]', 'g')) || []).length;
  const close = (s.match(new RegExp('</' + t + '>', 'g')) || []).length;
  if (open !== close) problems.push(`标签不平衡 <${t}>: 开 ${open} / 闭 ${close}`);
}

const ids = [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
if (dup.length) problems.push(`重复 id: ${dup.join(', ')}`);

const anchors = [...s.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const broken = [...new Set(anchors)].filter((a) => !ids.includes(a));
if (broken.length) problems.push(`锚点缺失目标: ${broken.join(', ')}`);

const imgs = [...s.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
const missing = imgs.filter((p) => !fs.existsSync(path.resolve(__dirname, '..', 'docs', p)));
if (missing.length) problems.push(`图片缺失: ${missing.join(', ')}`);
const noAlt = [...s.matchAll(/<img\s+src="[^"]+"(?![^>]*\balt=)[^>]*>/g)];
if (noAlt.length) problems.push(`缺少 alt 的图片: ${noAlt.length}`);

const need = [
  ['title', /<title>.+<\/title>/],
  ['description', /name="description"/],
  ['keywords', /name="keywords"/],
  ['canonical', /rel="canonical"/],
  ['og:title', /property="og:title"/],
  ['og:image', /property="og:image"/],
  ['twitter:card', /name="twitter:card"/],
  ['JSON-LD', /application\/ld\+json/],
];
for (const [label, re] of need) {
  if (!re.test(s)) problems.push(`缺少 SEO 元信息: ${label}`);
}

const h1 = (s.match(/<h1[\s>]/g) || []).length;
if (h1 !== 1) problems.push(`h1 数量应为 1，实际 ${h1}`);

console.log('图片引用:', imgs.length);
console.log('标题:', (s.match(/<title>(.*?)<\/title>/) || [])[1]);
console.log('h2 数量:', (s.match(/<h2[\s>]/g) || []).length);
console.log('文件字符数:', s.length);
if (problems.length) {
  console.log('\n发现问题:');
  problems.forEach((p) => console.log(' - ' + p));
  process.exit(1);
}
console.log('\n文档站首页校验通过');
