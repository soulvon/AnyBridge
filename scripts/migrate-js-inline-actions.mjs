/**
 * 将 ui/assets/scripts 中模板字符串里的 on* 内联事件迁移为 data-action。
 * 仅处理可静态识别的模式；复杂表达式记入 report 并保留。
 *
 * 支持：
 * - fn() / fn('a') / fn(true) / fn(1)
 * - fn('${expr}') / fn(${idx}) / fn(${idx}, -1) / fn(${idx}, 'x', this.value)
 * - this / this.value / this.checked / event
 * - event.stopPropagation()
 * - if(event.target===this) fn()
 * - multi-stmt: prevent/stop + chain
 * - assign: var='lit';fn() / var='${expr}';fn()
 * - data-action-call for full dynamic call strings: onclick="${expr}"
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'ui/assets/scripts';

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function stripQuotes(s) {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseLiteral(tok) {
  const t = tok.trim();
  if (t === 'true') return { kind: 'lit', value: true };
  if (t === 'false') return { kind: 'lit', value: false };
  if (t === 'null') return { kind: 'lit', value: null };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: 'lit', value: Number(t) };
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return { kind: 'lit', value: stripQuotes(t) };
  }
  // quoted template: '${...}' or "${...}"
  const tmpl = t.match(/^(['"])\$\{([^}]+)\}\1$/);
  if (tmpl) return { kind: 'expr', expr: tmpl[2], quote: tmpl[1] };
  // bare template expression: ${idx} or ${nextChecked}
  const bare = t.match(/^\$\{([^}]+)\}$/);
  if (bare) return { kind: 'expr', expr: bare[1], bare: true };
  if (t === 'this') return { kind: 'this' };
  if (t === 'this.value') return { kind: 'value' };
  if (t === 'this.checked') return { kind: 'checked' };
  if (t === 'event') return { kind: 'event' };
  if (t.startsWith('{') && t.endsWith('}')) {
    let jsonish = t.replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"');
    try {
      return { kind: 'lit', value: JSON.parse(jsonish) };
    } catch {
      return null;
    }
  }
  return null;
}

function splitArgs(argStr) {
  const args = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i];
    if (quote) {
      cur += ch;
      if (ch === quote && argStr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function tryParseCall(code) {
  const m = code.match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)\s*;?\s*$/);
  if (!m) return null;
  return { name: m[1], argsRaw: m[2].trim() };
}

function escAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Build data-args attribute value for mixed lit/expr args.
 * Inside JS template literals: data-args="[&quot;${expr}&quot;,true]"
 * For bare numeric expr: data-args="[${idx},-1]"
 */
function buildDataArgsAttr(ordered) {
  let argsStr = '[';
  ordered.forEach((item, i) => {
    if (i) argsStr += ',';
    if (item.type === 'expr') {
      // numbers/bools from bare ${idx} should not be quoted in JSON
      // strings from '${escAttr(x)}' should be quoted
      if (item.quoted === false) {
        argsStr += `\${${item.expr}}`;
      } else {
        argsStr += `"\${${item.expr}}"`;
      }
    } else {
      argsStr += JSON.stringify(item.value);
    }
  });
  argsStr += ']';
  return `data-args="${escAttr(argsStr)}"`;
}

function convertHandler(attr, code) {
  const original = code.trim();
  let c = original;
  const eventMap = {
    onclick: 'click',
    onchange: 'change',
    oninput: 'input',
    onkeydown: 'keydown',
  };
  const evt = eventMap[attr];
  if (!evt) return null;

  const parts = [];
  const add = (k, v) => {
    if (v === true) parts.push(k);
    else parts.push(`${k}="${escAttr(v)}"`);
  };

  // Dynamic full call string: ${defaultBtnClick} or ${platformEsc(...)}
  // Only when the entire attribute value is a single ${...} expression
  const dynCall = c.match(/^\$\{([^}]+(?:\{[^}]*\}[^}]*)*)\}$/);
  // simpler: entire code is ${...} without nested complexity for common cases
  if (/^\$\{.+\}$/.test(c) && !c.includes('(') === false) {
    // always treat pure ${expr} as data-action-call when no function call pattern
  }
  if (/^\$\{[\s\S]+\}$/.test(c) && !tryParseCall(c)) {
    // onclick="${defaultBtnClick}" → data-action-call="${defaultBtnClick}"
    // Keep the template expression as-is
    const inner = c.slice(2, -1);
    parts.push(`data-action-call="\${${inner}}"`);
    if (evt !== 'click') add('data-events', evt);
    return parts.join(' ');
  }

  // if(event.target===this) fn()
  const onlySelf = c.match(/^if\s*\(\s*event\.target\s*===\s*this\s*\)\s*([A-Za-z_$][\w$]*)\(\)\s*;?$/);
  if (onlySelf) {
    add('data-action', onlySelf[1]);
    parts.push('data-only-self');
    if (evt !== 'click') add('data-events', evt);
    return parts.join(' ');
  }
  const onlySelfId = c.match(
    /^if\s*\(\s*event\.target(?:\.id)?\s*===\s*(?:this|['"]([^'"]+)['"])\s*\)\s*([A-Za-z_$][\w$]*)\(\)\s*;?$/,
  );
  if (onlySelfId) {
    add('data-action', onlySelfId[2]);
    parts.push('data-only-self');
    if (evt !== 'click') add('data-events', evt);
    return parts.join(' ');
  }

  if (/^event\.stopPropagation\(\)\s*;?$/.test(c)) {
    add('data-action', '__noop');
    parts.push('data-stop');
    return parts.join(' ');
  }

  // Multi-statement
  if (c.includes(';')) {
    const stmts = c
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    let prevent = false;
    let stop = false;
    const rest = [];
    for (const p of stmts) {
      if (p === 'event.preventDefault()') {
        prevent = true;
        continue;
      }
      if (p === 'event.stopPropagation()') {
        stop = true;
        continue;
      }
      rest.push(p);
    }

    // assign + call: mappingCatalogProvider='';render...()
    // or mappingCatalogProvider='${escAttr(pid)}';render...()
    // or mappingCatalogProvider='x';render...()
    if (rest.length === 2) {
      const assignM = rest[0].match(
        /^([A-Za-z_$][\w$]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|'\$\{([^}]+)\}'|"\$\{([^}]+)\}"|this\.value)$/,
      );
      const call2 = tryParseCall(rest[1]);
      if (assignM && call2) {
        const varName = assignM[1];
        if (rest[0].endsWith('this.value')) {
          add('data-assign', varName);
        } else if (assignM[4] || assignM[5]) {
          const expr = assignM[4] || assignM[5];
          parts.push(`data-set="${varName}"`);
          parts.push(`data-set-value="\${${expr}}"`);
        } else {
          const lit = assignM[2] !== undefined ? assignM[2] : assignM[3] !== undefined ? assignM[3] : '';
          parts.push(`data-set="${varName}"`);
          parts.push(`data-set-value="${escAttr(lit)}"`);
        }
        // call may have args
        if (!call2.argsRaw) {
          add('data-action', call2.name);
        } else {
          // only no-arg calls for assign+call for now
          const sub = convertHandler(attr, rest[1]);
          if (!sub) return null;
          // merge carefully - avoid duplicate data-events
          return [
            ...parts,
            sub,
            prevent ? 'data-prevent' : '',
            stop ? 'data-stop' : '',
            evt !== 'click' && !sub.includes('data-events') ? `data-events="${evt}"` : '',
          ]
            .filter(Boolean)
            .join(' ');
        }
        if (evt !== 'click') add('data-events', evt);
        if (prevent) parts.push('data-prevent');
        if (stop) parts.push('data-stop');
        return parts.join(' ');
      }

      // assign this.value + call no-arg (already partially handled)
      const assignVal = rest[0].match(/^([A-Za-z_$][\w$]*)\s*=\s*this\.value$/);
      if (assignVal && call2 && !call2.argsRaw) {
        add('data-assign', assignVal[1]);
        add('data-action', call2.name);
        add('data-events', evt);
        if (prevent) parts.push('data-prevent');
        if (stop) parts.push('data-stop');
        return parts.join(' ');
      }
    }

    // chain of simple calls
    if (rest.length >= 1) {
      const chain = [];
      for (const p of rest) {
        const call = tryParseCall(p);
        if (!call) return null;
        const step = { fn: call.name };
        if (call.argsRaw) {
          const rawArgs = splitArgs(call.argsRaw);
          const args = [];
          for (const a of rawArgs) {
            const parsed = parseLiteral(a);
            if (!parsed) return null;
            if (parsed.kind === 'this') step.passThis = true;
            else if (parsed.kind === 'value') step.passValue = true;
            else if (parsed.kind === 'checked') step.passChecked = true;
            else if (parsed.kind === 'event') step.passEvent = true;
            else if (parsed.kind === 'expr') return null;
            else args.push(parsed.value);
          }
          if (args.length) step.args = args;
        }
        chain.push(step);
      }
      add('data-action-chain', JSON.stringify(chain));
      add('data-action', chain[0].fn);
      if (evt !== 'click') add('data-events', evt);
      if (prevent) parts.push('data-prevent');
      if (stop) parts.push('data-stop');
      return parts.join(' ');
    }
  }

  const call = tryParseCall(c);
  if (!call) return null;

  add('data-action', call.name);
  if (evt !== 'click') add('data-events', evt);

  if (!call.argsRaw) {
    return parts.join(' ');
  }

  const rawArgs = splitArgs(call.argsRaw);
  const ordered = [];
  let passThis = false;
  let passValue = false;
  let passChecked = false;
  let passEvent = false;
  let hasExpr = false;

  for (const a of rawArgs) {
    const parsed = parseLiteral(a);
    if (!parsed) return null;
    if (parsed.kind === 'this') {
      passThis = true;
      continue;
    }
    if (parsed.kind === 'value') {
      passValue = true;
      continue;
    }
    if (parsed.kind === 'checked') {
      passChecked = true;
      continue;
    }
    if (parsed.kind === 'event') {
      passEvent = true;
      continue;
    }
    if (parsed.kind === 'expr') {
      hasExpr = true;
      // bare ${idx} → unquoted in JSON (number/bool); quoted '${x}' → quoted string
      ordered.push({ type: 'expr', expr: parsed.expr, quoted: !parsed.bare });
      continue;
    }
    ordered.push({ type: 'lit', value: parsed.value });
  }

  if (hasExpr) {
    if (ordered.length === 1 && ordered[0].type === 'expr' && !passThis && !passValue && !passChecked && !passEvent) {
      // single dynamic arg
      if (ordered[0].quoted === false) {
        // bare number-like: still use data-args for type fidelity, or data-arg as string
        // Prefer data-args="[${idx}]" so Number is preserved after JSON.parse
        parts.push(buildDataArgsAttr(ordered));
      } else {
        parts.push(`data-arg="\${${ordered[0].expr}}"`);
      }
    } else if (ordered.length > 0) {
      parts.push(buildDataArgsAttr(ordered));
    }
  } else if (ordered.length === 1 && typeof ordered[0].value === 'string' && !passThis && !passValue && !passChecked && !passEvent) {
    add('data-arg', ordered[0].value);
  } else if (ordered.length > 0) {
    add('data-args', JSON.stringify(ordered.map((o) => o.value)));
  }

  if (passThis) parts.push('data-pass-this');
  if (passValue) parts.push('data-pass-value');
  if (passChecked) parts.push('data-pass-checked');
  if (passEvent) parts.push('data-pass-event');

  return parts.join(' ');
}

const report = { converted: 0, skipped: [], files: {} };

for (const file of walk(ROOT)) {
  let src = readFileSync(file, 'utf8');
  let fileCount = 0;
  const skippedHere = [];

  const re = /\b(onclick|onchange|oninput|onkeydown)\s*=\s*"([^"]*)"/g;

  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const attr = m[1].toLowerCase();
    const code = m[2];
    const decoded = code
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    const replacement = convertHandler(attr, decoded);
    if (!replacement) {
      skippedHere.push({ code: `${attr}="${code}"`, index: m.index, line: src.slice(0, m.index).split('\n').length });
      continue;
    }
    out += src.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    fileCount++;
  }
  out += src.slice(last);

  if (fileCount) {
    writeFileSync(file, out);
    report.files[path.relative(ROOT, file)] = fileCount;
    report.converted += fileCount;
  }
  for (const s of skippedHere) {
    report.skipped.push({ file: path.relative(ROOT, file), ...s });
  }
}

console.log(
  JSON.stringify(
    {
      converted: report.converted,
      skipped: report.skipped.length,
      files: report.files,
      skippedDetails: report.skipped,
    },
    null,
    2,
  ),
);
writeFileSync('scripts/_p2-js-migrate-report.json', JSON.stringify(report, null, 2));
