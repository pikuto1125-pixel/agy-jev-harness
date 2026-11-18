import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { VERSION, FAILURE_MODES, normaliseSignature, parseLog, lintLog, lintFile, renderMarkdown, renderJson, writeFileAtomic } from '../src/linter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'retro-lint.mjs');
const J = (o) => JSON.stringify(o);
async function run(...argv) {
  const worker = new Worker(BIN, { argv, stdout: true, stderr: true });
  const [[status], stdout, stderr] = await Promise.all([
    once(worker, 'exit'), text(worker.stdout), text(worker.stderr)
  ]);
  return { status, stdout, stderr };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));

const failEvent = (n) => J({ role: 'tool', type: 'tool_result', tool: 'npm', status: 'error', text: `Error: ENOENT no such file /work/dir${n}/a${n}.txt at line ${n * 11}` });

test('exports and version', () => {
  assert.equal(VERSION, '1.0.0');
  assert.deepEqual(FAILURE_MODES, ['repeat_failure', 'unverified_claim', 'guardrail_drift', 'scope_creep', 'tool_misuse']);
});

test('normaliseSignature strips numbers, paths, hashes and timestamps', () => {
  const a = normaliseSignature('Error: cannot open C:\\Us' + 'ers\\x\\proj\\a.txt (line 12) commit deadbeef1 at 2026-11-18T10:00:00Z');
  const b = normaliseSignature('Error: cannot open /ho' + 'me/y/other/b.txt (line 99) commit abc1234ff at 2026-01-01 03:04:05');
  assert.equal(a, b);
  assert.match(a, /<path>/);
  assert.match(a, /<hash>/);
});

test('parseLog handles JSONL, CRLF and BOM', () => {
  const text = '\uFEFF' + J({ role: 'assistant', type: 'message', text: 'hi' }) + '\r\n\r\n' + J({ role: 'tool', status: 'error', tool: 'x', text: 'boom' }) + '\r\n';
  const { events, jsonLines, textLines } = parseLog(text);
  assert.equal(events.length, 2);
  assert.equal(jsonLines, 2);
  assert.equal(textLines, 0);
  assert.equal(events[1].line, 3);
  assert.equal(events[1].failed, true);
});

test('parseLog handles Markdown role markers and free-form failures', () => {
  const md = ['# Session', '**User:** please run the tests', 'Assistant: running now', 'Tool: npm', 'Error: Cannot find module foo', '- exit code 2'].join('\n');
  const { events } = parseLog(md);
  const failures = events.filter((e) => e.failed);
  assert.deepEqual(failures.map((e) => e.line), [5, 6]);
  assert.equal(events.find((e) => e.line === 2).role, 'user');
});

test('invalid JSON-looking line becomes text with a warning', () => {
  const r = lintLog('{not json\nplain line');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /line 1/);
});

test('third failure of the same signature sets escalate:true with a reason and exact line', () => {
  const log = [failEvent(1), J({ role: 'assistant', text: 'retrying' }), failEvent(2), J({ role: 'assistant', text: 'retrying again' }), failEvent(3)].join('\n');
  const r = lintLog(log);
  assert.equal(r.escalate, true);
  assert.match(r.escalation_reason, /failed 3 times/);
  const f = r.findings.find((x) => x.mode === 'repeat_failure' && x.severity === 'high');
  assert.equal(f.line, 5);
  assert.equal(r.signatures[0].count, 3);
  assert.deepEqual(r.signatures[0].lines, [1, 3, 5]);
  assert.equal(r.ok, false);
});

test('two failures sit at the threshold: warn that the next attempt must escalate, escalate stays false', () => {
  const r = lintLog([failEvent(1), failEvent(2)].join('\n'));
  assert.equal(r.escalate, false);
  assert.equal(r.escalate_next, true);
  assert.equal(r.findings.filter((f) => f.mode === 'repeat_failure')[0].severity, 'medium');
});

test('escalation after the threshold failure acknowledges the signature', () => {
  const log = [failEvent(1), failEvent(2), J({ role: 'assistant', text: 'Escalating to the user: blocked on missing file' })].join('\n');
  const r = lintLog(log);
  assert.equal(r.escalate, false);
  assert.equal(r.escalate_next, false);
  assert.equal(r.findings.filter((f) => f.mode === 'repeat_failure').length, 0);
});

test('--threshold option changes the cut-off and is validated', () => {
  const log = [failEvent(1), failEvent(2), failEvent(3)].join('\n');
  assert.equal(lintLog(log, { threshold: 3 }).escalate, false);
  assert.equal(lintLog(log, { threshold: 1 }).escalate, true);
  assert.throws(() => lintLog(log, { threshold: 0 }), RangeError);
});

test('different failure signatures do not cluster', () => {
  const a = J({ role: 'tool', tool: 'npm', status: 'error', text: 'Error: ENOENT missing file' });
  const b = J({ role: 'tool', tool: 'git', status: 'error', text: 'fatal: not a repository' });
  const r = lintLog([a, b, a, b].join('\n'));
  assert.equal(r.escalate, false);
  assert.equal(r.signatures.length, 2);
});

test('unverified_claim: done after failure is high, done with no evidence is medium, done after passing test is clean', () => {
  const afterFail = lintLog([J({ role: 'tool', tool: 'npm', status: 'error', text: 'Error: x' }), J({ role: 'assistant', text: 'All done, fixed it.' })].join('\n'));
  assert.equal(afterFail.findings.find((f) => f.mode === 'unverified_claim').severity, 'high');
  const bare = lintLog(J({ role: 'assistant', text: 'The bug is fixed.' }));
  assert.equal(bare.findings.find((f) => f.mode === 'unverified_claim').severity, 'medium');
  const verified = lintLog([J({ role: 'tool', tool: 'npm', status: 'ok', exit_code: 0, text: '12 passed' }), J({ role: 'assistant', text: 'The bug is fixed.' })].join('\n'));
  assert.equal(verified.findings.filter((f) => f.mode === 'unverified_claim').length, 0);
});

test('unverified_claim ignores negations, user text and inline evidence', () => {
  const log = ['User: is it fixed?', 'Assistant: not fixed yet', 'Assistant: fixed (verified: npm test exit 0)'].join('\n');
  assert.equal(lintLog(log).findings.filter((f) => f.mode === 'unverified_claim').length, 0);
});

test('guardrail_drift flags hook bypass and force push but not prohibitions', () => {
  const bad = lintLog([J({ role: 'assistant', type: 'tool_call', tool: 'bash', input: { command: 'git commit --no-verify -m wip' } }), J({ role: 'assistant', type: 'tool_call', tool: 'bash', input: { command: 'git push origin main --force' } })].join('\n'));
  const modes = bad.findings.filter((f) => f.mode === 'guardrail_drift');
  assert.equal(modes.length, 2);
  assert.ok(modes.every((f) => f.severity === 'high'));
  const ok = lintLog('Assistant: we must never use --no-verify here');
  assert.equal(ok.findings.filter((f) => f.mode === 'guardrail_drift').length, 0);
});

test('scope_creep flags expansion phrases in English and Japanese', () => {
  const r = lintLog(['Assistant: fixing the typo. While I am at it I rewrote the parser.', 'Assistant: ついでに設定も整理した'].join('\n'));
  assert.equal(r.findings.filter((f) => f.mode === 'scope_creep').length, 2);
  assert.deepEqual(r.findings.filter((f) => f.mode === 'scope_creep').map((f) => f.line), [1, 2]);
});

test('tool_misuse flags usage errors and three identical consecutive calls', () => {
  const call = J({ role: 'assistant', type: 'tool_call', tool: 'grep', input: { q: 'x' } });
  const r = lintLog([J({ role: 'tool', tool: 'grep', status: 'error', text: 'unknown option --frobnicate' }), call, call, call].join('\n'));
  const lines = r.findings.filter((f) => f.mode === 'tool_misuse').map((f) => f.line);
  assert.deepEqual(lines, [1, 4]);
});

test('findings carry ids, recommendations and sorted line numbers; reports are deterministic', () => {
  const log = [failEvent(1), failEvent(2), failEvent(3), J({ role: 'assistant', text: 'Done, fixed.' })].join('\n');
  const a = lintLog(log, { source: 's.jsonl' });
  const b = lintLog(log, { source: 's.jsonl' });
  assert.equal(renderJson(a), renderJson(b));
  assert.equal(renderMarkdown(a), renderMarkdown(b));
  assert.ok(a.findings.every((f) => /^F\d{3}$/.test(f.id) && f.recommendation.length > 10));
  const lines = a.findings.map((f) => f.line);
  assert.deepEqual(lines, [...lines].sort((x, y) => x - y));
});

test('renderMarkdown contains verdict, summary and line numbers; empty log passes', () => {
  const r = lintLog([failEvent(1), failEvent(2), failEvent(3)].join('\n'));
  const md = renderMarkdown(r);
  assert.match(md, /Verdict: \*\*ESCALATE\*\*/);
  assert.match(md, /### repeat_failure/);
  assert.match(md, /line 3/);
  const empty = lintLog('');
  assert.equal(empty.ok, true);
  assert.match(renderMarkdown(empty), /PASS/);
});

test('Markdown renders log text and backticks as escaped literals', () => {
  const text = 'Error: <script> `sample`';
  const log = J({ role: 'tool', tool: 'check`name', status: 'error', text });
  const report = lintLog([log, log, log].join('\n'), { source: '<source> `log`' });
  const markdown = renderMarkdown(report);
  assert.doesNotMatch(markdown, /<script>|<source>|`/);
  assert.match(markdown, /&lt;script&gt; &#96;sample&#96;/);
  assert.match(markdown, /check&#96;name/);
  assert.equal(JSON.parse(renderJson(report)).findings[0].evidence, text);
});

test('lintFile reads Japanese text and writeFileAtomic leaves no temp file', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'ログ.md');
    fs.writeFileSync(f, 'アシスタント: 完了しました\r\n');
    const r = lintFile(f);
    assert.equal(r.source, 'ログ.md');
    assert.equal(r.findings.filter((x) => x.mode === 'unverified_claim').length, 1);
    const out = path.join(d, 'sub', 'r.json');
    writeFileAtomic(out, renderJson(r));
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).tool, 'retro-lint');
    assert.deepEqual(fs.readdirSync(path.join(d, 'sub')), ['r.json']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CLI: help, version, bad args, missing file', async () => {
  const h = await run('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /retro-lint/);
  assert.equal((await run('-h')).status, 0);
  const v = await run('--version');
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), '1.0.0');
  assert.equal((await run('--bogus')).status, 2);
  assert.equal((await run()).status, 2);
  assert.equal((await run('x.log', '--threshold', 'zero')).status, 2);
  const m = await run(path.join(os.tmpdir(), 'rl-does-not-exist.log'));
  assert.equal(m.status, 2);
  assert.match(m.stderr, /cannot read/);
});

test('CLI: exit 1 on escalation with json output, exit 0 on clean log, --out writes file', async () => {
  const d = tmp();
  try {
    const bad = path.join(d, 'bad.jsonl');
    fs.writeFileSync(bad, [failEvent(1), failEvent(2), failEvent(3)].join('\n'));
    const r = await run(bad, '--format', 'json');
    assert.equal(r.status, 1);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.escalate, true);
    const good = path.join(d, 'good.md');
    fs.writeFileSync(good, 'Assistant: reading the file\n');
    assert.equal((await run(good)).status, 0);
    const out = path.join(d, 'out.md');
    const w = await run(bad, '--out', out);
    assert.equal(w.status, 1);
    assert.match(fs.readFileSync(out, 'utf8'), /Retro failure lint report/);
    assert.equal((await run(bad, '--threshold', '5')).status, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
