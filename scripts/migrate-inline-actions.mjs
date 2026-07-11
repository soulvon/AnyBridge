import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 将 ui-src 中的 on* 内联事件迁移为 data-action 体系。
 * 不支持的表达式会保留原样并记入 report。
 */

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.html')) acc.push(p);
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
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return stripQuotes(t);
  }
  // object literal { manual: true }
  if (t.startsWith('{') && t.endsWith('}')) {
    // convert JS object-ish to JSON: keys without quotes, single quotes
    let jsonish = t
      .replace(/(\w+)\s*:/g, '"$1":')
      .replace(/'/g, '"');
    try {
      return JSON.parse(jsonish);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Split call args by comma respecting quotes/parens/braces */
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

/**
 * @returns {{ attrs: Record<string,string|true>, ok: boolean, reason?: string }}
 */
function convertHandler(attr, code) {
  const original = code.trim();
  let c = original;
  const attrs = {};
  const eventMap = {
    onclick: 'click',
    onchange: 'change',
    oninput: 'input',
    onkeydown: 'keydown',
  };
  const evt = eventMap[attr];
  if (!evt) return { ok: false, reason: `unsupported attr ${attr}`, attrs: {} };

  // keydown Enter special
  const keyEnter = c.match(
    /^if\s*\(\s*event\.key\s*===\s*['"]Enter['"]\s*\)\s*\{\s*event\.preventDefault\(\)\s*;\s*([A-Za-z_$][\w$]*)\(\)\s*;?\s*\}$/,
  );
  if (keyEnter) {
    attrs['data-action'] = keyEnter[1];
    attrs['data-events'] = 'keydown';
    attrs['data-key'] = 'Enter';
    attrs['data-prevent'] = true;
    return { ok: true, attrs };
  }

  // if (event.target === this) foo()
  const onlySelf = c.match(/^if\s*\(\s*event\.target\s*===\s*this\s*\)\s*([A-Za-z_$][\w$]*)\(\)\s*;?$/);
  if (onlySelf) {
    attrs['data-action'] = onlySelf[1];
    attrs['data-only-self'] = true;
    if (evt !== 'click') attrs['data-events'] = evt;
    return { ok: true, attrs };
  }

  // document.getElementById('id').click()
  const clickId = c.match(/^document\.getElementById\((['"])([^'"]+)\1\)\.click\(\)\s*;?$/);
  if (clickId) {
    attrs['data-click-id'] = clickId[2];
    return { ok: true, attrs };
  }

  // document.getElementById('id').value=''
  const clearId = c.match(/^document\.getElementById\((['"])([^'"]+)\1\)\.value\s*=\s*['"]{2}\s*;?$/);
  if (clearId) {
    attrs['data-clear-id'] = clearId[2];
    return { ok: true, attrs };
  }

  // event.stopPropagation() only
  if (/^event\.stopPropagation\(\)\s*;?$/.test(c)) {
    attrs['data-stop'] = true;
    // need a no-op action marker so bus finds it — use data-action="" empty? bus requires attr presence
    attrs['data-action'] = '__noop';
    return { ok: true, attrs };
  }

  // Multi-statement: split by ;
  if (c.includes(';')) {
    // strip trailing semicolon
    const parts = c
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    // event.preventDefault(); event.stopPropagation(); fn()
    let prevent = false;
    let stop = false;
    const rest = [];
    for (const p of parts) {
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

    // assign + call: slotCatalogSort=this.value;filterSlotCatalog()
    if (rest.length === 2) {
      const assignM = rest[0].match(/^([A-Za-z_$][\w$]*)\s*=\s*this\.value$/);
      const call2 = tryParseCall(rest[1]);
      if (assignM && call2 && !call2.argsRaw) {
        attrs['data-assign'] = assignM[1];
        attrs['data-action'] = call2.name;
        attrs['data-events'] = evt;
        if (prevent) attrs['data-prevent'] = true;
        if (stop) attrs['data-stop'] = true;
        return { ok: true, attrs };
      }
    }

    // chain of calls
    if (rest.length >= 1) {
      const chain = [];
      for (const p of rest) {
        const call = tryParseCall(p);
        if (!call) return { ok: false, reason: `multiStmt unparsed: ${p}`, attrs: {} };
        const step = { fn: call.name };
        if (call.argsRaw) {
          const rawArgs = splitArgs(call.argsRaw);
          const args = [];
          let passThis = false;
          let passValue = false;
          let passChecked = false;
          let passEvent = false;
          for (const a of rawArgs) {
            if (a === 'this') {
              passThis = true;
              continue;
            }
            if (a === 'this.value') {
              passValue = true;
              continue;
            }
            if (a === 'this.checked') {
              passChecked = true;
              continue;
            }
            if (a === 'event') {
              passEvent = true;
              continue;
            }
            const lit = parseLiteral(a);
            if (lit === undefined) {
              return { ok: false, reason: `multiStmt arg: ${a}`, attrs: {} };
            }
            args.push(lit);
          }
          if (args.length) step.args = args;
          if (passThis) step.passThis = true;
          if (passValue) step.passValue = true;
          if (passChecked) step.passChecked = true;
          if (passEvent) step.passEvent = true;
        }
        chain.push(step);
      }
      if (chain.length === 1 && !prevent && !stop) {
        // fall through to single — but we already have chain
      }
      attrs['data-action-chain'] = JSON.stringify(chain);
      // also set data-action to first for discoverability? bus uses chain attr
      attrs['data-action'] = chain[0].fn;
      if (evt !== 'click') attrs['data-events'] = evt;
      else if (chain.length > 1) {
        /* click default ok */
      }
      if (prevent) attrs['data-prevent'] = true;
      if (stop) attrs['data-stop'] = true;
      return { ok: true, attrs };
    }
  }

  // Single call
  // optional prefix event.preventDefault / stop already handled in multi

  // event.stopPropagation(); handleX(...) already multi

  const call = tryParseCall(c);
  if (!call) return { ok: false, reason: `not a call: ${c}`, attrs: {} };

  attrs['data-action'] = call.name;
  if (evt !== 'click') attrs['data-events'] = evt;

  if (!call.argsRaw) {
    return { ok: true, attrs };
  }

  const rawArgs = splitArgs(call.argsRaw);
  const literals = [];
  let passThis = false;
  let passValue = false;
  let passChecked = false;
  let passEvent = false;

  for (const a of rawArgs) {
    if (a === 'this') {
      passThis = true;
      continue;
    }
    if (a === 'this.value') {
      passValue = true;
      continue;
    }
    if (a === 'this.checked') {
      passChecked = true;
      continue;
    }
    if (a === 'event') {
      passEvent = true;
      continue;
    }
    const lit = parseLiteral(a);
    if (lit === undefined) {
      return { ok: false, reason: `arg not literal: ${a} in ${c}`, attrs: {} };
    }
    literals.push(lit);
  }

  if (literals.length === 1 && typeof literals[0] === 'string' && !passThis && !passValue && !passChecked && !passEvent) {
    attrs['data-arg'] = literals[0];
  } else if (literals.length > 0) {
    attrs['data-args'] = JSON.stringify(literals);
  }
  if (passThis) attrs['data-pass-this'] = true;
  if (passValue) attrs['data-pass-value'] = true;
  if (passChecked) attrs['data-pass-checked'] = true;
  if (passEvent) attrs['data-pass-event'] = true;

  return { ok: true, attrs };
}

function applyAttrs(tagOpen, removeAttrs, addAttrs) {
  // tagOpen is full match of opening tag start... without final >
  let result = tagOpen;
  for (const name of removeAttrs) {
    const re = new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`, 'i');
    result = result.replace(re, '');
  }
  // insert new attrs before end of tag (we work on string without >)
  const parts = [];
  for (const [k, v] of Object.entries(addAttrs)) {
    if (v === true) parts.push(`${k}`);
    else {
      const escaped = String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      parts.push(`${k}="${escaped}"`);
    }
  }
  if (parts.length) result += ' ' + parts.join(' ');
  return result;
}

const ATTR_NAMES = ['onclick', 'onchange', 'oninput', 'onkeydown'];
const attrRe = /\b(onclick|onchange|oninput|onkeydown)="([^"]*)"/gi;

const report = { converted: 0, skipped: [], files: {} };

for (const file of walk('ui-src')) {
  let html = readFileSync(file, 'utf8');
  let fileCount = 0;

  // Process tag by tag: find tags that contain on* handlers
  // Safer: replace each on* attribute in place by expanding the whole tag
  // We'll do sequential attribute conversion on the full file.

  // Find all matches and convert from end to start to preserve indices
  const matches = [];
  let m;
  const re = new RegExp(attrRe.source, 'gi');
  while ((m = re.exec(html)) !== null) {
    matches.push({ index: m.index, attr: m[1].toLowerCase(), code: m[2], full: m[0], len: m[0].length });
  }

  // Group by approximate tag: convert each attribute independently (replace attr with data-*)
  // Multiple on* on same element need merging — process element-wise.

  // Element-wise: match opening tags
  const tagRe = /<([a-zA-Z][\w:-]*)(\s[^>]*?)>/g;
  const replacements = [];
  let tm;
  while ((tm = tagRe.exec(html)) !== null) {
    const fullTag = tm[0];
    const name = tm[1];
    const attrChunk = tm[2];
    if (!/\bon(click|change|input|keydown)\s*=/i.test(attrChunk)) continue;

    const handlers = [];
    const localRe = new RegExp(attrRe.source, 'gi');
    let am;
    while ((am = localRe.exec(attrChunk)) !== null) {
      handlers.push({ attr: am[1].toLowerCase(), code: am[2] });
    }
    if (!handlers.length) continue;

    const removeList = [];
    const addMerged = {};
    let allOk = true;
    const reasons = [];

    for (const h of handlers) {
      const { ok, attrs, reason } = convertHandler(h.attr, h.code);
      if (!ok) {
        allOk = false;
        reasons.push(reason);
        continue;
      }
      removeList.push(h.attr);
      // merge attrs — if conflict on data-action from multi handlers, fail
      for (const [k, v] of Object.entries(attrs)) {
        if (k in addMerged && addMerged[k] !== v && k !== 'data-events') {
          // merge data-events
          if (k === 'data-events') {
            const set = new Set([...(String(addMerged[k]).split(/\s+/)), ...String(v).split(/\s+/)]);
            addMerged[k] = [...set].join(' ');
            continue;
          }
          allOk = false;
          reasons.push(`attr conflict ${k}`);
        } else if (k === 'data-events' && k in addMerged) {
          const set = new Set([...(String(addMerged[k]).split(/\s+/)), ...String(v).split(/\s+/)]);
          addMerged[k] = [...set].join(' ');
        } else {
          addMerged[k] = v;
        }
      }
    }

    if (!allOk || removeList.length !== handlers.length) {
      report.skipped.push({
        file: path.relative('ui-src', file),
        tag: name,
        handlers: handlers.map((h) => `${h.attr}=${h.code}`),
        reasons,
      });
      continue;
    }

    let newChunk = attrChunk;
    for (const r of removeList) {
      newChunk = newChunk.replace(new RegExp(`\\s${r}\\s*=\\s*"[^"]*"`, 'i'), '');
    }
    const parts = [];
    for (const [k, v] of Object.entries(addMerged)) {
      if (v === true) parts.push(k);
      else {
        const escaped = String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        parts.push(`${k}="${escaped}"`);
      }
    }
    const newTag = `<${name}${newChunk} ${parts.join(' ')}>`.replace(/\s+>/, '>').replace(/  +/g, ' ');
    replacements.push({ start: tm.index, end: tm.index + fullTag.length, newTag });
    fileCount += handlers.length;
  }

  if (replacements.length) {
    // apply from end
    replacements.sort((a, b) => b.start - a.start);
    for (const r of replacements) {
      html = html.slice(0, r.start) + r.newTag + html.slice(r.end);
    }
    writeFileSync(file, html);
    report.files[path.relative('ui-src', file)] = fileCount;
    report.converted += fileCount;
  }
}

// Register noop
console.log(JSON.stringify({ converted: report.converted, skipped: report.skipped.length, files: report.files, skippedDetails: report.skipped }, null, 2));
writeFileSync('scripts/_p2-migrate-report.json', JSON.stringify(report, null, 2));
