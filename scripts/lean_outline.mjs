#!/usr/bin/env node
// lean_outline.mjs — look inside a big file without reading it whole. Zero model calls: 0 tokens.
//
//   outline <file>             headings (markdown) or functions / classes (JS, TS, Python, Go, Rust, ...) with line numbers
//   slice   <file> <query>     only the section that matches: a heading / symbol whose name contains <query>, else the
//                              section around the first lines that contain it. <query> may be /regex/.
//
// Why: an agent that `read_file`s a 300 KB document to find one function burns the context that compaction later has to
// rescue. Outline first, then slice (or read with StartLine / EndLine). tool_guard.mjs asks before a whole-file read of a
// file over 120 KB in workspace mode and points here.
//
//   --max-lines N (slice window, default 80)   --context N (lines around a plain match, default 12)   --json

import path from 'node:path';
import { isMain, parseArgs, readTextFileSafe } from './jev_client.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const NOT_SYMBOLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'super']);

function kindOf(file) {
  const e = path.extname(String(file)).toLowerCase();
  if (['.md', '.markdown', '.mdx'].includes(e)) return 'markdown';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(e)) return 'js';
  if (['.py', '.pyw'].includes(e)) return 'python';
  if (['.go', '.rs', '.java', '.kt', '.cs', '.swift', '.php', '.rb', '.c', '.cc', '.cpp', '.h', '.hpp'].includes(e)) return 'generic';
  return 'text';
}

const JS_RULES = [
  [/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
  [/^(\s{2,})(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, 'method'],
];
const PY_RULES = [
  [/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'],
  [/^(\s*)class\s+([A-Za-z_]\w*)/, 'class'],
];
const GENERIC_RULES = [
  [/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'],
  [/^(\s*)(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/, 'type'],
  [/^(\s*)(?:public\s+|private\s+|protected\s+|static\s+|final\s+)+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws [\w, ]+)?\{?\s*$/, 'method'],
];

/** [{ line, level, kind, name }] in file order. Lines are 1-based. */
export function outlineText(text, file = '') {
  const lines = String(text).split(/\r?\n/);
  const kind = kindOf(file);
  const out = [];
  if (kind === 'markdown') {
    let fence = '';
    lines.forEach((l, i) => {
      const f = l.match(/^\s*(```+|~~~+)/);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = '';
        return;
      }
      if (fence) return;
      const h = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) out.push({ line: i + 1, level: h[1].length, kind: 'heading', name: h[2] });
    });
    return out;
  }
  const rules = kind === 'js' ? JS_RULES : kind === 'python' ? PY_RULES : kind === 'generic' ? GENERIC_RULES : [];
  lines.forEach((l, i) => {
    for (const [re, k] of rules) {
      const m = l.match(re);
      if (!m || NOT_SYMBOLS.has(m[2])) continue;
      out.push({ line: i + 1, level: 1 + Math.floor(m[1].replace(/\t/g, '    ').length / 2), kind: k, name: m[2] });
      break;
    }
  });
  return out;
}

export function renderOutline(entries, { total = 0, bytes = 0 } = {}) {
  const head = `${total} lines, ${(bytes / 1024).toFixed(1)} KB, ${entries.length} entries`;
  if (!entries.length) return `${head}\n(no headings / symbols recognised: use slice <file> <query> to search by text)`;
  return [head, ...entries.map((e) => `L${e.line}\t${'  '.repeat(Math.min(e.level - 1, 6))}${e.kind === 'heading' ? '#'.repeat(e.level) : e.kind} ${e.name}`)].join('\n');
}

function makeMatcher(query) {
  const q = String(query ?? '');
  const rx = q.match(/^\/(.+)\/([a-z]*)$/);
  if (rx) {
    try {
      const re = new RegExp(rx[1], rx[2].includes('i') ? rx[2] : `${rx[2]}i`);
      return (s) => re.test(s);
    } catch {
      /* fall through to substring */
    }
  }
  const low = q.toLowerCase();
  return (s) => s.toLowerCase().includes(low);
}

/** End line (1-based, inclusive) of the entry at index i. Markdown: next heading of the same or higher level. Code: next entry at the same or shallower level. */
function entryEnd(entries, i, totalLines) {
  const e = entries[i];
  for (let j = i + 1; j < entries.length; j++) if (entries[j].level <= e.level) return entries[j].line - 1;
  return totalLines;
}

/** Windows of a file that answer `query`. Each: { start, end, label, text }. At most `maxMatches`. */
export function sliceText(text, file, query, { maxLines = 80, context = 12, maxMatches = 3 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const entries = outlineText(text, file);
  const match = makeMatcher(query);
  const windows = [];
  const add = (start, end, label, focus = start) => {
    start = Math.max(1, start);
    end = Math.min(lines.length, Math.max(start, end));
    if (end - start + 1 > maxLines) {
      // too long: keep a window of maxLines that still contains the focus line
      start = Math.min(Math.max(start, focus - Math.floor(maxLines / 2)), end - maxLines + 1);
      end = start + maxLines - 1;
    }
    if (windows.some((w) => start <= w.end && end >= w.start)) return; // overlaps one already taken
    windows.push({ start, end, label, text: lines.slice(start - 1, end).map((l, k) => `${String(start + k).padStart(5)}  ${l}`).join('\n') });
  };
  // 1) a heading / symbol named like the query
  entries.forEach((e, i) => {
    if (windows.length < maxMatches && match(e.name)) add(e.line, entryEnd(entries, i, lines.length), `${e.kind} ${e.name}`);
  });
  // 2) only when no heading / symbol carries that name: the neighbourhood of the lines that contain it
  const byName = windows.length > 0;
  for (let n = 0; n < lines.length && !byName && windows.length < maxMatches; n++) {
    if (!match(lines[n])) continue;
    if (windows.some((w) => n + 1 >= w.start && n + 1 <= w.end)) continue;
    let k = -1;
    for (let i = 0; i < entries.length && entries[i].line <= n + 1; i++) k = i;
    if (k >= 0 && entryEnd(entries, k, lines.length) - entries[k].line < maxLines) add(entries[k].line, entryEnd(entries, k, lines.length), `${entries[k].kind} ${entries[k].name} (contains match at L${n + 1})`, n + 1);
    else add(n + 1 - context, n + 1 + context, `match at L${n + 1}`, n + 1);
  }
  return { totalLines: lines.length, windows };
}

function main() {
  const args = parseArgs();
  const [cmd, file, ...rest] = args._;
  if (!['outline', 'slice'].includes(cmd) || !file || (cmd === 'slice' && !rest.length)) {
    console.error('usage: lean_outline.mjs outline <file> | slice <file> <query> [--max-lines 80] [--context 12] [--json]');
    process.exitCode = 2;
    return;
  }
  const text = readTextFileSafe(String(file), { maxBytes: Number(args['max-bytes'] || MAX_BYTES) });
  const total = text.split(/\r?\n/).length;
  if (cmd === 'outline') {
    const entries = outlineText(text, file);
    if (args.json) console.log(JSON.stringify({ file: path.basename(file), lines: total, bytes: Buffer.byteLength(text), entries }, null, 2));
    else console.log(renderOutline(entries, { total, bytes: Buffer.byteLength(text) }));
    return;
  }
  const r = sliceText(text, file, rest.join(' '), { maxLines: Number(args['max-lines'] || 80), context: Number(args.context || 12) });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else if (!r.windows.length) {
    console.log(`no match for "${rest.join(' ')}" in ${total} lines`);
    process.exitCode = 1;
  } else console.log(r.windows.map((w) => `--- ${path.basename(file)}:${w.start}-${w.end} (${w.label})\n${w.text}`).join('\n\n'));
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${String(err?.message || err).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
