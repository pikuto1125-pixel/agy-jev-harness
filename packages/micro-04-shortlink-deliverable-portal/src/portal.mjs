/** Offline static shortlink portal builder. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = '1.0.0';
export const DEFAULT_EXTENSIONS = ['.html', '.htm', '.md', '.pdf', '.txt'];
const SKIP_DIRS = new Set(['node' + '_' + 'modules']);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MAX_TITLE_LINE = 4096;
const within = (root, file) => file === root || file.startsWith(path.join(root, path.sep));

/** Normalise a relative path: forward slashes, NFC, no leading "./", no duplicate slashes. @param {string} p @returns {string} */
export function normaliseRelPath(p) {
  return String(p).replace(/\\/g, '/').normalize('NFC').replace(/\/+/g, '/').replace(/^(?:\.\/)+/, '');
}

/**
 * Check a relative path is safe: no NUL, not absolute (posix, drive, UNC), no ".." segment, not empty.
 * @param {string} p
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateRelPath(p) {
  const s = String(p);
  if (s.includes('\0')) return { ok: false, reason: 'nul_byte' };
  if (!s.trim()) return { ok: false, reason: 'empty' };
  if (/^[\\/]/.test(s) || /^[A-Za-z]:/.test(s)) return { ok: false, reason: 'absolute_path' };
  if (s.split(/[\\/]+/).includes('..')) return { ok: false, reason: 'parent_traversal' };
  return { ok: true };
}

/** Default id: first 10 hex chars of sha256(normalised path). @param {string} relPath @returns {string} */
export function idFor(relPath) { return sha(Buffer.from(normaliseRelPath(relPath), 'utf8')).slice(0, 10); }

/**
 * Assign unique ids in code-point order; a path whose 10-hex id is taken
 * extends to 12, 14 ... hex chars of the same hash; if the whole hash is
 * taken (identical normalised paths) it rehashes `path#k`.
 * @param {string[]} paths
 * @param {{fullHash?: (p: string) => string}} [opts] fullHash returns a 64-hex string (override for tests)
 * @returns {Map<string, string>} path -> id
 */
export function assignIds(paths, opts = {}) {
  const full = opts.fullHash || ((p) => sha(Buffer.from(p, 'utf8')));
  const used = new Set(); const out = new Map();
  for (const p of [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const n = normaliseRelPath(p);
    for (let k = 0; !out.has(p); k++) {
      const h = full(k ? `${n}#${k}` : n);
      for (let len = 10; len <= h.length; len += 2) if (!used.has(h.slice(0, len))) { used.add(h.slice(0, len)); out.set(p, h.slice(0, len)); break; }
    }
  }
  return out;
}

const decodeEntities = (s) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/gi, (m, h, d, n) => {
  if (n) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[n.toLowerCase()];
  const c = h ? parseInt(h, 16) : Number(d);
  return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : '';
});
const tidy = (s) => decodeEntities(String(s).slice(0, MAX_TITLE_LINE).replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);

function tagText(text, open, close) {
  const m = open.exec(text);
  if (!m) return null;
  const body = text.slice(m.index + m[0].length);
  const end = body.search(close);
  return end < 0 ? null : body.slice(0, Math.min(end, MAX_TITLE_LINE));
}

/**
 * Extract a display title by extension (html: title/h1, md: front-matter title or first heading,
 * txt: first line, pdf: /Title entry), falling back to the file name without extension.
 * @param {string} text @param {string} ext @param {string} relPath @returns {string}
 */
export function extractTitle(text, ext, relPath) {
  const t = String(text).replace(/^\uFEFF/, ''); let r = '';
  if (/^\.html?$/i.test(ext)) {
    r = tidy(tagText(t, /<title\b[^<>]*>/i, /<\/title>/i) ?? tagText(t, /<h1\b[^<>]*>/i, /<\/h1>/i) ?? '');
  } else if (/^\.(?:md|markdown)$/i.test(ext)) {
    const lines = t.split(/\r?\n/).map((s) => s.slice(0, MAX_TITLE_LINE));
    const end = lines[0] === '---' ? lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l)) : -1;
    for (let i = 1; i < end && !r; i++) {
      const m = /^title\s*:\s*(.+)$/i.exec(lines[i]);
      if (m) r = tidy(m[1].replace(/^["']|["']$/g, ''));
    }
    let fence = false;
    for (let i = end + 1; i < lines.length && !r; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
      const h = !fence && /^#{1,6}\s+(.+)$/.exec(lines[i]);
      if (h) { r = tidy(h[1].trimEnd().replace(/(?<!#)#+$/, '').replace(/\[([^\[\]]*)\]\([^()]*\)/g, '$1').replace(/[*_`]/g, '')); break; }
    }
  } else if (/^\.pdf$/i.test(ext)) {
    const m = /\/Title\s*\(([^)]{1,200})\)/.exec(t); r = m ? tidy(m[1]) : '';
  } else r = tidy(t.split(/\r?\n/).find((l) => l.trim()) || '');
  return r || path.posix.basename(relPath).replace(/\.[^.]*$/, '');
}

/**
 * List deliverables under a directory (sorted; symlinked files must stay inside the root).
 * @param {string} inDir
 * @param {{extensions?: string[], skipDir?: string, files?: string[]}} [opts] `files` = explicit relative path list
 * @returns {{files: string[], skipped: {path: string, reason: string}[]}}
 */
export function scanInputs(inDir, opts = {}) {
  const exts = new Set((opts.extensions || DEFAULT_EXTENSIONS).map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase()));
  for (const x of exts) if (!/^\.[a-z0-9]{1,8}$/.test(x)) throw new RangeError(`unsupported extension: ${x}`);
  const root = fs.realpathSync(inDir); const files = []; const skipped = [];
  const inside = (abs) => { try { return within(root, fs.realpathSync(abs)); } catch { return false; } };
  const consider = (rel) => {
    const norm = normaliseRelPath(rel);
    const v = validateRelPath(norm);
    if (!v.ok) { skipped.push({ path: String(rel).replace(/\0/g, '\\0'), reason: v.reason }); return; }
    if (!exts.has(path.posix.extname(norm).toLowerCase())) return;
    const abs = path.join(inDir, ...norm.split('/'));
    if (!inside(abs)) { skipped.push({ path: norm, reason: fs.existsSync(abs) ? 'symlink_escape' : 'missing' }); return; }
    if (!fs.statSync(abs).isFile()) { skipped.push({ path: norm, reason: 'not_a_file' }); return; }
    files.push(norm);
  };
  if (opts.files) { opts.files.forEach(consider); return { files: [...new Set(files)].sort(), skipped }; }
  const rec = (rel) => {
    for (const e of fs.readdirSync(path.join(inDir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(inDir, r);
      if (opts.skipDir && path.resolve(abs) === opts.skipDir) continue;
      if (e.isDirectory()) rec(r);
      else if (e.isSymbolicLink() && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) skipped.push({ path: r, reason: 'symlink_dir' });
      else if (e.isFile() || e.isSymbolicLink()) consider(r);
    }
  };
  rec('');
  return { files: [...new Set(files)].sort(), skipped };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  .replace(/[^\x20-\x7e]/gu, (c) => (/[\t\n\r]/.test(c) ? ' ' : c.codePointAt(0) < 32 ? '' : `&#x${c.codePointAt(0).toString(16)};`));
const asciiJson = (o) => JSON.stringify(o, null, 2).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';

/** Redirect stub page (meta refresh + visible link). @param {{title: string}} e @param {string} target relative ASCII URL @returns {string} */
export function renderStub(e, target) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<meta http-equiv="refresh" content="0; url=${target}"><title>${esc(e.title)}</title></head>\n<body><p><a href="${target}">Open ${esc(e.title)}</a></p></body></html>\n`;
}

const CSS = ':root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--m:#5b6573;--b:#d6dbe1;--a:#0b5cad}@media(prefers-color-scheme:dark){:root{--bg:#14181d;--fg:#e8ecf1;--m:#9aa6b5;--b:#2b333d;--a:#6cb2ff}}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif}main{max-width:52rem;margin:auto;padding:1rem}h1{font-size:1.4rem}input,button{font:inherit;color:var(--fg);background:none;border:1px solid var(--b);border-radius:.5rem}#q{width:100%;box-sizing:border-box;padding:.7rem;background:var(--bg)}.bar{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0;align-items:center}button{padding:.2rem .6rem;cursor:pointer}[aria-pressed=true]{background:var(--a);color:var(--bg)}#n{margin-left:auto;color:var(--m)}ul{list-style:none;margin:0;padding:0}li{display:flex;gap:.6rem;align-items:center;border-bottom:1px solid var(--b);padding:.6rem 0}li a{flex:1;min-width:0;color:var(--a);text-decoration:none;word-break:break-word}.t{display:block;font-weight:600}.p{display:block;color:var(--m);font-size:.82rem}.b{font-size:.72rem;color:var(--m)}[hidden]{display:none!important}';
const JS = '(function(){var q=document.getElementById("q"),L=[].slice.call(document.querySelectorAll("#list li")),n=document.getElementById("n"),em=document.getElementById("empty"),X="",B=[].slice.call(document.querySelectorAll(".bar [data-x]"));function nm(s){s=String(s);return(s.normalize?s.normalize("NFKC"):s).toLowerCase()}function go(){var w=nm(q.value).split(/\\s+/).filter(Boolean),c=0;L.forEach(function(li){var ok=(!X||li.getAttribute("data-x")===X)&&w.every(function(t){return li.getAttribute("data-s").indexOf(t)>-1});li.hidden=!ok;if(ok)c++});n.textContent=c+" / "+L.length;em.hidden=c>0}q.addEventListener("input",go);B.forEach(function(b){b.onclick=function(){X=b.getAttribute("data-x");B.forEach(function(o){o.setAttribute("aria-pressed",o===b)});go()}});[].slice.call(document.querySelectorAll("li button")).forEach(function(b){b.onclick=function(){var u=new URL(b.getAttribute("data-u"),location.href).href;if(navigator.clipboard)navigator.clipboard.writeText(u);else prompt("Link",u)}});try{var p=new URLSearchParams(location.search).get("q");if(p)q.value=p}catch(e){}go()})();';

/** Searchable self-contained index page (inline CSS and JS, no external resources, pure ASCII). @param {object[]} entries @param {{title?: string}} [opts] @returns {string} */
export function renderIndexHtml(entries, opts = {}) {
  const title = opts.title || 'Deliverables';
  const exts = [...new Set(entries.map((e) => e.ext.slice(1).toLowerCase()))].sort();
  const rows = entries.map((e) => `<li data-x="${esc(e.ext.slice(1).toLowerCase())}" data-s="${esc(`${e.title} ${e.path} ${e.id}`.normalize('NFKC').toLowerCase())}"><a href="${e.route}"><span class="t">${esc(e.title)}</span><span class="p">${esc(e.path)}</span></a><span class="b">${esc(e.ext.slice(1).toUpperCase())}</span><button type="button" data-u="${e.route}">copy</button></li>`);
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>\n<style>${CSS}</style></head>\n<body><main><h1>${esc(title)}</h1>\n<input id="q" type="search" placeholder="Search title or path" aria-label="Search" autocomplete="off">\n<div class="bar"><button type="button" data-x="" aria-pressed="true">All</button>${exts.map((x) => `<button type="button" data-x="${esc(x)}" aria-pressed="false">${esc(x.toUpperCase())}</button>`).join('')}<span id="n">${entries.length} / ${entries.length}</span></div>\n<ul id="list">\n${rows.join('\n')}\n</ul>\n<p id="empty" hidden>No matches.</p></main>\n<script>${JS}</script></body></html>\n`;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { flag: 'wx' }); fs.renameSync(tmp, file);
}
const routeOf = (id) => `m/id/${id}.html`;
const fileOf = (id, ext) => `m/f/${id}${ext.toLowerCase()}`;
const publishDirs = ['m/id', 'm/f'];

/**
 * Build a portal. Copy HTML to its route by default and redirect other routes to their files.
 * @param {string} inDir @param {string} outDir
 * @param {{title?: string, extensions?: string[], htmlMode?: 'copy'|'redirect', files?: string[], fullHash?: Function, force?: boolean}} [opts]
 * @returns {{ok: boolean, count: number, entries: object[], skipped: object[], index: string, manifest: string}}
 */
export function buildPortal(inDir, outDir, opts = {}) {
  const inAbs = path.resolve(inDir); const outAbs = path.resolve(outDir);
  if (!fs.existsSync(inAbs) || !fs.statSync(inAbs).isDirectory()) throw new Error(`input directory not found: ${inDir}`);
  if (outAbs === inAbs) throw new Error('output directory must differ from the input directory');
  const outNames = fs.existsSync(outAbs) ? fs.readdirSync(outAbs) : [];
  const rebuild = outNames.includes('manifest.json');
  if (outNames.length && !rebuild && opts.force !== true) throw new Error('non-empty output directory has no manifest.json; use --force to overwrite');
  for (const dir of ['m', ...publishDirs]) {
    const st = fs.lstatSync(path.join(outAbs, dir), { throwIfNoEntry: false });
    if (st && !st.isDirectory()) throw new Error(`output path must be a directory: ${dir}`);
  }
  const mode = opts.htmlMode || 'copy';
  if (mode !== 'copy' && mode !== 'redirect') throw new RangeError('htmlMode must be copy or redirect');
  const { files, skipped } = scanInputs(inAbs, { extensions: opts.extensions, files: opts.files, skipDir: outAbs });
  const ids = assignIds(files, { fullHash: opts.fullHash });
  const entries = []; const buffers = new Map();
  const inputRoot = fs.realpathSync(inAbs);
  for (const rel of files) {
    const real = fs.realpathSync(path.join(inAbs, ...rel.split('/')));
    if (!within(inputRoot, real)) { skipped.push({ path: rel, reason: 'symlink_escape' }); continue; }
    const buf = fs.readFileSync(real);
    const ext = path.posix.extname(rel).toLowerCase(); const id = ids.get(rel);
    const title = extractTitle(buf.subarray(0, 262144).toString(/^\.pdf$/.test(ext) ? 'latin1' : 'utf8'), ext, rel);
    entries.push({ id, path: rel, title, ext, bytes: buf.length, sha256: sha(buf), route: routeOf(id), file: /^\.html?$/.test(ext) && mode === 'copy' ? null : fileOf(id, ext) });
    buffers.set(id, buf);
  }
  for (const e of entries) {
    const buf = buffers.get(e.id);
    if (!e.file) writeAtomic(path.join(outAbs, ...e.route.split('/')), buf);
    else {
      writeAtomic(path.join(outAbs, ...e.file.split('/')), buf);
      writeAtomic(path.join(outAbs, ...e.route.split('/')), renderStub(e, `../f/${e.id}${e.ext}`));
    }
  }
  if (rebuild) {
    const keep = new Set(entries.flatMap((e) => [e.route, e.file]));
    for (const dir of publishDirs) {
      const abs = path.join(outAbs, dir);
      if (!fs.existsSync(abs)) continue;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!e.isDirectory() && !keep.has(`${dir}/${e.name}`)) fs.unlinkSync(path.join(abs, e.name));
      }
    }
  }
  writeAtomic(path.join(outAbs, 'index.html'), renderIndexHtml(entries, { title: opts.title }));
  const ordered = Object.fromEntries(entries.map(({ id, ...entry }) => [id, entry]));
  writeAtomic(path.join(outAbs, 'manifest.json'), asciiJson({ version: 1, generator: `shortlink-deliverable-portal ${VERSION}`, htmlMode: mode, count: entries.length, ids: ordered }));
  return { ok: skipped.length === 0, count: entries.length, entries, skipped, index: 'index.html', manifest: 'manifest.json' };
}

/**
 * Resolve an id (bare hex, "<hex>.html", "/m/id/<hex>.html" or a URL ending in it) to its manifest entry.
 * @param {string|object} manifest path to manifest.json or the parsed object
 * @param {string} id
 * @returns {{id: string, path: string, title: string, route: string}|null}
 */
export function resolveId(manifest, id) {
  const m = typeof manifest === 'string' ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : manifest;
  const k = /([0-9a-f]{10,64})(?:\.html)?\s*$/i.exec(String(id).split(/[?#]/)[0]);
  const key = k?.[1].toLowerCase();
  const ids = m?.ids;
  const e = key && ids && Object.hasOwn(ids, key) && ids[key];
  return e ? { id: key, ...e } : null;
}

/**
 * Verify manifest entries, published files, and the index.
 * @param {string} outDir
 * @returns {{ok: boolean, count: number, issues: object[]}}
 */
export function verifyPortal(outDir) {
  const issues = []; const bad = (code, message, id) => issues.push(id ? { code, id, message } : { code, message });
  const rd = (rel) => { try { return fs.readFileSync(path.join(outDir, ...rel.split('/'))); } catch { return null; } };
  const mb = rd('manifest.json'); let man = null;
  if (!mb) { bad('manifest_missing', 'manifest.json not found'); return { ok: false, count: 0, issues }; }
  try { man = JSON.parse(mb.toString('utf8')); } catch { bad('manifest_invalid', 'manifest.json is invalid JSON'); return { ok: false, count: 0, issues }; }
  const ids = man?.ids && typeof man.ids === 'object' ? man.ids : {};
  const listed = new Set();
  const index = rd('index.html'); const indexText = index ? index.toString('latin1') : '';
  if (!index) bad('index_missing', 'index.html not found');
  else {
    if (/[\x80-\xff]/.test(indexText)) bad('index_not_ascii', 'index.html is not pure ASCII');
    if (/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(indexText)) bad('index_external_ref', 'index.html has an external reference');
  }
  for (const [id, e] of Object.entries(ids)) {
    if (!/^[0-9a-f]{10,64}$/.test(id)) { bad('bad_id', 'id is not 10-64 lowercase hex chars', id); continue; }
    const nid = normaliseRelPath(e?.path ?? '');
    if (!validateRelPath(nid).ok) { bad('unsafe_path', `manifest path is unsafe: ${e?.path}`, id); continue; }
    if (id.length === 10 && id !== idFor(nid)) bad('id_mismatch', 'id differs from sha256 of the path', id);
    listed.add(routeOf(id));
    const validFile = typeof e.ext === 'string' && /^\.[a-z0-9]{1,8}$/.test(e.ext) && e.file === fileOf(id, e.ext);
    if (validFile) listed.add(e.file);
    if (e.route !== routeOf(id)) bad('bad_route', `route must be ${routeOf(id)}`, id);
    if (e.route && !/^[\x21-\x7e]+$/.test(e.route)) bad('non_ascii_url', 'route is not pure ASCII', id);
    const page = rd(routeOf(id));
    if (!page) { bad('route_missing', `${routeOf(id)} not found`, id); continue; }
    if (e.file) {
      if (!validFile) { bad('bad_file', 'file must be m/f/<id><ext>', id); continue; }
      const f = rd(e.file);
      if (!f) bad('file_missing', `${e.file} not found`, id); else if (sha(f) !== e.sha256) bad('hash_mismatch', `${e.file} differs from the recorded sha256`, id);
      if (!page.toString('latin1').includes(`../f/${id}`)) bad('stub_target', 'stub does not point at its file', id);
    } else if (sha(page) !== e.sha256) bad('hash_mismatch', `${routeOf(id)} differs from the recorded sha256`, id);
    if (index && !indexText.includes(`href="${e.route}"`)) bad('not_in_index', 'route missing from index.html', id);
  }
  for (const dir of publishDirs) {
    let names;
    try { names = fs.readdirSync(path.join(outDir, dir)); } catch { continue; }
    for (const name of names.sort()) {
      const rel = `${dir}/${name}`;
      if (!listed.has(rel)) bad('unlisted_file', `${rel} not in the manifest`);
    }
  }
  const count = Object.keys(ids).length;
  if (man?.count !== count) bad('count_mismatch', `manifest count ${man?.count} != ${count} entries`);
  return { ok: issues.length === 0, count, issues };
}
