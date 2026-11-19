import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function runActionReachability({ root, ok }) {
  const ACTION_RE = /data-action="([A-Za-z0-9_]+)"/g;
  const actionNames = new Set();
  const scan = (dir, exts, cb) => {
    if (!fs.existsSync(dir)) return;
    const walk = (cur, depth) => {
      if (depth > 6) return;
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        if (['node_modules', 'target', '.git', 'tmp'].includes(e.name)) continue;
        const p = path.join(cur, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (exts.some((x) => e.name.endsWith(x))) cb(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(dir, 0);
  };
  scan(path.join(root, 'ui-src'), ['.html'], (s) => {
    for (const m of s.matchAll(ACTION_RE)) actionNames.add(m[1]);
  });
  const builtIndex = path.join(root, 'ui/index.html');
  if (fs.existsSync(builtIndex)) {
    for (const m of fs.readFileSync(builtIndex, 'utf8').matchAll(ACTION_RE)) actionNames.add(m[1]);
  }
  scan(path.join(root, 'ui/assets/scripts'), ['.js'], (s) => {
    const codeOnly = s
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const m of codeOnly.matchAll(ACTION_RE)) actionNames.add(m[1]);
  });

  function collectDynamicPrefixRegistrations(src) {
    const out = new Set();
    // 1. 识别多平台工厂调用点传入的前缀参数，如 createCbIoHandlers('Cb', ...) 或 createManagedModelsPlatform({ prefix: 'Pi', domPrefix: 'pi', ... })
    const cbCallRe = /\bcreateCbIoHandlers\(\s*['"]([A-Za-z0-9_]+)['"]/g;
    const cbPrefixes = [...src.matchAll(cbCallRe)].map((m) => m[1]);
    if (cbPrefixes.length && /function\s+createCbIoHandlers\s*\(/.test(src)) {
      const fnStart = src.indexOf('function createCbIoHandlers(');
      const fnBody = src.slice(fnStart, src.indexOf('\nfunction ', fnStart + 1) > 0 ? src.indexOf('\nfunction ', fnStart + 1) : src.length);
      const dynRe = /(?:bindGlobal|window\[|globalThis\[|g\[)\s*\(?\s*['"]([A-Za-z0-9_]+)['"]\s*\+\s*prefix\s*\+\s*['"]([A-Za-z0-9_]+)['"]/g;
      for (const m of fnBody.matchAll(dynRe)) {
        for (const p of cbPrefixes) out.add(`${m[1]}${p}${m[2]}`);
      }
    }

    const managedCallRe = /\bcreateManagedModelsPlatform\(\s*\{([^}]+)\}\s*\)/g;
    const managedPairs = [];
    for (const m of src.matchAll(managedCallRe)) {
      const body = m[1];
      const prefixMatch = /\bprefix:\s*['"]([A-Za-z0-9_]+)['"]/.exec(body);
      const domPrefixMatch = /\bdomPrefix:\s*['"]([A-Za-z0-9_]+)['"]/.exec(body);
      if (prefixMatch) {
        managedPairs.push({
          prefix: prefixMatch[1],
          domPrefix: domPrefixMatch ? domPrefixMatch[1] : prefixMatch[1].toLowerCase(),
        });
      }
    }
    if (managedPairs.length && /function\s+createManagedModelsPlatform\s*\(/.test(src)) {
      const fnStart = src.indexOf('function createManagedModelsPlatform(');
      const fnEnd = src.indexOf('\n// ═══════', fnStart + 1);
      const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : src.length);
      for (const m of fnBody.matchAll(/\bdefine\(\s*`([^`]+)`/g)) {
        const tpl = m[1];
        if (!tpl.includes('${')) continue;
        for (const pair of managedPairs) {
          const name = tpl.replace(/\$\{prefix\}/g, pair.prefix).replace(/\$\{domPrefix\}/g, pair.domPrefix);
          if (/^[A-Za-z0-9_]+$/.test(name)) out.add(name);
        }
      }
      if (/createCbIoHandlers\(\s*prefix\b/.test(fnBody)) {
        for (const pair of managedPairs) {
          for (const tmpl of ['export{p}Models', 'import{p}Models', 'toggle{p}JsonEditor', 'format{p}Json', 'apply{p}Json']) {
            out.add(tmpl.replace('{p}', pair.prefix));
          }
        }
      }
    }
    return out;
  }

  const reachable = new Set();
  scan(path.join(root, 'ui/assets/scripts'), ['.js'], (s) => {
    for (const m of s.matchAll(/globalThis\.([A-Za-z0-9_]+)\s*=/g)) reachable.add(m[1]);
    for (const m of s.matchAll(/\bwindow\.([A-Za-z0-9_]+)\s*=/g)) reachable.add(m[1]);
    for (const m of s.matchAll(/\bg\.([A-Za-z0-9_]+)\s*=/g)) reachable.add(m[1]);
    for (const m of s.matchAll(/Object\.assign\(\s*globalThis\s*,\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].trim();
        if (/^[A-Za-z0-9_]+$/.test(name)) reachable.add(name);
      }
    }
    for (const dynName of collectDynamicPrefixRegistrations(s)) reachable.add(dynName);
  });

  const KNOWN_MISSING = new Set();

  const missing = [...actionNames].filter((n) => !reachable.has(n));
  const unexpected = missing.filter((n) => !KNOWN_MISSING.has(n)).sort();
  const stale = [...KNOWN_MISSING].filter((n) => !missing.includes(n)).sort();

  ok('未实现白名单已清零（KNOWN_MISSING 必须为 0 项）',
    KNOWN_MISSING.size === 0,
    `当前仍有 ${KNOWN_MISSING.size} 项白名单`);
  ok(`data-action 共 ${actionNames.size} 个，100% 可达（0 缺失）`,
    unexpected.length === 0,
    unexpected.length ? `未实现：${unexpected.slice(0, 6).join(', ')}` : '');
  ok('未实现白名单无过期条目',
    stale.length === 0,
    stale.length ? `${stale.slice(0, 6).join(', ')} → 已实现，请从 KNOWN_MISSING 移除` : '');
}

export function runDynamicLoadingChecks({ root, ok }) {
  const LOADING_WORDS = /(加载|更新|保存|检测|安装|处理|刷新|同步|导入|导出|写入|探测|切换|体检|执行|生成|重装|清理|复制|卸载|拉取|测速|验证|删除|重置)/;
  const STATIC_ASSIGN = /(textContent|innerText)\s*=\s*(['"`])([^'"`]*)\2/;
  const violations = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'target', '.git', 'tmp'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.js')) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
        const m = l.match(STATIC_ASSIGN);
        if (!m) return;
        const text = m[3];
        if (!LOADING_WORDS.test(text)) return;
        if (!/中\s*(…|\.\.\.)?['"`]?\s*$/.test(text)) return;
        violations.push(`${p.replace(root + path.sep, '').split(path.sep).join('/')}:${i + 1}  ${text.slice(0, 40)}`);
      });
    }
  };
  walk(path.join(root, 'ui/assets/scripts'), 0);
  ok('无静态 loading 文案（一律用 loadingHtml / setLoading）',
    violations.length === 0,
    violations.slice(0, 6).join(' | '));

  const handmade = [];
  const walkSpinner = (dir, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'target', '.git', 'tmp'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkSpinner(p, depth + 1); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (/btn-spinner/.test(fs.readFileSync(p, 'utf8'))) {
        handmade.push(p.replace(root + path.sep, '').split(path.sep).join('/'));
      }
    }
  };
  walkSpinner(path.join(root, 'ui/assets/scripts'), 0);
  const fb = fs.readFileSync(path.join(root, 'ui/assets/scripts/ui/feedback.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'ui/assets/styles/00-foundation.css'), 'utf8');
  return {
    handmade,
    feedbackOk: /function loadingHtml/.test(fb) && /g\.loadingHtml\s*=/.test(fb) && /g\.setLoading\s*=/.test(fb),
    spinnerCssOk: /\.ab-spinner\s*\{/.test(css) && /@keyframes ab-spin/.test(css),
  };
}

export function runProviderPresetChecks({ root, ok, warn }) {
  const presetPath = path.join(root, 'ui/assets/provider-presets.json');
  const iconPath = path.join(root, 'ui/assets/scripts/33-provider-icons.js');

  let presets = null;
  try {
    presets = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    ok('预设 JSON 可解析', true);
  } catch (err) {
    ok('预设 JSON 可解析', false, String(err && err.message ? err.message : err));
  }

  let icons = {};
  let iconsLoadable = true;
  try {
    const sandbox = {};
    new Function('globalThis', fs.readFileSync(iconPath, 'utf8'))(sandbox);
    icons = sandbox.PROVIDER_ICON_SVGS || {};
  } catch (err) {
    iconsLoadable = false;
    ok('图标表可执行', false, String(err && err.message ? err.message : err));
  }
  if (iconsLoadable) ok('图标表可执行', true);

  if (presets && Array.isArray(presets.providers)) {
    const providers = presets.providers;
    const groupIds = new Set((presets.groups || []).map((g) => g.id));
    const seenIds = new Set();
    const problems = [];
    for (const p of providers) {
      if (!p.id || !p.name || !p.group || !p.url) {
        problems.push(`字段缺失 ${p.id || '(无 id)'}`);
        continue;
      }
      if (!/^https?:\/\//.test(p.url)) problems.push(`url 非法 ${p.id}`);
      if (!['openai', 'anthropic', 'gemini'].includes(p.format)) problems.push(`format 非法 ${p.id}`);
      if (!groupIds.has(p.group)) problems.push(`分组未声明 ${p.id} → ${p.group}`);
      if (seenIds.has(p.id)) problems.push(`id 重复 ${p.id}`);
      seenIds.add(p.id);
    }
    ok(`预设条目完整（${providers.length} 家 / ${groupIds.size} 组）`, problems.length === 0, problems.slice(0, 6).join('; '));

    const missingIcon = providers
      .filter((p) => p.icon && !icons[p.icon])
      .map((p) => `${p.id} → ${p.icon}`);
    ok('预设引用的图标键都存在', missingIcon.length === 0, missingIcon.slice(0, 6).join(', '));

    const unusedIcons = Object.keys(icons).filter((key) => !providers.some((p) => p.icon === key));
    if (unusedIcons.length > 0) {
      warn(`图标表有 ${unusedIcons.length} 个未被引用`, unusedIcons.slice(0, 8).join(', '));
    }
  } else {
    ok('预设条目完整', false, 'providers 不是数组');
  }

  const badSvg = Object.entries(icons)
    .filter(([, svg]) => {
      if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) return true;
      if (svg.includes('${')) return true;
      if (/(stopColor|strokeWidth|fillRule|clipPath|xmlnsXlink)=/.test(svg)) return true;
      if (/\s(?:fill|stroke|clip-path|id)=url\(/.test(svg)) return true;
      return false;
    })
    .map(([key]) => key);
  ok('图标 SVG 格式合法（无 JSX 残留 / 无裸 url 属性）', badSvg.length === 0, badSvg.slice(0, 6).join(', '));

  const iconBytes = fs.existsSync(iconPath) ? fs.statSync(iconPath).size : 0;
  ok(
    '图标表体积在限度内（< 300KB）',
    iconBytes > 0 && iconBytes < 300 * 1024,
    `${(iconBytes / 1024).toFixed(0)}KB`,
  );
}

export function runCodebaseStructureChecks({ root, ok }) {
  const EXCLUDE_DIRS = new Set(['node_modules', 'target', '_wb_asar_extract', 'vendor', '.git', 'tmp', 'dist', '__pycache__']);
  const CODE_EXT = /\.(rs|js|mjs|cjs|ts|jsx|tsx|py|css|html)$/i;
  const PART_SHARD_RE = /(?:^|[/_-])part[-_]?\d+/i;
  const MAX_LINES = 800;

  let scanned = 0;
  const partShards = [];
  const oversized = [];

  for (const top of ['src-tauri/src', 'cursor-core/src', 'cursor-core/crates', 'cursor-core/tests', 'sidecar', 'ui', 'ui-src', 'scripts']) {
    const startDir = path.join(root, top);
    if (!fs.existsSync(startDir)) continue;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (rel === 'ui/index.html') continue;
        if (rel.startsWith('ui/assets/i18n/')) continue;
        if (/localization-baseline/i.test(entry.name) || entry.name.endsWith('.min.js') || entry.name.endsWith('.min.css')) continue;
        if (!CODE_EXT.test(entry.name)) continue;

        scanned++;
        if (PART_SHARD_RE.test(rel)) partShards.push(rel);
        const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).length;
        if (lines > MAX_LINES) oversized.push({ rel, lines });
      }
    };
    walk(startDir);
  }

  ok('源码与脚本文件均不存在无语义机械编号分片（part-NN）',
    partShards.length === 0,
    partShards.slice(0, 8).join(', ') + (partShards.length > 8 ? ` …共 ${partShards.length} 个` : ''));
  ok(`全库代码文件行数均 <= ${MAX_LINES} 行（已扫描 ${scanned} 个文件）`,
    oversized.length === 0,
    oversized
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 8)
      .map((x) => `${x.rel}(${x.lines}行)`)
      .join(', ') + (oversized.length > 8 ? ` …共 ${oversized.length} 个` : ''));

  runArchAntiRegressionChecks({ root, ok });
}

export function runArchAntiRegressionChecks({ root, ok }) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(root, rel));

  // 1. 57-pb-models.js 不存在且 main.js 无引用
  const mainJs = read('ui/assets/scripts/main.js');
  ok('已物理删除 57-pb-models.js 且 main.js 不再导入',
    !exists('ui/assets/scripts/57-pb-models.js') && !mainJs.includes('57-pb-models'));

  // 2. 前端无 write_provider_store 调用
  const ghostStoreRefs = [];
  const scanUiDir = (dirRel) => {
    const start = path.join(root, dirRel);
    if (!fs.existsSync(start)) return;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'tmp'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|html)$/i.test(entry.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/\bwrite_provider_store\b/.test(src)) {
          ghostStoreRefs.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(start);
  };
  scanUiDir('ui/assets/scripts');
  scanUiDir('ui-src');
  ok('前端零 write_provider_store 幽灵命令调用',
    ghostStoreRefs.length === 0,
    ghostStoreRefs.join(', '));

  // 3. Sidecar 4 个死模块已删 & 生产代码不写 providers.json
  const deadModules = [
    'sidecar/multimodal-middleware.js',
    'sidecar/handlers/web-search.js',
    'sidecar/handlers/completions.js',
    'sidecar/handlers/embeddings.js',
  ];
  const aliveDeadModules = deadModules.filter(exists);
  ok('Sidecar 4 个死模块已彻底删除',
    aliveDeadModules.length === 0,
    aliveDeadModules.join(', '));

  const sidecarProviderWriters = [];
  const scanSidecarProd = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'build', 'tmp'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scanSidecarProd(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/(?:writeFileSync|writeFile|writeJsonAtomic|appendFileSync)\s*\([^;\n]*providers\.json/i.test(codeLines)
        || /(?:writeFileSync|writeFile|writeJsonAtomic)\s*\(\s*(?:providersPath|PROVIDERS_PATH)\b/i.test(codeLines)) {
        sidecarProviderWriters.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  scanSidecarProd(path.join(root, 'sidecar'));
  const poolSrc = read('sidecar/provider-pool.js');
  ok('Sidecar 生产代码绝不写入 providers.json（维持 Rust 单写端）',
    sidecarProviderWriters.length === 0 && !/\bwriteFile(?:Sync)?\b|\bwriteJsonAtomic\b/.test(poolSrc),
    sidecarProviderWriters.join(', '));

  // 4. Rust 不再对 app.asar 裸 fs::write
  const asarRawWrites = [];
  for (const rel of [
    'src-tauri/src/commands/platforms/antigravity_patch.rs',
    'src-tauri/src/commands/antigravity_localization/hub_patch.rs',
  ]) {
    if (!exists(rel)) continue;
    const src = read(rel);
    const prodOnly = src.split(/#\[cfg\(test\)\]/)[0];
    if (/\bfs::write\s*\(/.test(prodOnly)) asarRawWrites.push(rel);
  }
  ok('Rust 不再对 app.asar 使用裸 fs::write（统一走 write_atomic）',
    asarRawWrites.length === 0,
    asarRawWrites.join(', '));

  // 5. platforms/ 生产文件不再保留 #[allow(unused_imports)] prelude
  const platPreludeHits = [];
  const platDir = path.join(root, 'src-tauri/src/commands/platforms');
  const walkPlat = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'tests') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkPlat(full); continue; }
      if (!entry.name.endsWith('.rs')) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      const src = fs.readFileSync(full, 'utf8');
      const prodOnly = src.split(/#\[cfg\(test\)\]/)[0];
      if (/#!?\[allow\(unused_imports\)\]/.test(prodOnly)) platPreludeHits.push(rel);
    }
  };
  walkPlat(platDir);
  ok('platforms/ 生产文件已清理 #[allow(unused_imports)] prelude 块',
    platPreludeHits.length === 0,
    platPreludeHits.join(', '));

  // 6. jsonc_edit 与 field_restore 默认开启
  const jsoncSrc = read('src-tauri/src/commands/jsonc_edit/mod.rs');
  const stashSrc = read('src-tauri/src/commands/agent_stash.rs');
  const jsoncDefaultOn = /fn format_preserving_enabled\(\)\s*->\s*bool\s*\{[\s\S]*?Err\(_\)\s*=>\s*true/.test(jsoncSrc);
  const restoreDefaultOn = /fn field_restore_enabled\(\)\s*->\s*bool\s*\{[\s\S]*?Err\(_\)\s*=>\s*true/.test(stashSrc);
  ok('jsonc_edit（保形写入）与 field_restore（字段还原）默认开启',
    jsoncDefaultOn && restoreDefaultOn,
    `jsonc=${jsoncDefaultOn}, field_restore=${restoreDefaultOn}`);

  // 7. 已删旧壳/死模块/冗余副本不得复活
  const indexHtml = exists('ui/index.html') ? read('ui/index.html') : '';
  const modelContextRs = read('src-tauri/src/commands/platforms/model_context.rs');
  ok('已删旧壳与死模块不得复活（inject-models.js / 00-bridge.js）',
    !exists('sidecar/inject-models.js')
      && !exists('ui/assets/scripts/00-bridge.js')
      && !mainJs.includes('00-bridge')
      && !indexHtml.includes('00-bridge.js'));
  ok('model-context-presets.json 已收敛单源（无 resources 冗余副本）',
    !exists('src-tauri/resources/model-context-presets.json')
      && modelContextRs.includes('ui/assets/model-context-presets.json'));

  // 8. 共享资源主从副本字节 100% 一致
  const bytesEqual = (aRel, bRel) => {
    if (!exists(aRel) || !exists(bRel)) return false;
    return Buffer.compare(fs.readFileSync(path.join(root, aRel)), fs.readFileSync(path.join(root, bRel))) === 0;
  };
  const sharedPairs = [
    ['sidecar/windsurf-catalog.json', 'src-tauri/resources/sidecar/windsurf-catalog.json'],
    ['sidecar/prompts/system-prompt.md', 'src-tauri/resources/prompts/system-prompt.md'],
  ];
  const uiIconsDir = path.join(root, 'ui/assets/icons');
  if (fs.existsSync(uiIconsDir)) {
    for (const ent of fs.readdirSync(uiIconsDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const docIconRel = `docs/assets/icons/${ent.name}`;
      if (exists(docIconRel)) sharedPairs.push([`ui/assets/icons/${ent.name}`, docIconRel]);
    }
  }
  const driftedResources = sharedPairs.filter(([a, b]) => !bytesEqual(a, b)).map(([a, b]) => `${a} != ${b}`);
  ok(`共享资源主从副本字节 100% 一致（${sharedPairs.length} 对）`,
    driftedResources.length === 0,
    driftedResources.join(', '));

  // 9. scripts/ 工作区净场（无 _wb_asar_extract / _* 探针垃圾）与自动扫描构建
  const strayScripts = [];
  const walkScriptsJunk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.name.startsWith('_')) strayScripts.push(rel);
      if (entry.isDirectory()) walkScriptsJunk(full);
    }
  };
  walkScriptsJunk(path.join(root, 'scripts'));
  const sidecarBuildPy = read('scripts/build/build_protected_sidecar.py');
  ok('scripts/ 下无 _wb_asar_extract / _review_diffs / _* 探针垃圾，且根目录无 icon-backups',
    strayScripts.length === 0 && !exists('icon-backups') && !exists('ui/index.html.baseline'),
    strayScripts.slice(0, 8).join(', '));
  ok('build_protected_sidecar.py 已自动扫描 sidecar 模块（移除硬编码列表）',
    !sidecarBuildPy.includes('"inject-models.js"') && sidecarBuildPy.includes('os.listdir(JSC_DIR)'));
}

export const runNewFileLineChecks = runCodebaseStructureChecks;
