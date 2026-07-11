/**
 * P3: classic scripts → ES modules（零回归，保留 function hoist）
 *
 * 策略：
 * 1. 顶层 function / async function / class：保留声明（模块内 hoist），文末 mirror 到 globalThis
 * 2. 顶层 let/const/var：改写为 globalThis.name = ...（可变共享状态）
 * 3. 浏览器模块对 global 对象属性的自由变量读写与 classic 全局脚本一致
 * 4. data-action 继续 window[fnName]
 * 5. IIFE 副作用文件仅加 module 标记
 * 6. main.js 按序 import
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'ui/assets/scripts';
const ORDER = [
  '00-bridge.js',
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

const HEADER = `// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
`;

function transformSource(src) {
  if (src.includes('ES module (P3)')) {
    return { out: src, stats: { skipped: 'already' } };
  }

  const decls = findTopLevelDecls(src);
  const fnNames = decls.filter((d) => d.kind === 'function' || d.kind === 'class').map((d) => d.name);
  const varDecls = decls.filter((d) => d.kind === 'var');

  if (decls.length === 0) {
    return {
      out: HEADER + src.replace(/\s*$/, '\n'),
      stats: { skipped: 'side-effect-only', functions: 0, vars: 0 },
    };
  }

  let out = src;
  // 只改写 var，从后往前
  const sortedVars = [...varDecls].sort((a, b) => b.start - a.start);
  let varCount = 0;
  for (const d of sortedVars) {
    const rewritten = rewriteVarDecl(d.varKind, out.slice(d.innerStart, d.end));
    out = out.slice(0, d.start) + rewritten + out.slice(d.end);
    varCount += d.names.length;
  }

  // 文末 mirror functions/classes（去重）
  const uniqueFns = [...new Set(fnNames)];
  const footer =
    uniqueFns.length === 0
      ? ''
      : [
          '',
          '// ---- P3 globalThis mirror (functions/classes) ----',
          '(function mirrorFns(g) {',
          ...uniqueFns.map((name) => `  g.${name} = ${name};`),
          '})(globalThis);',
          '',
        ].join('\n');

  return {
    out: HEADER + out.replace(/\s*$/, '\n') + footer,
    stats: { functions: uniqueFns.length, vars: varCount, classes: 0 },
  };
}

function findTopLevelDecls(src) {
  const decls = [];
  let i = 0;
  const n = src.length;
  let brace = 0;
  let paren = 0;
  let bracket = 0;

  const skipLineComment = () => {
    while (i < n && src[i] !== '\n') i++;
  };
  const skipBlockComment = () => {
    i += 2;
    while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
    i = Math.min(n, i + 2);
  };
  const skipString = (q) => {
    i++;
    while (i < n) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === q) {
        i++;
        break;
      }
      i++;
    }
  };
  const skipTemplate = () => {
    i++;
    while (i < n) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '`') {
        i++;
        break;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = src[i];
          if (c === '"' || c === "'") skipString(c);
          else if (c === '`') skipTemplate();
          else if (c === '/' && src[i + 1] === '/') skipLineComment();
          else if (c === '/' && src[i + 1] === '*') skipBlockComment();
          else if (c === '{') {
            depth++;
            i++;
          } else if (c === '}') {
            depth--;
            i++;
          } else i++;
        }
        continue;
      }
      i++;
    }
  };
  const canStartRegex = () => {
    let j = i - 1;
    while (j >= 0 && /[ \t]/.test(src[j])) j--;
    if (j < 0) return true;
    return /[=(:,[\!&|?+{};\nreturn]/.test(src[j]);
  };
  const skipRegex = () => {
    i++;
    while (i < n) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '[') {
        i++;
        while (i < n && src[i] !== ']') {
          if (src[i] === '\\') i += 2;
          else i++;
        }
        i++;
        continue;
      }
      if (src[i] === '/') {
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        break;
      }
      i++;
    }
  };

  const skipFunctionFromName = () => {
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === '*') i++;
    while (i < n && /\s/.test(src[i])) i++;
    while (i < n && src[i] !== '(') i++;
    if (src[i] === '(') {
      let d = 0;
      do {
        if (src[i] === '"' || src[i] === "'") skipString(src[i]);
        else if (src[i] === '`') skipTemplate();
        else if (src[i] === '(') {
          d++;
          i++;
        } else if (src[i] === ')') {
          d--;
          i++;
        } else i++;
      } while (i < n && d > 0);
    }
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === '{') {
      let d = 0;
      do {
        const c = src[i];
        if (c === '"' || c === "'") skipString(c);
        else if (c === '`') skipTemplate();
        else if (c === '/' && src[i + 1] === '/') skipLineComment();
        else if (c === '/' && src[i + 1] === '*') skipBlockComment();
        else if (c === '/' && canStartRegex()) skipRegex();
        else if (c === '{') {
          d++;
          i++;
        } else if (c === '}') {
          d--;
          i++;
        } else i++;
      } while (i < n && d > 0);
    }
  };

  const skipClassBody = () => {
    while (i < n && /\s/.test(src[i])) i++;
    if (src.startsWith('extends', i)) {
      i += 7;
      while (i < n && src[i] !== '{') {
        if (src[i] === '"' || src[i] === "'") skipString(src[i]);
        else if (src[i] === '`') skipTemplate();
        else i++;
      }
    }
    if (src[i] === '{') {
      let d = 0;
      do {
        const c = src[i];
        if (c === '"' || c === "'") skipString(c);
        else if (c === '`') skipTemplate();
        else if (c === '/' && src[i + 1] === '/') skipLineComment();
        else if (c === '/' && src[i + 1] === '*') skipBlockComment();
        else if (c === '{') {
          d++;
          i++;
        } else if (c === '}') {
          d--;
          i++;
        } else i++;
      } while (i < n && d > 0);
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      skipLineComment();
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      skipBlockComment();
      continue;
    }
    if (c === '"' || c === "'") {
      skipString(c);
      continue;
    }
    if (c === '`') {
      skipTemplate();
      continue;
    }
    if (c === '/' && canStartRegex()) {
      skipRegex();
      continue;
    }
    if (c === '{') {
      brace++;
      i++;
      continue;
    }
    if (c === '}') {
      brace = Math.max(0, brace - 1);
      i++;
      continue;
    }
    if (c === '(') {
      paren++;
      i++;
      continue;
    }
    if (c === ')') {
      paren = Math.max(0, paren - 1);
      i++;
      continue;
    }
    if (c === '[') {
      bracket++;
      i++;
      continue;
    }
    if (c === ']') {
      bracket = Math.max(0, bracket - 1);
      i++;
      continue;
    }

    if (brace === 0 && paren === 0 && bracket === 0) {
      const rest = src.slice(i);
      let m;
      if ((m = rest.match(/^async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
        const start = i;
        const name = m[1];
        const nameEnd = i + m[0].length;
        i = nameEnd;
        skipFunctionFromName();
        decls.push({ kind: 'function', async: true, name, start, nameEnd, end: i });
        continue;
      }
      if ((m = rest.match(/^function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
        const start = i;
        const name = m[1];
        const nameEnd = i + m[0].length;
        i = nameEnd;
        skipFunctionFromName();
        decls.push({ kind: 'function', async: false, name, start, nameEnd, end: i });
        continue;
      }
      if ((m = rest.match(/^class\s+([A-Za-z_$][\w$]*)/))) {
        const start = i;
        const name = m[1];
        const nameEnd = i + m[0].length;
        i = nameEnd;
        skipClassBody();
        decls.push({ kind: 'class', name, start, nameEnd, end: i });
        continue;
      }
      if ((m = rest.match(/^(let|const|var)\s+/))) {
        const start = i;
        const varKind = m[1];
        i += m[0].length;
        const innerStart = i;
        let pb = 0;
        let pp = 0;
        let pk = 0;
        while (i < n) {
          const ch = src[i];
          if (ch === '"' || ch === "'") {
            skipString(ch);
            continue;
          }
          if (ch === '`') {
            skipTemplate();
            continue;
          }
          if (ch === '/' && src[i + 1] === '/') {
            skipLineComment();
            continue;
          }
          if (ch === '/' && src[i + 1] === '*') {
            skipBlockComment();
            continue;
          }
          if (ch === '{') {
            pb++;
            i++;
            continue;
          }
          if (ch === '}') {
            pb--;
            i++;
            continue;
          }
          if (ch === '(') {
            pp++;
            i++;
            continue;
          }
          if (ch === ')') {
            pp--;
            i++;
            continue;
          }
          if (ch === '[') {
            pk++;
            i++;
            continue;
          }
          if (ch === ']') {
            pk--;
            i++;
            continue;
          }
          if (ch === ';' && pb === 0 && pp === 0 && pk === 0) {
            i++;
            break;
          }
          if (ch === '\n' && pb === 0 && pp === 0 && pk === 0) {
            let j = i + 1;
            while (j < n && /[ \t]/.test(src[j])) j++;
            if (j < n && (src[j] === '\n' || src[j] === '/' || /[A-Za-z_$]/.test(src[j]))) {
              break;
            }
          }
          i++;
        }
        const inner = src.slice(innerStart, i);
        const names = [];
        if (!/^\s*[{\[]/.test(inner)) {
          for (const part of splitTopLevelComma(inner.replace(/;\s*$/, ''))) {
            const nm = part.trim().match(/^([A-Za-z_$][\w$]*)/);
            if (nm) names.push(nm[1]);
          }
        }
        decls.push({ kind: 'var', varKind, names, start, innerStart, end: i });
        continue;
      }
    }
    i++;
  }
  return decls;
}

function splitTopLevelComma(s) {
  const parts = [];
  let cur = '';
  let pb = 0;
  let pp = 0;
  let pk = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      cur += c;
      i++;
      while (i < s.length) {
        cur += s[i];
        if (s[i] === '\\') {
          i++;
          if (i < s.length) cur += s[i];
          i++;
          continue;
        }
        if (s[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '`') {
      cur += c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          cur += s[i];
          i++;
          if (i < s.length) cur += s[i];
          i++;
          continue;
        }
        cur += s[i];
        if (s[i] === '`') {
          i++;
          break;
        }
        if (s[i] === '$' && s[i + 1] === '{') {
          cur += '{';
          i += 2;
          let d = 1;
          while (i < s.length && d > 0) {
            cur += s[i];
            if (s[i] === '{') d++;
            else if (s[i] === '}') d--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === '{') pb++;
    if (c === '}') pb--;
    if (c === '(') pp++;
    if (c === ')') pp--;
    if (c === '[') pk++;
    if (c === ']') pk--;
    if (c === ',' && pb === 0 && pp === 0 && pk === 0) {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function rewriteVarDecl(varKind, innerWithSemi) {
  const hasSemi = /;\s*$/.test(innerWithSemi);
  const body = innerWithSemi.replace(/;\s*$/, '');
  const parts = splitTopLevelComma(body);
  const stmts = parts.map((p) => {
    const t = p.trim();
    if (!t) return '';
    if (t.startsWith('{') || t.startsWith('[')) {
      return `${varKind} ${t}`;
    }
    const m = t.match(/^([A-Za-z_$][\w$]*)(\s*=\s*[\s\S]*)?$/);
    if (!m) return `${varKind} ${t}`;
    const name = m[1];
    if (m[2]) {
      const init = m[2].replace(/^\s*=\s*/, '');
      return `globalThis.${name} = ${init}`;
    }
    return `globalThis.${name} = undefined`;
  });
  const joined = stmts.filter(Boolean).join('; ');
  return joined + (hasSemi ? ';' : '');
}

const dry = process.argv.includes('--dry');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const report = {};

for (const f of ORDER) {
  if (only && f !== only) continue;
  const path = join(DIR, f);
  const src = readFileSync(path, 'utf8');
  const { out, stats } = transformSource(src);
  report[f] = stats;
  console.log(dry ? 'dry' : 'write', f, JSON.stringify(stats));
  if (!dry && stats.skipped !== 'already') writeFileSync(path, out);
}

if (!only) {
  const mainJs =
    `/**\n * AnyBridge UI entry (ES module)\n * Side-effect imports in dependency order; bindings live on globalThis.\n */\n` +
    ORDER.map((f) => `import './${f}';`).join('\n') +
    '\n';
  if (!dry) {
    writeFileSync(join(DIR, 'main.js'), mainJs);
    console.log('wrote main.js');
  }
}

writeFileSync('scripts/_p3-transform-report.json', JSON.stringify(report, null, 2));
console.log('done');
