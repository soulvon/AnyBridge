/**
 * Fix incomplete P3 mirrors + residual top-level vars
 * (converter scanner stopped early on 10-shell / 20-runtime)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

// Reuse accurate scanner from audit2
function scan(src) {
  const fns = [];
  const varSpans = [];
  let i = 0;
  const n = src.length;
  let brace = 0;
  let paren = 0;
  let bracket = 0;

  function skipLineComment() {
    while (i < n && src[i] !== '\n') i++;
  }
  function skipBlockComment() {
    i += 2;
    while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
    i = Math.min(n, i + 2);
  }
  function skipString(q) {
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
  }
  function skipTemplate() {
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
  }
  function canStartRegex() {
    let j = i - 1;
    while (j >= 0 && /[ \t]/.test(src[j])) j--;
    if (j < 0) return true;
    return /[=(:,[\!&|?+{};\n]/.test(src[j]) || src.slice(Math.max(0, j - 6), j + 1).includes('return');
  }
  function skipRegex() {
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
  }

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
      if (rest.startsWith('// ---- P3 globalThis mirror')) break;
      let m;
      if ((m = rest.match(/^async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
        fns.push(m[1]);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
        fns.push(m[1]);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^(let|const|var)\s+/))) {
        const kindStart = i;
        const kind = m[1];
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
          if (ch === '\n' && pb === 0 && pp === 0 && pk === 0) break;
          i++;
        }
        const end = i;
        const inner = src.slice(innerStart, end);
        // only simple bindings, not object destructure
        if (!/^\s*[{\[]/.test(inner)) {
          const names = [];
          // split top-level commas carefully for object init like logViewerFilters = { a: 1 }
          // if single binding with = object, one name
          const eq = inner.indexOf('=');
          if (eq === -1) {
            const nm = inner.trim().match(/^([A-Za-z_$][\w$]*)/);
            if (nm) names.push(nm[1]);
          } else {
            const left = inner.slice(0, eq).trim();
            // multi: a = 1, b = 2
            // if left has comma, multi without init on first... rare
            if (!left.includes(',')) {
              const nm = left.match(/^([A-Za-z_$][\w$]*)$/);
              if (nm) names.push(nm[1]);
            } else {
              // fallback split
              for (const part of splitComma(inner)) {
                const nm = part.trim().match(/^([A-Za-z_$][\w$]*)/);
                if (nm) names.push(nm[1]);
              }
            }
          }
          if (names.length) {
            varSpans.push({ kind, kindStart, innerStart, end, names, inner });
          }
        }
        continue;
      }
    }
    i++;
  }
  return { fns: [...new Set(fns)], varSpans };
}

function splitComma(s) {
  const parts = [];
  let cur = '';
  let pb = 0;
  let pp = 0;
  let pk = 0;
  for (let i = 0; i < s.length; i++) {
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
        } else if (s[i] === q) break;
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
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function rewriteVar(kind, innerWithSemi) {
  const hasSemi = /;\s*$/.test(innerWithSemi);
  const body = innerWithSemi.replace(/;\s*$/, '');
  // single binding preferred
  const m = body.trim().match(/^([A-Za-z_$][\w$]*)(\s*=\s*[\s\S]*)?$/);
  if (m) {
    const name = m[1];
    const init = m[2] ? m[2].replace(/^\s*=\s*/, '') : 'undefined';
    return `globalThis.${name} = ${init}` + (hasSemi ? ';' : '');
  }
  // multi
  const parts = splitComma(body);
  const stmts = parts.map((p) => {
    const t = p.trim();
    const mm = t.match(/^([A-Za-z_$][\w$]*)(\s*=\s*[\s\S]*)?$/);
    if (!mm) return `${kind} ${t}`;
    const name = mm[1];
    if (mm[2]) return `globalThis.${name} = ${mm[2].replace(/^\s*=\s*/, '')}`;
    return `globalThis.${name} = undefined`;
  });
  return stmts.join('; ') + (hasSemi ? ';' : '');
}

for (const f of ORDER) {
  const path = join('ui/assets/scripts', f);
  let src = readFileSync(path, 'utf8');
  if (!src.includes('ES module (P3)')) continue;

  // strip old mirror
  src = src.replace(/\n\/\/ ---- P3 globalThis mirror[\s\S]*$/, '\n');

  const { fns, varSpans } = scan(src);

  // rewrite residual vars from back
  const sorted = [...varSpans].sort((a, b) => b.kindStart - a.kindStart);
  for (const d of sorted) {
    // skip if already globalThis (shouldn't be in scan)
    const rewritten = rewriteVar(d.kind, src.slice(d.innerStart, d.end));
    src = src.slice(0, d.kindStart) + rewritten + src.slice(d.end);
  }

  // rebuild mirror
  if (fns.length) {
    const footer =
      '\n// ---- P3 globalThis mirror (functions/classes) ----\n' +
      '(function mirrorFns(g) {\n' +
      fns.map((name) => `  g.${name} = ${name};`).join('\n') +
      '\n})(globalThis);\n';
    src = src.replace(/\s*$/, '\n') + footer;
  }

  writeFileSync(path, src);
  console.log(
    'fixed',
    f,
    'fns=',
    fns.length,
    'varsRewritten=',
    varSpans.length,
    varSpans.length ? varSpans.flatMap((v) => v.names).join(',') : '',
  );
}
console.log('done');
