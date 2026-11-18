/**
 * cognitive-wiki-and-u-gate engine (single self-contained module, stdlib only).
 *
 * Exports: VERSION, DEFAULTS, lintWiki, scanUnverifiedClaims, scanPath,
 *          renderLintText, renderGateText
 */
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '1.0.0';
export const DEFAULTS = { maxEntryLines: 200, window: 1 };

const ENTRY_NAMES = ['index.md', 'readme.md', 'root.md'];
const SKIP_DIRS = new Set(['node' + '_' + 'modules']);
const TEXT_EXT = /\.(?:md|markdown|txt|html?)$/i;
const MAX_SCAN_LINE = 8192;
const posix = (p) => p.split(path.sep).join('/');

function walk(root, ignore = []) {
  const files = []; const dirs = new Set(['']);
  const rec = (abs, rel) => {
    const ents = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ignore.some((p) => r === p || r.startsWith(p.endsWith('/') ? p : p + '/'))) continue;
      if (e.isDirectory()) { dirs.add(r); rec(path.join(abs, e.name), r); } else if (e.isFile()) files.push(r);
    }
  };
  rec(root, '');
  return { files, dirs };
}

/** Return per-line {raw, masked, code}: fenced blocks flagged, inline code spans blanked. */
function maskLines(text) {
  let fence = '';
  return text.split(/\r?\n/).map((line) => {
    const raw = line.slice(0, MAX_SCAN_LINE);
    const m = /^\s{0,3}(```+|~~~+)/.exec(raw);
    if (m) {
      if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = '';
      return { raw, masked: '', code: true };
    }
    if (fence) return { raw, masked: '', code: true };
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)).slice(0, MAX_SCAN_LINE);
    return { raw, masked, code: false };
  });
}

function frontMatter(lines) {
  if (!lines.length || lines[0].raw.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (/^(?:---|\.\.\.)\s*$/.test(lines[i].raw)) return i + 1;
  return 0;
}

const splitRoles = (v) => v.replace(/^\[|\]$/g, '').split(/[,;|]/).map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase()).filter(Boolean);

function declaredRoles(lines) {
  const roles = []; const fmEnd = frontMatter(lines);
  for (let i = 1; i < fmEnd - 1; i++) {
    const m = /^(roles?)\s*:\s*(.*)$/i.exec(lines[i].raw);
    if (!m) continue;
    if (m[2].trim()) splitRoles(m[2]).forEach((r) => roles.push({ role: r, line: i + 1 }));
    else for (let j = i + 1; j < fmEnd - 1 && /^\s+-\s+/.test(lines[j].raw); j++) roles.push({ role: lines[j].raw.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '').toLowerCase(), line: j + 1 });
  }
  lines.forEach((l, i) => {
    if (i < fmEnd || l.code) return;
    const m = /^#{1,6}\s*role\s*:(.*)/i.exec(l.raw);
    if (m) splitRoles(m[1].trimEnd().replace(/(?<!#)#+$/, '').trim()).forEach((r) => roles.push({ role: r, line: i + 1 }));
  });
  return roles;
}

function resolveLink(from, target, fileSet, dirSet) {
  let t = target.trim().replace(/^<|>$/g, '');
  if (!/^<.*>$/.test(target.trim())) t = t.split(/\s+/)[0];
  if (!t || t[0] === '#' || /^[a-z][a-z0-9+.-]*:/i.test(t)) return { skip: true };
  t = t.replace(/[?#].*$/, '');
  try { t = decodeURIComponent(t); } catch { /* keep raw */ }
  if (!t) return { skip: true };
  const rel = path.posix.normalize(t[0] === '/' ? t.slice(1) : path.posix.join(path.posix.dirname(from), t)).replace(/\/$/, '');
  if (rel === '..' || rel.startsWith('../')) return { ok: false, reason: 'escapes the wiki root' };
  const cands = [rel, rel + '.md'];
  for (const c of cands) if (fileSet.has(c)) return { ok: true, file: c };
  if (rel === '.' || dirSet.has(rel)) {
    const base = rel === '.' ? '' : rel + '/';
    const hit = ENTRY_NAMES.map((n) => [...fileSet].find((f) => f.toLowerCase() === base + n)).find(Boolean);
    return hit ? { ok: true, file: hit } : { ok: true, file: null };
  }
  return { ok: false, reason: 'target does not exist' };
}

/**
 * Lint a Markdown wiki directory: 1 role per file, entrypoint length, broken links
 * (markdown + [[wikilinks]]) and orphans (not reachable from the root entrypoint).
 * @param {string} dir
 * @param {{maxEntryLines?: number, entry?: string, ignore?: string[]}} [opts]
 * @returns {{ok: boolean, dir: string, entry: string|null, files: number, findings: object[], counts: object}}
 */
export function lintWiki(dir, opts = {}) {
  const maxLines = opts.maxEntryLines ?? DEFAULTS.maxEntryLines;
  const { files, dirs } = walk(dir, opts.ignore);
  const fileSet = new Set(files);
  const md = files.filter((f) => /\.(?:md|markdown)$/i.test(f));
  const findings = [];
  const add = (rule, file, line, message) => findings.push({ rule, severity: 'error', file, line, message });
  const stems = new Map(); const noExt = new Map();
  for (const f of md) {
    const p = f.replace(/\.(?:md|markdown)$/i, '').toLowerCase();
    noExt.set(p, f);
    const s = p.split('/').pop();
    if (!stems.has(s)) stems.set(s, f);
  }
  let entry = opts.entry ? opts.entry.replace(/\\/g, '/') : null;
  if (!entry) for (const n of ENTRY_NAMES) { entry = md.find((f) => f.toLowerCase() === n) || null; if (entry) break; }
  if (!entry || !fileSet.has(entry)) { add('missing_entrypoint', '', 0, 'no root entrypoint (index.md, README.md or root.md) found'); entry = null; }
  const edges = new Map();
  for (const f of md) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '');
    const lines = maskLines(text);
    const out = new Set(); edges.set(f, out);
    const roles = declaredRoles(lines);
    const distinct = [...new Set(roles.map((r) => r.role))];
    if (distinct.length > 1) add('multi_role', f, roles.find((r) => r.role !== roles[0].role).line, `file declares ${distinct.length} roles (${distinct.join(', ')}); keep 1 role per file`);
    if (ENTRY_NAMES.includes(f.split('/').pop().toLowerCase())) {
      const n = text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
      if (n > maxLines) add('entrypoint_too_long', f, maxLines + 1, `entrypoint has ${n} lines (limit ${maxLines}); split detail into linked pages`);
    }
    lines.forEach((l, i) => {
      if (l.code) return;
      const targets = [];
      for (const m of l.masked.matchAll(/!?\[[^[\]]*\]\((\s*<[^<>]*>\s*|[^)]*)\)/g)) targets.push({ t: m[1], kind: 'link' });
      const ref = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(l.masked);
      if (ref) targets.push({ t: ref[1], kind: 'link' });
      for (const m of l.masked.matchAll(/\[\[([^\]\n]+)\]\]/g)) targets.push({ t: m[1], kind: 'wiki' });
      for (const { t, kind } of targets) {
        if (kind === 'link') {
          const r = resolveLink(f, t, fileSet, dirs);
          if (r.skip) continue;
          if (!r.ok) add('broken_link', f, i + 1, `broken link "${t.trim()}": ${r.reason}`);
          else if (r.file) out.add(r.file);
        } else {
          const name = t.split('|')[0].split('#')[0].trim().replace(/\\/g, '/').toLowerCase().replace(/\.md$/, '');
          if (!name) continue;
          const hit = name.includes('/') ? noExt.get(name) || [...noExt.entries()].find(([k]) => k.endsWith('/' + name))?.[1] : stems.get(name);
          if (!hit) add('broken_link', f, i + 1, `broken wikilink [[${t.trim()}]]: no page with that name`);
          else out.add(hit);
        }
      }
    });
  }
  if (entry) {
    const seen = new Set([entry]); const q = [entry];
    while (q.length) for (const n of edges.get(q.shift()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    for (const f of md) if (!seen.has(f)) add('orphan', f, 1, `not reachable from ${entry}; link it from an index or remove it`);
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : 1)));
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] || 0) + 1;
  return { ok: findings.length === 0, dir: posix(dir), entry, files: md.length, findings, counts };
}

const EVID = /https?:\/\/\S+|\]\([^)\s]+\)|\[(?:source|src|cite|ref)\s*:[^\]]*\]|\[\^[^\]]+\]|\bsource\s*:|\(source\b|出典/i;
const EVID_TAG = /\[est(?:imate)?\]|\[U\b[^\]]*\]/i;
const HEDGE = new RegExp("(?:\\b(?:about|around|approx(?:imately|\\.)?|roughly|nearly|almost|circa|up to|over|more than)\\b\\s*|~\\s*|約|およそ|ほぼ)(?:[$€£¥]\\s?(?<![\\d,.])\\d[\\d,.]*|(?<![\\d,.])\\d[\\d,.]*\\s?(?:%|x\\b|×|percent|times\\b|[kKmMbB]\\b|million|billion|倍|割|万|円|人|社|件)|(?<![\\d,.])\\d[\\d,.]*\\s?(?:ms|seconds?|minutes?|hours?|days?)\\s+(?:faster|slower|quicker|shorter|less|more)\\b)", 'i');
const STAT_RES = [
  /(?<![\d,.])\d[\d,.]*\s?%/, /[$€£¥]\s?\d[\d,.]*/, /(?<![\d,.])\b\d[\d,.]*\s?(?:USD|EUR|JPY|dollars|yen|euros)\b/i,
  /(?<![\d,.])\b\d[\d,.]*\s?[kKmM]?\+?\s+(?:users?|customers?|downloads?|installs?|subscribers?|companies|developers|teams|members|visitors|stars)\b/i,
  /(?<![\d,.])\d[\d,.]*\s?(?:万|千)?\s?(?:人|社|件|ユーザー|ダウンロード)|(?<![\d,.])\d[\d,.]*円/
];
const U_TOKEN = /\[U(?:\s*(?:→|->)[^\]]*|[:?][^\]]*)?\](?!\()/g;
const U_RESOLVED = /^\[U\s*(?:→|->)\s*verified\s*:\s*(\S[^\]]*)\]$/i;

/**
 * Scan text for unresolved [U] markers, bare estimates and unsourced stats.
 * `input` is document text by default. Pass `fromFile: true` to read a file.
 * @param {string} input
 * @param {{fromFile?: boolean, window?: number, includeCode?: boolean, file?: string}} [opts]
 * @returns {{ok: boolean, input: string, files: number, findings: object[], resolved: object[], counts: object}}
 */
export function scanUnverifiedClaims(input, opts = {}) {
  let text = String(input ?? ''); let file = opts.file ?? '';
  if (opts.fromFile === true) {
    file = file || text; text = fs.readFileSync(text, 'utf8');
  }
  const win = opts.window ?? DEFAULTS.window;
  const lines = maskLines(text.replace(/^\uFEFF/, ''));
  const findings = []; const resolved = [];
  const evidence = lines.map((l) => !l.code && EVID.test(l.masked));
  const add = (rule, i, col, snippet, message) => findings.push({ rule, severity: 'error', file: file ? posix(file) : '', line: i + 1, column: col + 1, text: snippet.trim().slice(0, 120), message });
  lines.forEach((l, i) => {
    if (l.code && !opts.includeCode) return;
    const src = l.code ? l.raw : l.masked;
    let hasU = false;
    for (const m of src.matchAll(U_TOKEN)) {
      hasU = true;
      const r = U_RESOLVED.exec(m[0]);
      if (r) { resolved.push({ file: file ? posix(file) : '', line: i + 1, source: r[1].trim() }); continue; }
      if (/→|->/.test(m[0])) add('bad_resolution', i, m.index, m[0], '[U] resolution must read [U→verified: <source>] with a non-empty source');
      else add('unresolved_u', i, m.index, m[0], 'unresolved [U] marker; verify it and replace with [U→verified: <source>] or remove the claim');
    }
    if (/^\s*\[[^\]]+\]:/.test(src)) return;
    if (hasU || EVID_TAG.test(src)) return;
    for (let j = Math.max(0, i - win); j <= Math.min(lines.length - 1, i + win); j++) if (evidence[j]) return;
    const h = HEDGE.exec(src);
    if (h) { add('bare_estimate', i, h.index, src.slice(h.index, h.index + 60), `estimate "${h[0].trim()}" is stated as fact; add a source link, [source: ...], or tag it [est] or [U]`); return; }
    for (const re of STAT_RES) {
      const s = re.exec(src);
      if (s) { add('unsourced_stat', i, s.index, src.slice(Math.max(0, s.index - 20), s.index + 40), `statistic "${s[0].trim()}" has no source nearby; add a link, [source: ...], or tag it [est] or [U]`); break; }
    }
  });
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] || 0) + 1;
  return { ok: findings.length === 0, input: file ? posix(file) : '(text)', files: 1, findings, resolved, counts };
}

/**
 * Run the gate over a file or a directory (text-like files: md, markdown, txt, html).
 * @param {string} target
 * @param {{window?: number, includeCode?: boolean, ignore?: string[]}} [opts]
 * @returns {{ok: boolean, input: string, files: number, findings: object[], resolved: object[], counts: object}}
 */
export function scanPath(target, opts = {}) {
  const st = fs.statSync(target);
  if (st.isFile()) return scanUnverifiedClaims(target, { ...opts, fromFile: true, file: path.basename(target) });
  const { files } = walk(target, opts.ignore);
  const all = { ok: true, input: posix(target), files: 0, findings: [], resolved: [], counts: {} };
  for (const f of files.filter((x) => TEXT_EXT.test(x))) {
    const r = scanUnverifiedClaims(path.join(target, f), { ...opts, fromFile: true, file: f });
    all.files++; all.findings.push(...r.findings); all.resolved.push(...r.resolved);
    for (const [k, v] of Object.entries(r.counts)) all.counts[k] = (all.counts[k] || 0) + v;
  }
  all.ok = all.findings.length === 0;
  return all;
}

const fmt = (f) => `${f.file || '-'}:${f.line}${f.column ? ':' + f.column : ''}  ${f.rule}  ${f.message}`;
/** Human-readable lint report. @param {object} r @returns {string} */
export function renderLintText(r) {
  const o = [`wiki lint: ${r.dir} (${r.files} pages, entry ${r.entry ?? 'none'})`];
  r.findings.forEach((f) => o.push(fmt(f)));
  o.push(r.ok ? 'PASS' : `FAIL: ${r.findings.length} finding(s) ${JSON.stringify(r.counts)}`);
  return o.join('\n') + '\n';
}
/** Human-readable U-gate report. @param {object} r @returns {string} */
export function renderGateText(r) {
  const o = [`u-gate: ${r.input} (${r.files} file(s))`];
  r.findings.forEach((f) => o.push(fmt(f)));
  if (r.resolved.length) o.push(`${r.resolved.length} [U] marker(s) resolved with a source`);
  o.push(r.ok ? 'PASS' : `FAIL: ${r.findings.length} finding(s) ${JSON.stringify(r.counts)}`);
  return o.join('\n') + '\n';
}
