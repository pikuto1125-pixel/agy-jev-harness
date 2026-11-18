import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { VERSION, lintWiki, scanUnverifiedClaims, scanPath, renderLintText, renderGateText } from '../src/wiki_ugate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'wiki-ugate.mjs');
async function run(...argv) {
  const worker = new Worker(BIN, { argv, stdout: true, stderr: true });
  const [[status], stdout, stderr] = await Promise.all([
    once(worker, 'exit'), text(worker.stdout), text(worker.stderr)
  ]);
  return { status, stdout, stderr };
}

function mkwiki(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(d, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return d;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const rules = (r) => r.findings.map((f) => f.rule);
const gate = scanUnverifiedClaims;

test('exports', () => {
  assert.equal(VERSION, '1.0.0');
  assert.equal(typeof lintWiki, 'function');
});

test('lint: a connected wiki with 1 role per file passes', () => {
  const d = mkwiki({
    'index.md': '# Index\n- [A](a.md)\n- [[b]]\n',
    'a.md': '---\nrole: reference\n---\nSee [[b]]\n',
    'b.md': '---\nrole: guide\n---\nBack to [index](index.md)\n'
  });
  try {
    const r = lintWiki(d);
    assert.deepEqual(r.findings, []);
    assert.equal(r.ok, true);
    assert.equal(r.entry, 'index.md');
    assert.equal(r.files, 3);
  } finally { rm(d); }
});

test('lint: multi_role from front-matter list and from heading, with line numbers', () => {
  const d = mkwiki({
    'README.md': '- [a](a.md)\n- [b](b.md)\n- [c](c.md)\n',
    'a.md': '---\nroles: [policy, runbook]\n---\n',
    'b.md': '---\nrole: guide\n---\n\n## Role: glossary\n',
    'c.md': '---\nrole: guide\n---\n\n## Role: Guide\n'
  });
  try {
    const r = lintWiki(d);
    const m = r.findings.filter((f) => f.rule === 'multi_role');
    assert.deepEqual(m.map((f) => [f.file, f.line]), [['a.md', 2], ['b.md', 5]]);
  } finally { rm(d); }
});

test('lint: entrypoint over 200 lines is flagged, exactly 200 is fine, limit is configurable', () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
  const d = mkwiki({ 'index.md': body(201), 'sub/README.md': body(200) });
  try {
    const r = lintWiki(d);
    const f = r.findings.filter((x) => x.rule === 'entrypoint_too_long');
    assert.equal(f.length, 1);
    assert.equal(f[0].file, 'index.md');
    assert.match(f[0].message, /201 lines/);
    assert.equal(lintWiki(d, { maxEntryLines: 300 }).findings.filter((x) => x.rule === 'entrypoint_too_long').length, 0);
  } finally { rm(d); }
});

test('lint: broken markdown links are flagged; external, anchor, image-existing and code links are ignored', () => {
  const d = mkwiki({
    'index.md': '[ok](a.md#top) [web](https://example.com/x) [mail](mailto:a' + '@example.com) [anchor](#here)\n[bad](missing.md)\n`[inline](nope.md)`\n```\n[fenced](nope2.md)\n```\n![pic](img/p.png)\n',
    'a.md': 'x\n',
    'img/p.png': 'png'
  });
  try {
    const r = lintWiki(d);
    assert.deepEqual(r.findings.map((f) => [f.rule, f.file, f.line]), [['broken_link', 'index.md', 2]]);
  } finally { rm(d); }
});

test('lint: wikilinks with alias and heading resolve; unknown wikilink is broken', () => {
  const d = mkwiki({
    'index.md': '[[Guide Page|the guide]] [[deep/topic#intro]] [[ghost]]\n',
    'Guide Page.md': 'x\n',
    'deep/topic.md': 'x\n'
  });
  try {
    const r = lintWiki(d);
    assert.deepEqual(r.findings.map((f) => [f.rule, f.line]), [['broken_link', 1]]);
    assert.match(r.findings[0].message, /ghost/);
  } finally { rm(d); }
});

test('lint: orphans are files unreachable from the entrypoint; transitive links count', () => {
  const d = mkwiki({
    'index.md': '[a](a.md)\n',
    'a.md': '[b](b.md)\n',
    'b.md': 'leaf\n',
    'lonely.md': 'nobody links here\n',
    'archive/old.md': 'old\n'
  });
  try {
    const r = lintWiki(d);
    assert.deepEqual(r.findings.filter((f) => f.rule === 'orphan').map((f) => f.file), ['archive/old.md', 'lonely.md']);
    const r2 = lintWiki(d, { ignore: ['archive'] });
    assert.deepEqual(r2.findings.filter((f) => f.rule === 'orphan').map((f) => f.file), ['lonely.md']);
  } finally { rm(d); }
});

test('lint: missing entrypoint is reported and orphan check is skipped', () => {
  const d = mkwiki({ 'a.md': 'x\n' });
  try {
    const r = lintWiki(d);
    assert.deepEqual(rules(r), ['missing_entrypoint']);
    assert.equal(r.entry, null);
  } finally { rm(d); }
});

test('lint: Japanese file names, percent-encoded links and CRLF work; output is deterministic', () => {
  const d = mkwiki({
    'index.md': '[手順](手順.md)\r\n[enc](%E8%A8%AD%E5%AE%9A.md)\r\n',
    '手順.md': '---\r\nrole: 手順\r\n---\r\n',
    '設定.md': '中身\r\n'
  });
  try {
    const a = lintWiki(d); const b = lintWiki(d);
    assert.deepEqual(a.findings, []);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.match(renderLintText(a), /PASS/);
  } finally { rm(d); }
});

test('ugate: unresolved [U] is blocked with line and column; resolved forms are allowed', () => {
  const r = gate('ok line\nThe API limit is 10 requests [U] per second.\nResolved [U→verified: vendor docs 2026] fine.\nAscii [U->verified: https://example.com/doc] fine.\n');
  assert.deepEqual(r.findings.map((f) => [f.rule, f.line, f.column]), [['unresolved_u', 2, 30]]);
  assert.equal(r.resolved.length, 2);
  assert.equal(r.resolved[0].source, 'vendor docs 2026');
  assert.equal(r.ok, false);
});

test('ugate: resolution marker without a source is rejected', () => {
  const r = gate('Claim [U→verified: ] here.\nClaim [U→verified] there.\n');
  assert.deepEqual(rules(r), ['bad_resolution', 'bad_resolution']);
});

test('ugate: bare estimates are flagged; tagged or sourced ones pass', () => {
  const bad = gate('This makes the build about 40% faster.\nRoughly $200 per month.\n');
  assert.deepEqual(rules(bad), ['bare_estimate', 'bare_estimate']);
  const good = gate('About 40% faster [est].\n\nRoughly $200 per month ([vendor pricing](https://example.com/p)).\n');
  assert.equal(good.ok, true);
  assert.equal(gate('Roughly 200 sec faster [source: bench-3].').ok, true);
});

test('ugate: unsourced percentages, dollar figures and user counts are flagged; nearby source clears them', () => {
  const bad = gate('Churn dropped 12.5% last year.\n\nPlans start at $49.\n\nWe have 5,000 users today.\n');
  assert.deepEqual(bad.findings.map((f) => [f.rule, f.line]), [['unsourced_stat', 1], ['unsourced_stat', 3], ['unsourced_stat', 5]]);
  const near = gate('Churn dropped 12.5% last year.\nSource: https://example.com/report\n');
  assert.equal(near.ok, true);
  const far = gate('Churn dropped 12.5% last year.\n\n\nhttps://example.com/report\n');
  assert.equal(far.ok, false);
  assert.equal(gate('Churn dropped 12.5%.\n\n\nhttps://example.com/r\n', { window: 3 }).ok, true);
});

test('ugate: Japanese estimates and counts are detected', () => {
  const r = gate('処理が約40%高速になった。\n\n利用者は 3000人 います。\n');
  assert.deepEqual(r.findings.map((f) => [f.rule, f.line]), [['bare_estimate', 1], ['unsourced_stat', 3]]);
});

test('ugate: fenced code and inline code are ignored unless includeCode', () => {
  const t = 'Use the `[U]` marker for open claims.\n```\nfoo [U] 50% $10\n```\nPlain text.\n';
  assert.equal(gate(t).ok, true);
  assert.equal(gate(t, { includeCode: true }).ok, false);
});

test('ugate: link syntax [U](url) is not a marker; plain numbers without units pass', () => {
  assert.equal(gate('[U](https://example.com) and version 1.0 with 12 files in 3 folders.').ok, true);
});

test('scanUnverifiedClaims reads an explicit file and scanPath aggregates a directory', () => {
  const d = mkwiki({ 'a.md': 'clean\n', 'sub/b.md': 'bad [U]\n', 'sub/c.txt': 'Up 30% since launch\n', 'sub/img.png': '[U]' });
  try {
    const one = scanUnverifiedClaims(path.join(d, 'sub', 'b.md'), { fromFile: true });
    assert.equal(one.findings[0].line, 1);
    const all = scanPath(d);
    assert.equal(all.files, 3);
    assert.deepEqual(all.findings.map((f) => `${f.file}:${f.rule}`), ['sub/b.md:unresolved_u', 'sub/c.txt:unsourced_stat']);
    assert.equal(all.counts.unresolved_u, 1);
    assert.match(renderGateText(all), /FAIL/);
  } finally { rm(d); }
});

test('a single-line string naming an existing file is scanned as literal text by default', () => {
  const d = mkwiki({ 'claim.md': 'Disk contents [U]\n' });
  try {
    const result = scanUnverifiedClaims(path.join(d, 'claim.md'));
    assert.equal(result.input, '(text)');
    assert.deepEqual(result.findings, []);
  } finally { rm(d); }
});

test('ugate: empty input and CRLF text are handled', () => {
  assert.equal(gate('').ok, true);
  const r = gate('line one\r\nclaim [U]\r\n');
  assert.equal(r.findings[0].line, 2);
});

test('CLI: help, version, usage errors', async () => {
  const h = await run('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /wiki-ugate/);
  assert.equal((await run('-h')).status, 0);
  assert.equal((await run('--version')).stdout.trim(), '1.0.0');
  assert.equal((await run()).status, 2);
  assert.equal((await run('frobnicate', 'x')).status, 2);
  assert.equal((await run('lint')).status, 2);
  assert.equal((await run('lint', path.join(os.tmpdir(), 'wu-does-not-exist'))).status, 2);
  assert.equal((await run('ugate', '.', '--bogus')).status, 2);
});

test('CLI: lint and ugate exit codes and --json output', async () => {
  const good = mkwiki({ 'index.md': '[a](a.md)\n', 'a.md': 'Nothing risky here.\n' });
  const bad = mkwiki({ 'index.md': 'Broken [x](nope.md) and claim [U] and 30% gain.\n' });
  try {
    assert.equal((await run('lint', good)).status, 0);
    assert.equal((await run('ugate', good)).status, 0);
    const l = await run('lint', bad, '--json');
    assert.equal(l.status, 1);
    assert.equal(JSON.parse(l.stdout).counts.broken_link, 1);
    const g = await run('ugate', path.join(bad, 'index.md'), '--json');
    assert.equal(g.status, 1);
    assert.deepEqual(JSON.parse(g.stdout).findings.map((f) => f.rule), ['unresolved_u']);
    assert.equal((await run('lint', path.join(bad, 'index.md'))).status, 2);
  } finally { rm(good); rm(bad); }
});

test('ugate: a [U] or [est] tag only covers its own line, a source link covers neighbouring lines', () => {
  const r = gate('Restarts are about 40% faster.\nWe serve 5,000 users [U].\n');
  assert.deepEqual(r.findings.map((f) => [f.rule, f.line]), [['bare_estimate', 1], ['unresolved_u', 2]]);
  assert.equal(gate('Restarts are about 40% faster.\nSee [benchmarks](https://example.com/b).\n').ok, true);
});

test('BOM Markdown preserves entrypoint roles and claim columns', () => {
  const d = mkwiki({ 'index.md': '\uFEFF# Role: index\n# Role: guide\n', 'claim.md': '\uFEFF[U] claim\n' });
  try {
    const r = lintWiki(d);
    assert.equal(r.entry, 'index.md');
    assert.equal(r.findings.find(f => f.rule === 'multi_role')?.file, 'index.md');
    const [claim] = scanPath(path.join(d, 'claim.md')).findings;
    assert.deepEqual([claim.rule, claim.line, claim.column], ['unresolved_u', 1, 1]);
  } finally { rm(d); }
});
