import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { Worker } from 'node:worker_threads';
import { VERSION, normaliseRelPath, validateRelPath, idFor, assignIds, extractTitle, buildPortal, resolveId, verifyPortal, renderIndexHtml } from '../src/portal.mjs';

const BIN = new URL('../bin/shortlink-portal.mjs', import.meta.url);
async function run(...argv) {
  const worker = new Worker(BIN, { argv, stdout: true, stderr: true });
  const [[status], stdout, stderr] = await Promise.all([
    once(worker, 'exit'), text(worker.stdout), text(worker.stderr)
  ]);
  return { status, stdout, stderr };
}
const sha10 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 10);

function fixture(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(d, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return d;
}
const rm = (...ds) => ds.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
const readAll = (root, rel = '') => {
  const out = {};
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readAll(root, r)); else out[r] = fs.readFileSync(path.join(root, r)).toString('hex');
  }
  return out;
};
const SAMPLE = {
  'report.html': '<html><head><title>Q3 &amp; Q4 Report</title></head><body>hi</body></html>',
  'notes/メモ.md': '---\ntitle: 日本語のメモ\n---\n# ignored heading\n',
  'notes/plan.txt': '\n  Plan for launch\nsecond line',
  'docs/資料 1.pdf': '%PDF-1.4\n1 0 obj<</Title (Annual Summary)>>endobj',
  'skip.png': 'png',
  '.hidden/x.md': '# hidden'
};

test('idFor is the first 10 hex of sha256 of the normalised path', () => {
  assert.equal(VERSION, '1.0.0');
  assert.equal(idFor('a/b.html'), sha10('a/b.html'));
  assert.equal(idFor('.\\a\\b.html'), idFor('a/b.html'));
  assert.equal(idFor('./a//b.html'), idFor('a/b.html'));
  assert.equal(normaliseRelPath('メモ.md'), 'メモ.md'.normalize('NFC'));
  assert.equal(idFor('e\u0301.md'), idFor('\u00e9.md'));
  assert.match(idFor('x'), /^[0-9a-f]{10}$/);
});

test('validateRelPath rejects traversal, absolute paths, NUL and empty; accepts Japanese names', () => {
  for (const bad of ['../x.md', 'a/../../x.md', 'a\\..\\x.md', '/etc/x.md', '\\\\srv\\share\\x.md', 'C:\\x.md', 'a\0b.md', '', '  ']) assert.equal(validateRelPath(bad).ok, false, JSON.stringify(bad));
  assert.equal(validateRelPath('..hidden/x.md').ok, true);
  assert.equal(validateRelPath('資料/報告書.html').ok, true);
  assert.equal(validateRelPath('a/../x.md').ok, false);
});

test('assignIds extends colliding ids deterministically, independent of input order', () => {
  const fullHash = (p) => (p.startsWith('x') ? 'abcdef0123' + '4567' + 'f'.repeat(50) : 'abcdef0123' + '9999' + '0'.repeat(50));
  const a = assignIds(['y.md', 'x.md', 'z.md'], { fullHash });
  const b = assignIds(['z.md', 'y.md', 'x.md'], { fullHash });
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
  assert.equal(a.get('x.md'), 'abcdef0123');
  assert.equal(a.get('y.md'), 'abcdef012399');
  assert.equal(a.get('z.md'), 'abcdef01239999');
  assert.equal(new Set(a.values()).size, 3);
});

test('assignIds keeps ids unique even when paths normalise identically', () => {
  const m = assignIds(['e\u0301.md', '\u00e9.md']);
  assert.equal(new Set(m.values()).size, 2);
  assert.ok([...m.values()].every((v) => /^[0-9a-f]{10,64}$/.test(v)));
});

test('extractTitle: html title with entities, h1 fallback, markdown front-matter and heading, txt, pdf, file name', () => {
  assert.equal(extractTitle('<title>A &amp; B</title>', '.html', 'a.html'), 'A & B');
  assert.equal(extractTitle('<body><h1 class="x"><b>Hello</b> world</h1>', '.htm', 'a.htm'), 'Hello world');
  assert.equal(extractTitle('---\ntitle: "FM Title"\n---\n# H\n', '.md', 'a.md'), 'FM Title');
  assert.equal(extractTitle('```\n# not this\n```\n## Real [link](x) *heading*\n', '.md', 'a.md'), 'Real link heading');
  assert.equal(extractTitle('\n\n  First line  \nsecond', '.txt', 'a.txt'), 'First line');
  assert.equal(extractTitle('/Title (Annual Summary)', '.pdf', 'a.pdf'), 'Annual Summary');
  assert.equal(extractTitle('', '.pdf', 'dir/資料.pdf'), '資料');
});

test('build writes the tree; every emitted URL is pure ASCII even for Japanese file names', () => {
  const inD = fixture(SAMPLE); const outD = path.join(inD, '..', path.basename(inD) + '-out');
  try {
    const r = buildPortal(inD, outD);
    assert.equal(r.ok, true);
    assert.equal(r.count, 4);
    const man = JSON.parse(fs.readFileSync(path.join(outD, 'manifest.json'), 'utf8'));
    assert.equal(man.count, 4);
    assert.equal(man.ids[idFor('notes/メモ.md')].path, 'notes/メモ.md');
    assert.equal(man.ids[idFor('notes/メモ.md')].title, '日本語のメモ');
    assert.equal(man.ids[idFor('report.html')].title, 'Q3 & Q4 Report');
    assert.equal(man.ids[idFor('docs/資料 1.pdf')].title, 'Annual Summary');
    for (const [id, e] of Object.entries(man.ids)) {
      assert.match(e.route, /^m\/id\/[0-9a-f]{10}\.html$/);
      assert.ok(fs.existsSync(path.join(outD, ...e.route.split('/'))));
      assert.equal(e.route, `m/id/${id}.html`);
    }
    const files = readAll(outD);
    for (const [rel, hex] of Object.entries(files)) {
      assert.match(rel, /^[\x21-\x7e]+$/, `ASCII path ${rel}`);
      if (!rel.startsWith('m/f/')) assert.ok(!Buffer.from(hex, 'hex').some((b) => b > 127), `ASCII bytes ${rel}`);
    }
    const html = fs.readFileSync(path.join(outD, 'm', 'id', idFor('report.html') + '.html'), 'utf8');
    assert.equal(html, SAMPLE['report.html']);
    const stub = fs.readFileSync(path.join(outD, 'm', 'id', idFor('notes/plan.txt') + '.html'), 'utf8');
    assert.match(stub, /http-equiv="refresh" content="0; url=\.\.\/f\/[0-9a-f]{10}\.txt"/);
    assert.match(stub, /<a href="\.\.\/f\/[0-9a-f]{10}\.txt">/);
  } finally { rm(inD, outD); }
});

test('hidden dirs, unlisted extensions and the output dir inside the input dir are skipped', () => {
  const inD = fixture(SAMPLE);
  try {
    const outD = path.join(inD, 'site');
    buildPortal(inD, outD);
    const again = buildPortal(inD, outD);
    assert.equal(again.count, 4);
    assert.ok(!again.entries.some((e) => e.path.startsWith('site/') || e.path.includes('hidden') || e.ext === '.png'));
  } finally { rm(inD); }
  const in2 = fixture(SAMPLE);
  try { assert.equal(buildPortal(in2, path.join(in2, 'site2'), { extensions: ['md'] }).count, 1); } finally { rm(in2); }
});

test('index is self-contained, searchable, escapes titles and compiles as JavaScript', () => {
  const inD = fixture({ 'a.html': '<title>&lt;script&gt;alert(1)&lt;/script&gt; 日本語</title>', 'b.md': '# Beta\n' });
  const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-o-'));
  try {
    buildPortal(inD, outD, { title: 'My <Portal>' });
    const idx = fs.readFileSync(path.join(outD, 'index.html'), 'utf8');
    assert.doesNotMatch(idx, /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    assert.doesNotMatch(idx, /<link /i);
    assert.match(idx, /<input id="q" type="search"/);
    assert.match(idx, /<style>/);
    assert.match(idx, /name="viewport"/);
    assert.ok(!/<script>alert/.test(idx));
    assert.match(idx, /&lt;script&gt;alert\(1\)/);
    assert.match(idx, /&#x65e5;/);
    assert.match(idx, /My &lt;Portal&gt;/);
    const js = /<script>([\s\S]*)<\/script>/.exec(idx)[1];
    assert.doesNotThrow(() => new Function(js));
    assert.ok(idx.includes(`href="m/id/${idFor('b.md')}.html"`));
    assert.equal(verifyPortal(outD).ok, true);
  } finally { rm(inD, outD); }
});

test('build is deterministic across output directories', () => {
  const inD = fixture(SAMPLE); const o1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-a-')); const o2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-b-'));
  try {
    buildPortal(inD, o1); buildPortal(inD, o2);
    assert.deepEqual(readAll(o1), readAll(o2));
  } finally { rm(inD, o1, o2); }
});

test('html-mode redirect keeps the original under m/f and points a stub at it', () => {
  const inD = fixture({ 'a.html': '<title>A</title>' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-r-'));
  try {
    buildPortal(inD, outD, { htmlMode: 'redirect' });
    const id = idFor('a.html');
    assert.equal(fs.readFileSync(path.join(outD, 'm', 'f', id + '.html'), 'utf8'), '<title>A</title>');
    assert.match(fs.readFileSync(path.join(outD, 'm', 'id', id + '.html'), 'utf8'), /url=\.\.\/f\//);
    assert.equal(verifyPortal(outD).ok, true);
    assert.throws(() => buildPortal(inD, outD, { htmlMode: 'weird' }), RangeError);
  } finally { rm(inD, outD); }
});

test('collision between equal 10-hex ids is resolved in a real build', () => {
  const inD = fixture({ 'a.md': '# A', 'b.md': '# B' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-c-'));
  try {
    const r = buildPortal(inD, outD, { fullHash: (p) => 'aaaaaaaaaa' + crypto.createHash('sha256').update(p).digest('hex').slice(0, 20) });
    assert.deepEqual(r.entries.map((e) => e.id.length), [10, 12]);
    assert.equal(new Set(r.entries.map((e) => e.id)).size, 2);
    for (const e of r.entries) assert.ok(fs.existsSync(path.join(outD, ...e.route.split('/'))));
  } finally { rm(inD, outD); }
});

test('unsafe explicit paths are rejected and reported; safe ones still build', () => {
  const inD = fixture({ '\u00e9.md': '# ok' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-u-'));
  try {
    const r = buildPortal(inD, outD, { files: ['.\\e\u0301.md', '../evil.md', '/abs/x.md', './C:\\x.md', 'a/../b.md', 'nul\0.md'] });
    assert.equal(r.ok, false);
    assert.equal(r.count, 1);
    assert.equal(r.entries[0].path, '\u00e9.md');
    assert.deepEqual(r.skipped.map((s) => s.reason), ['parent_traversal', 'absolute_path', 'absolute_path', 'parent_traversal', 'nul_byte']);
  } finally { rm(inD, outD); }
});

test('symlinks that escape the input directory are rejected (skipped when the OS forbids symlinks)', (t) => {
  const inD = fixture({ 'ok.md': '# ok' }); const outside = fixture({ 'secret.md': '# secret' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-s-'));
  try {
    try { fs.symlinkSync(path.join(outside, 'secret.md'), path.join(inD, 'link.md')); } catch { t.skip('symlinks not permitted here'); return; }
    const r = buildPortal(inD, outD);
    assert.deepEqual(r.skipped, [{ path: 'link.md', reason: 'symlink_escape' }]);
    assert.deepEqual(r.entries.map((e) => e.path), ['ok.md']);
  } finally { rm(inD, outside, outD); }
});

test('resolveId accepts bare ids, file names, route paths and URLs; unknown ids give null', () => {
  const inD = fixture({ 'dir/x.md': '# X' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-i-'));
  try {
    buildPortal(inD, outD);
    const id = idFor('dir/x.md'); const mp = path.join(outD, 'manifest.json');
    for (const form of [id, `${id}.html`, `/m/id/${id}.html`, `https://example.com/m/id/${id}.html?x=1#top`, id.toUpperCase()]) assert.equal(resolveId(mp, form).path, 'dir/x.md', form);
    assert.equal(resolveId(mp, 'ffffffffff'), null);
    assert.equal(resolveId(mp, 'nope'), null);
  } finally { rm(inD, outD); }
});

test('verify detects tampering, missing routes and unlisted files', () => {
  const inD = fixture({ 'a.md': '# A', 'b.html': '<title>B</title>' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-v-'));
  try {
    buildPortal(inD, outD);
    assert.equal(verifyPortal(outD).ok, true);
    fs.appendFileSync(path.join(outD, 'm', 'id', idFor('b.html') + '.html'), 'x');
    fs.writeFileSync(path.join(outD, 'm', 'id', 'deadbeef00.html'), 'stray');
    fs.rmSync(path.join(outD, 'm', 'f', idFor('a.md') + '.md'));
    const codes = verifyPortal(outD).issues.map((i) => i.code).sort();
    assert.deepEqual(codes, ['file_missing', 'hash_mismatch', 'unlisted_file']);
    assert.equal(verifyPortal(path.join(outD, 'nope')).issues[0].code, 'manifest_missing');
  } finally { rm(inD, outD); }
});

test('rebuild prunes stale routes and payloads', () => {
  const inD = fixture({ 'old.md': '# Old', 'keep.md': '# Keep' });
  const outD = path.join(inD, 'site');
  try {
    const { entries } = buildPortal(inD, outD);
    const old = entries.find((e) => e.path === 'old.md');
    fs.unlinkSync(path.join(inD, 'old.md'));
    assert.deepEqual(buildPortal(inD, outD).entries.map((e) => e.path), ['keep.md']);
    assert.equal(fs.existsSync(path.join(outD, old.route)), false);
    assert.equal(fs.existsSync(path.join(outD, old.file)), false);
    assert.equal(verifyPortal(outD).ok, true);
  } finally { rm(inD); }
});

test('verify reports unlisted payloads and constructor.html', () => {
  const inD = fixture({ 'keep.md': '# Keep' });
  const outD = path.join(inD, 'site');
  try {
    buildPortal(inD, outD);
    fs.writeFileSync(path.join(outD, 'm', 'id', 'constructor.html'), 'stray');
    fs.writeFileSync(path.join(outD, 'm', 'f', `${idFor('keep.md')}.txt`), 'stray');
    const { issues } = verifyPortal(outD);
    assert.deepEqual(issues.map((i) => i.code), ['unlisted_file', 'unlisted_file']);
    assert.match(issues[0].message, /m\/id\/constructor\.html/);
    assert.match(issues[1].message, /m\/f\/.*\.txt/);
  } finally { rm(inD); }
});

test('non-empty output without a manifest requires force', async () => {
  const inD = fixture({ 'a.md': '# A', 'site/index.html': 'Existing index' });
  const outD = path.join(inD, 'site');
  try {
    assert.throws(() => buildPortal(inD, outD), /force/i);
    assert.equal(fs.readFileSync(path.join(outD, 'index.html'), 'utf8'), 'Existing index');
    assert.equal(buildPortal(inD, outD, { force: true }).count, 1);
    assert.equal(verifyPortal(outD).ok, true);
    fs.unlinkSync(path.join(outD, 'manifest.json'));
    assert.equal((await run('build', inD, outD, '--force')).status, 0);
  } finally { rm(inD); }
});

test('empty input builds a valid empty portal; invalid extension is rejected', () => {
  const inD = fixture({}); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e-'));
  try {
    const r = buildPortal(inD, outD);
    assert.equal(r.count, 0);
    assert.equal(verifyPortal(outD).ok, true);
    assert.match(renderIndexHtml([], {}), /0 \/ 0/);
    assert.throws(() => buildPortal(inD, outD, { extensions: ['.日本'] }), RangeError);
    assert.throws(() => buildPortal(inD, inD), /must differ/);
    assert.throws(() => buildPortal(path.join(inD, 'missing'), outD), /not found/);
  } finally { rm(inD, outD); }
});

test('CLI: help, version, usage errors', async () => {
  const h = await run('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /shortlink-portal/);
  assert.match(h.stdout, /--force/);
  assert.equal((await run('-h')).status, 0);
  assert.equal((await run('--version')).stdout.trim(), '1.0.0');
  assert.equal((await run()).status, 2);
  assert.equal((await run('bogus')).status, 2);
  assert.equal((await run('build', 'only-one')).status, 2);
  assert.equal((await run('build', 'a', 'b', '--nope')).status, 2);
  assert.equal((await run('build', path.join(os.tmpdir(), 'sp-missing-in'), path.join(os.tmpdir(), 'sp-x-out'))).status, 2);
  assert.equal((await run('verify', path.join(os.tmpdir(), 'sp-missing-out'))).status, 2);
});

test('CLI: build, resolve and verify end to end', async () => {
  const inD = fixture(SAMPLE); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cli-'));
  try {
    const b = await run('build', inD, outD, '--json', '--title', 'Docs');
    assert.equal(b.status, 0);
    const rep = JSON.parse(b.stdout);
    assert.equal(rep.count, 4);
    const id = idFor('notes/メモ.md');
    const mp = path.join(outD, 'manifest.json');
    const r = await run('resolve', mp, `/m/id/${id}.html`);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'notes/メモ.md');
    const miss = await run('resolve', mp, 'ffffffffff');
    assert.equal(miss.status, 1);
    assert.equal((await run('verify', outD)).status, 0);
    fs.appendFileSync(path.join(outD, 'm', 'f', id + '.md'), 'tamper');
    const v = await run('verify', outD, '--json');
    assert.equal(v.status, 1);
    assert.equal(JSON.parse(v.stdout).issues[0].code, 'hash_mismatch');
  } finally { rm(inD, outD); }
});

test('CLI: --list with unsafe entries exits 1; --html-mode and --ext are honoured', async () => {
  const inD = fixture({ 'ok.md': '# ok', 'p.html': '<title>P</title>' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-l-'));
  const listFile = path.join(outD, '..', path.basename(outD) + '.txt');
  try {
    fs.writeFileSync(listFile, 'ok.md\r\n../x.md\r\n');
    const r = await run('build', inD, outD, '--list', listFile);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /rejected: \.\.\/x\.md \(parent_traversal\)/);
    const r2 = await run('build', inD, outD, '--ext', '.html', '--html-mode', 'redirect', '--json');
    assert.equal(r2.status, 0);
    assert.equal(JSON.parse(r2.stdout).count, 1);
    assert.equal((await run('build', inD, outD, '--html-mode', 'weird')).status, 2);
  } finally { rm(inD, outD, listFile); }
});

test('a directory link (symlink or junction) pointing outside is not traversed', (t) => {
  const inD = fixture({ 'ok.md': '# ok' }); const outside = fixture({ 'secret.md': '# secret' }); const outD = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-j-'));
  try {
    try { fs.symlinkSync(outside, path.join(inD, 'linked'), 'junction'); } catch { t.skip('directory links not permitted here'); return; }
    const r = buildPortal(inD, outD);
    assert.deepEqual(r.entries.map((e) => e.path), ['ok.md']);
    assert.deepEqual(r.skipped, [{ path: 'linked', reason: 'symlink_dir' }]);
    const explicit = buildPortal(inD, outD, { files: ['linked/secret.md'] });
    assert.deepEqual(explicit.skipped, [{ path: 'linked/secret.md', reason: 'symlink_escape' }]);
    assert.equal(explicit.count, 0);
  } finally { fs.rmSync(path.join(inD, 'linked'), { recursive: false, force: true }); rm(inD, outside, outD); }
});

test('extractTitle reads Markdown front matter after a UTF-8 BOM', () => {
  assert.equal(extractTitle('\uFEFF---\ntitle: Front matter title\n---\n# Heading\n', '.md', 'note.md'), 'Front matter title');
});
