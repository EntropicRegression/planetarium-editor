// Keeps the English translation table honest.
//
//   node tools/i18n-scan.js            lists strings that have no English translation, and
//                                      translations that no longer match any string
//   node tools/i18n-scan.js --tag      (one-off) wraps every Chinese string literal in the
//                                      scripts in t`...`, so it goes through the translator
//
// Exits non-zero when something is missing, so it can gate a release.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const SCRIPTS = ['js/app.js', 'js/assistant.js', 'js/ai/core.js', 'js/ai/claude.js', 'js/ai/gemini.js', 'js/ai/openai.js', 'js/effects.js', 'js/phone.js'];
const CJK = /[㐀-鿿]/;

/**
 * Walks JavaScript source, calling visit(kind, start, end) for each string or template literal
 * outside comments and regular expressions. kind is "'", '"' or '`'. Template literals are
 * reported whole; the literals nested in their ${} expressions are reported too.
 */
function literals(src, visit) {
  let i = 0;
  let lastSignificant = '';
  const template = () => {
    // At the opening backtick. Returns the index after the closing one.
    const start = i++;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        i++;
        visit('`', start, i);
        return;
      } else if (ch === '$' && src[i + 1] === '{') {
        i += 2;
        code('}');
      } else i++;
    }
  };
  const code = (until) => {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (until && ch === until && depth === 0) {
        i++;
        return;
      }
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (ch === '/' && src[i + 1] === '*') {
        i = src.indexOf('*/', i) + 2;
      } else if (ch === '/' && /[(,=:[!&|?{};\n]|^$/.test(lastSignificant)) {
        // A regular expression: skip to its end, minding classes and escapes.
        i++;
        let inClass = false;
        while (i < src.length && (src[i] !== '/' || inClass)) {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i++;
        }
        i++;
        lastSignificant = '/';
      } else if (ch === "'" || ch === '"') {
        const start = i++;
        while (i < src.length && src[i] !== ch) i += src[i] === '\\' ? 2 : 1;
        i++;
        visit(ch, start, i);
        lastSignificant = ch;
      } else if (ch === '`') {
        template();
        lastSignificant = '`';
      } else {
        if (!/\s/.test(ch)) lastSignificant = ch;
        i++;
      }
    }
  };
  code(null);
}

/** The lookup key of a template literal's body: each ${...} becomes {}. */
function keyOf(body) {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\') {
      out += vm.runInNewContext('`' + body.slice(i, i + 2) + '`');
      i += 2;
    } else if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < body.length && depth) {
        if (body[i] === '`') {
          // A nested template: skip it whole.
          i++;
          let inner = 0;
          while (i < body.length && (body[i] !== '`' || inner)) {
            if (body[i] === '\\') i++;
            else if (body[i] === '$' && body[i + 1] === '{') inner++;
            else if (body[i] === '}' && inner) inner--;
            i++;
          }
        } else if (body[i] === '{') depth++;
        else if (body[i] === '}') depth--;
        i++;
      }
      out += '{}';
    } else out += body[i++];
  }
  return out;
}

function tag() {
  for (const file of SCRIPTS) {
    const full = path.join(root, file);
    const src = fs.readFileSync(full, 'utf8');
    const edits = [];
    literals(src, (kind, start, end) => {
      const text = src.slice(start, end);
      if (kind === '"' || !CJK.test(text)) return;
      if (kind === '`') {
        // Tag only if the Chinese is in this template's own text, not just in a nested one.
        if (src[start - 1] === 't' || !CJK.test(keyOf(text.slice(1, -1)))) return;
        edits.push([start, start, 't']);
      } else {
        const body = text.slice(1, -1);
        if (body.includes('`') || body.includes('${')) throw new Error(`${file}: cannot convert ${text}`);
        edits.push([start, end, 't`' + body.replace(/\\'/g, "'") + '`']);
      }
    });
    let out = src;
    for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + text + out.slice(end);
    if (edits.length && !/const t = window\.WallI18n\.t;/.test(out)) {
      out = out.replace("'use strict';\n", "'use strict';\n\n  const t = window.WallI18n.t;\n");
    }
    fs.writeFileSync(full, out);
    console.log(`${file}: ${edits.length} strings tagged`);
  }
}

function collect() {
  const keys = new Map(); // key -> where
  for (const file of SCRIPTS) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    literals(src, (kind, start, end) => {
      if (kind === '`' && src[start - 1] === 't' && !/[\w$]/.test(src[start - 2])) {
        const key = keyOf(src.slice(start + 1, end - 1));
        if (CJK.test(key)) keys.set(key, file);
      }
    });
  }
  // index.html: text between tags and the translated attributes.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  for (const match of html.matchAll(/>([^<>]+)</g)) {
    const text = match[1].trim().replace(/\s+/g, ' ');
    if (CJK.test(text)) keys.set(text, 'index.html');
  }
  for (const match of html.matchAll(/(?:title|placeholder|aria-label|data-suggest)="([^"]+)"/g)) {
    const text = match[1].trim().replace(/\s+/g, ' ');
    if (CJK.test(text)) keys.set(text, 'index.html');
  }
  return keys;
}

function check() {
  const keys = collect();
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js/i18n-en.js'), 'utf8'), sandbox);
  const table = sandbox.window.WallI18nEn || {};
  const missing = [...keys].filter(([key]) => !table[key]);
  const stale = Object.keys(table).filter((key) => !keys.has(key));
  const broken = Object.entries(table).filter(([key, value]) => (key.match(/\{\}/g) || []).length !== (value.match(/\{\}/g) || []).length);
  for (const [key, file] of missing) console.log(`MISSING (${file}): ${JSON.stringify(key)}`);
  for (const key of stale) console.log(`UNUSED: ${JSON.stringify(key)}`);
  for (const [key] of broken) console.log(`PLACEHOLDERS DIFFER: ${JSON.stringify(key)}`);
  console.log(`${keys.size} strings, ${missing.length} missing, ${stale.length} unused, ${broken.length} with mismatched placeholders`);
  process.exit(missing.length || broken.length ? 1 : 0);
}

if (process.argv.includes('--tag')) tag();
else check();
