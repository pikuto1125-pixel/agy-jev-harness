/**
 * retro-failure-linter engine (stdlib only).
 * Exports: VERSION, FAILURE_MODES, DEFAULT_THRESHOLD, normaliseSignature,
 *          parseLog, lintLog, lintFile, renderMarkdown, renderJson, writeFileAtomic
 */
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '1.0.0';
export const DEFAULT_THRESHOLD = 2;
export const FAILURE_MODES = ['repeat_failure', 'unverified_claim', 'guardrail_drift', 'scope_creep', 'tool_misuse'];

const FAIL_STATUS = new Set(['error', 'errored', 'failed', 'failure', 'fail', 'timeout', 'timed_out', 'denied', 'rejected', 'exception']);
const LINE_LIMIT = 4096;
const matchText = (s) => s.split('\n').map((l) => l.slice(0, LINE_LIMIT)).join('\n');
const OK_STATUS = new Set(['ok', 'success', 'succeeded', 'passed', 'pass', 'done', 'completed', 'complete']);
const STRONG_FAIL = /(?:\b[A-Za-z]*(?:Error|Exception)\b\s*:|\bTraceback\b|\bFAIL(?:ED)?\b|\bpanic:|\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*(?:[:=]\s*)?[1-9]\d*|\bcommand not found\b|\bpermission denied\b|\bENOENT\b|^\s*(?:[-*>]\s*)?(?:error|fatal)\b|[✗❌])/;
const WEAK_FAIL = /(?:\bfailed\b|\bfatal\b|\btimed? out\b|失敗|エラー)/i;
const FAIL_NEGATED = /\b0\s+(?:failed|failures|errors)\b|\bno\s+(?:errors|failures)\b|\bwithout\s+errors\b/i;
const TEXT_OK = /(?:\b\d+\s+passed\b|\ball\s+(?:\d+\s+)?(?:tests?\s+)?pass(?:ed|ing)?\b|\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*(?:[:=]\s*)?0\b|\b0\s+(?:failed|failures|errors)\b|[✓✔]|\bPASS(?:ED)?\b)/;
const ROLE_NAMES = '(user|human|assistant|ai|claude|system|developer|tool|function)';
const ROLE_LINE = new RegExp('^(?:\\*\\*|__)?' + ROLE_NAMES + '(?:\\*\\*|__)?\\s*[:\\uff1a]\\s*(?:\\*\\*|__)?\\s*', 'i');
const ROLE_HEAD = new RegExp('^#{1,6}\\s*' + ROLE_NAMES + '\\s*$', 'i');
const TOOL_RE = /\btool(?:_name)?\s*[:=]\s*`?([\w.-]+)|\[tool:\s*([\w.-]+)\]|\bRan\s+`([^`]+)`/i;

const CLAIM_RES = [
  /\ball (?:the )?(?:tests?|checks?|specs?) (?:now )?(?:pass|passed|passes|passing|green)\b/i,
  /\b(?:fixed|resolved|completed|finished|implemented|done|verified|confirmed|successfully)\b/i,
  /\bworks?\s+(?:now|correctly|as expected|fine)\b/i,
  /(?:完了|修正(?:し)?ました|直しました|解決|動作確認|テスト(?:は)?(?:全て|すべて)?(?:通過|成功|パス))/
];
const NEG_NEAR = /\b(?:not|n't|never|nothing|unable|cannot|can't|yet to|todo|to be|if|until|once|before|need to|should)\b\s*(?:\w+\s+){0,2}$|(?:未|まだ)\s*$/i;
const INLINE_EVIDENCE = /\((?:verified|evidence|ran|source)[^)]*\)|\bexit code 0\b|\b\d+ passed\b|\[U\]|\[est\]|\bunverified\b/i;
const GUARDS = [
  [/--no-verify\b/, 'high', 'skips git hooks (--no-verify)'],
  [/\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b|--force-with-lease)/, 'high', 'force push'],
  [/\brm\s+-(?:rf|fr)\b/, 'high', 'recursive force delete (rm -rf)'],
  [/\b(?:bypass\w*|disabl\w+|skip\w*|ignor\w+)\s+(?:the\s+|all\s+|any\s+)?(?:guard(?:rail)?s?|hooks?|lint(?:er|ing)?|tests?|checks?|review|rules?|polic(?:y|ies)|safety|sandbox|permissions?|confirmation)\b/i, 'medium', 'guardrail bypassed in prose']
];
const GUARD_NEG = /\b(?:never|don'?t|do not|must not|should not|shouldn'?t|avoid|forbidden|prohibited|not allowed|without)\b[^.\n]{0,30}$/i;
const SCOPE_RES = [
  /\b(?:while (?:i'?m|we'?re|i am) at it|let me also|i(?:'ll| will) also|as a bonus|unrelated (?:to|cleanup|change|refactor)|out of scope|beyond (?:the )?(?:scope|request|ask)|drive-by|also (?:refactor\w*|renam\w+|rewr\w+|reorganiz\w+|clean(?:ed)? up|upgrad\w+|migrat\w+))\b/i,
  /(?:ついでに|スコープ外|依頼(?:されていない|外))/
];
const MISUSE_RE = /(?:invalid (?:argument|parameter|option|flag|input|json)|unknown (?:option|flag|command|tool|argument)|unrecognized (?:option|argument)|no such tool|missing required|validation (?:error|failed)|unexpected (?:argument|keyword)|command not found|usage:|not recognized as an internal|permission denied|\bENOENT\b|\bEACCES\b|not a git repository|no such file or directory)/i;
const ESCALATE_RE = /\b(?:escalat\w*|hand(?:ing)?[ -]?off|need(?:s)? (?:human|your) (?:help|input|decision)|asking (?:the )?user|blocked|stopping here)\b|エスカレ|人間に確認|ユーザーに確認/i;

const RECOMMENDATIONS = {
  repeat_failure: 'Stop retrying. Escalate: say what was tried, paste the exact error, ask for a decision or change approach.',
  unverified_claim: 'Run the check that proves the claim and quote its output. If it cannot be checked, mark it [U].',
  guardrail_drift: 'Return to the guarded path. Do not bypass hooks, tests or review; ask the owner to change a blocking rule.',
  scope_creep: 'Park the extra change in a follow-up note. Finish what was asked, then propose the addition separately.',
  tool_misuse: 'Read the tool usage once, fix the arguments, and do not repeat an identical call.'
};

/** Strip variable parts of an error line so repeat failures cluster. */
export function normaliseSignature(s) {
  let t = String(s ?? '').slice(0, LINE_LIMIT).toLowerCase();
  t = t.replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?/g, '<ts>')
    .replace(/(?:[a-z]:)?[\\/][^\s'"`:,;)]+/g, '<path>')
    .replace(/\b[\w.-]+(?:[\\/][\w.-]+)+/g, '<path>')
    .replace(/\b[\w-]+\.(?:mjs|cjs|js|tsx|ts|jsx|py|md|json|jsonl|html|css|txt|ya?ml|toml|rs|go|java|cpp|c|h|sh)\b/g, '<file>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    .replace(/\b(?=[0-9a-f]{0,63}\d)[0-9a-f]{7,64}\b/g, '<hash>')
    .replace(/\d+(?:\.\d+)*/g, 'N')
    .replace(/\s+/g, ' ').trim();
  return t.slice(0, 120);
}

function normRole(r) {
  const x = String(r || '').toLowerCase();
  if (['human', 'user', 'customer'].includes(x)) return 'user';
  if (['assistant', 'ai', 'claude', 'model', 'agent'].includes(x)) return 'assistant';
  if (['system', 'developer'].includes(x)) return 'system';
  if (['tool', 'function'].includes(x)) return 'tool';
  return x;
}

function strOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : strOf(p && (p.text ?? p.content)))).filter(Boolean).join('\n');
  if (typeof v === 'object') return strOf(v.message ?? v.text ?? v.content) || JSON.stringify(v);
  return String(v);
}

function statusClass(st) {
  const s = String(st || '').toLowerCase();
  return FAIL_STATUS.has(s) ? 'fail' : OK_STATUS.has(s) ? 'ok' : '';
}

function failLine(text, weakAllowed) {
  text = matchText(text);
  if (!text || FAIL_NEGATED.test(text)) return false;
  return STRONG_FAIL.test(text) || (weakAllowed && WEAK_FAIL.test(text));
}

function jsonEvent(o, line) {
  const text = ['text', 'content', 'message', 'error', 'output', 'stderr', 'result'].map((k) => strOf(o[k])).find(Boolean) || '';
  const argsObj = o.input ?? o.args ?? o.arguments ?? o.params;
  const args = argsObj == null ? '' : typeof argsObj === 'string' ? argsObj : JSON.stringify(argsObj);
  const toolV = o.tool ?? o.tool_name ?? o.name ?? (o.function && o.function.name);
  const role = normRole(o.role ?? o.author ?? o.speaker);
  const type = String(o.type ?? o.event ?? o.kind ?? '').toLowerCase();
  let sc = statusClass(o.status);
  const code = o.exit_code ?? o.exitCode;
  if (!sc && typeof code === 'number') sc = code === 0 ? 'ok' : 'fail';
  if (!sc && (o.is_error === true || o.error)) sc = 'fail';
  if (!sc && type === 'error') sc = 'fail';
  const toolish = role === 'tool' || /result|output|tool/.test(type);
  if (!sc && toolish && role !== 'user' && failLine(text, true)) sc = 'fail';
  return { line, role, type, tool: typeof toolV === 'string' ? toolV : '', status: String(o.status ?? ''), text, args, failed: sc === 'fail', ok: sc === 'ok' };
}

/**
 * Parse JSONL and/or Markdown logs into events (JSON object per line, else text line).
 * @param {string} text
 * @returns {{events: object[], warnings: string[], jsonLines: number, textLines: number}}
 */
export function parseLog(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  const events = []; const warnings = [];
  let role = ''; let curTool = ''; let jsonLines = 0; let textLines = 0;
  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed[0] === '{') {
      try {
        const o = JSON.parse(trimmed);
        if (o && typeof o === 'object' && !Array.isArray(o)) { events.push(jsonEvent(o, line)); jsonLines++; return; }
      } catch { warnings.push(`line ${line}: looks like JSON but does not parse; treated as text`); }
    }
    textLines++;
    let body = trimmed.replace(/^[-*]\s+/, '').replace(/^>\s*/, '');
    let m = ROLE_HEAD.exec(body);
    if (m) { role = normRole(m[1]); return; }
    m = ROLE_LINE.exec(body);
    if (m) {
      role = normRole(m[1]); body = body.slice(m[0].length); curTool = '';
      if (role === 'tool') curTool = (/^[`\w.-]+/.exec(body) || [''])[0].replace(/`/g, '');
    }
    if (!body) return;
    const tm = TOOL_RE.exec(raw.slice(0, LINE_LIMIT));
    if (tm) curTool = tm[1] || tm[2] || tm[3];
    const tool = curTool;
    const failed = role !== 'user' && failLine(body, role !== 'assistant');
    const ok = !failed && role !== 'user' && role !== 'assistant' && TEXT_OK.test(body.slice(0, LINE_LIMIT));
    events.push({ line, role: role || 'unknown', type: 'text', tool: tool || '', status: failed ? 'error' : ok ? 'ok' : '', text: body, args: '', failed, ok });
  });
  return { events, warnings, jsonLines, textLines };
}

const clip = (s, n = 160) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const failureText = (ev) => {
  const ls = ev.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return ls.find((l) => failLine(l, true)) || ls[0] || ev.status || 'failure';
};

function firstUnnegated(res, text, negRe) {
  text = matchText(text);
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text))) {
      if (m[0] === '') { g.lastIndex++; continue; }
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (!negRe.test(before)) return m;
    }
  }
  return null;
}

/**
 * Lint a log text. escalate:true when one failure signature occurs more than `threshold` times.
 * @param {string} text
 * @param {{threshold?: number, source?: string}} [opts]
 * @returns {object} report
 */
export function lintLog(text, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError('threshold must be an integer >= 1');
  const { events, warnings, jsonLines, textLines } = parseLog(text);
  const findings = [];
  const add = (mode, severity, line, message, evidence, extra) => findings.push({ mode, severity, line, message, evidence: clip(evidence), recommendation: RECOMMENDATIONS[mode], ...extra });

  const sigs = new Map();
  events.forEach((ev, idx) => {
    if (!ev.failed) return;
    const sig = `${ev.tool || '-'}|${normaliseSignature(failureText(ev))}`;
    ev.sig = sig;
    if (!sigs.has(sig)) sigs.set(sig, { signature: sig, tool: ev.tool || '', count: 0, lines: [], idx: [] });
    const s = sigs.get(sig); s.count++; s.lines.push(ev.line); s.idx.push(idx);
  });
  const signatures = [];
  const escalationReasons = [];
  let escalate = false; let escalateNext = false;
  for (const s of sigs.values()) {
    const at = s.idx[threshold - 1];
    const upper = s.idx[threshold] ?? events.length;
    s.acknowledged = at !== undefined && events.slice(at + 1, upper).some((e) => e.role !== 'user' && ESCALATE_RE.test(e.text));
    signatures.push({ signature: s.signature, tool: s.tool, count: s.count, lines: s.lines, acknowledged: s.acknowledged });
    const ev = events[s.idx[s.idx.length - 1]];
    if (s.count > threshold) {
      escalate = true;
      const reason = `signature "${s.signature}" failed ${s.count} times (lines ${s.lines.join(', ')}); stop-after-${threshold}-failures rule required escalation before attempt ${threshold + 1}`;
      escalationReasons.push(reason);
      add('repeat_failure', 'high', s.lines[threshold], reason, failureText(ev), { signature: s.signature, count: s.count, escalate: true });
    } else if (s.count === threshold && !s.acknowledged) {
      escalateNext = true;
      add('repeat_failure', 'medium', s.lines[s.count - 1], `signature "${s.signature}" failed ${s.count} times (threshold ${threshold}); the next attempt must escalate`, failureText(ev), { signature: s.signature, count: s.count });
    }
  }

  const W = 8;
  const isClaim = (ev) => ev.role !== 'user' && ev.role !== 'system' && ev.role !== 'tool' && ev.type !== 'tool_call' && !ev.failed;
  events.forEach((ev, idx) => {
    if (!isClaim(ev) || !ev.text) return;
    const m = firstUnnegated(CLAIM_RES, ev.text, NEG_NEAR);
    if (!m || INLINE_EVIDENCE.test(matchText(ev.text))) return;
    ev.claim = true;
    let lastOk = -1; let lastFail = -1;
    for (let j = Math.max(0, idx - W); j < idx; j++) {
      if (events[j].ok && !events[j].claim) lastOk = j;
      if (events[j].failed) lastFail = j;
    }
    if (lastOk > lastFail) return;
    if (lastFail >= 0) add('unverified_claim', 'high', ev.line, `claim "${m[0]}" made after an unresolved failure at line ${events[lastFail].line} with no passing check in between`, ev.text);
    else add('unverified_claim', 'medium', ev.line, `claim "${m[0]}" has no passing check or tool result in the previous ${W} events`, ev.text);
  });

  events.forEach((ev) => {
    if (ev.role === 'user' || ev.role === 'system') return;
    const scan = `${ev.text}\n${ev.args}`;
    for (const [re, sev, label] of GUARDS) {
      const m = firstUnnegated([re], scan, GUARD_NEG);
      if (m) { add('guardrail_drift', sev, ev.line, `${label}: "${clip(m[0], 50)}"`, scan); break; }
    }
    if (ev.type !== 'tool_call' || !ev.args) {
      const m = firstUnnegated(SCOPE_RES, ev.text, /\b(?:not|never|don'?t)\b\s*$/i);
      if (m) add('scope_creep', 'medium', ev.line, `scope-expansion phrase: "${clip(m[0], 60)}"`, ev.text);
    }
  });

    let run = 0; let prevKey = '';
  events.forEach((ev) => {
    if (ev.failed && MISUSE_RE.test(ev.text)) add('tool_misuse', 'medium', ev.line, `tool error indicates misuse: "${clip((MISUSE_RE.exec(ev.text) || [''])[0], 60)}"`, ev.text);
    if (ev.type === 'tool_call' && ev.tool && ev.args) {
      const key = `${ev.tool}|${ev.args}`;
      run = key === prevKey ? run + 1 : 1; prevKey = key;
      if (run === 3) add('tool_misuse', 'medium', ev.line, `identical ${ev.tool} call issued 3 times in a row`, ev.args);
    }
  });

  const modeOrder = (m) => FAILURE_MODES.indexOf(m);
  findings.sort((a, b) => a.line - b.line || modeOrder(a.mode) - modeOrder(b.mode));
  findings.forEach((f, i) => { f.id = 'F' + String(i + 1).padStart(3, '0'); });
  const by_mode = Object.fromEntries(FAILURE_MODES.map((m) => [m, 0]));
  const by_severity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) { by_mode[f.mode]++; by_severity[f.severity]++; }
  const failures = events.filter((e) => e.failed).length;
  return {
    tool: 'retro-lint', version: VERSION, source: opts.source || '', threshold,
    format: jsonLines && textLines ? 'mixed' : jsonLines ? 'jsonl' : 'markdown',
    events: events.length, failures, escalate, escalate_next: escalateNext && !escalate,
    escalation_reason: escalationReasons.join(' | '),
    ok: !escalate && by_severity.high === 0,
    summary: { by_mode, by_severity }, signatures: signatures.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature)),
    findings, warnings
  };
}

/** Read a file and lint it. @param {string} file @param {object} [opts] @returns {object} */
export function lintFile(file, opts = {}) {
  const text = fs.readFileSync(file, 'utf8');
  return lintLog(text, { ...opts, source: opts.source ?? path.basename(file) });
}

/** Render the report as stable JSON text. @param {object} report @returns {string} */
export function renderJson(report) { return JSON.stringify(report, null, 2) + '\n'; }

/** Render the report as Markdown. @param {object} r report @returns {string} */
export function renderMarkdown(r) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/[&<>`\\|[\]()*_~!]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? `&#${c.charCodeAt(0)};`
  ));
  const verdict = r.escalate ? 'ESCALATE' : r.summary.by_severity.high ? 'FAIL (high findings)' : r.escalate_next ? 'WARN (next attempt must escalate)' : 'PASS';
  const o = ['# Retro failure lint report', '', `- Source: ${r.source ? safe(r.source) : '(stdin)'} (${r.format}), threshold ${r.threshold}`, `- Events: ${r.events}, failures: ${r.failures}`, `- Verdict: **${verdict}**`, `- escalate: ${r.escalate}`];
  if (r.escalation_reason) o.push(`- Reason: ${safe(r.escalation_reason)}`);
  o.push('', '## Summary', '', '| Mode | Findings |', '| --- | ---: |');
  for (const m of FAILURE_MODES) o.push(`| ${m} | ${r.summary.by_mode[m]} |`);
  if (r.signatures.length) {
    o.push('', '## Failure signatures', '', '| Count | Lines | Signature |', '| ---: | --- | --- |');
    for (const s of r.signatures) o.push(`| ${s.count} | ${s.lines.join(', ')} | <code>${safe(s.signature)}</code> |`);
  }
  o.push('', '## Findings', '');
  if (!r.findings.length) o.push('No findings.');
  for (const m of FAILURE_MODES) {
    const fs_ = r.findings.filter((f) => f.mode === m);
    if (!fs_.length) continue;
    o.push(`### ${m}`, '');
    for (const f of fs_) o.push(`- **${f.id}** [${f.severity}] line ${f.line}: ${safe(f.message)}`, `  - evidence: <code>${safe(f.evidence)}</code>`, `  - do: ${f.recommendation}`);
    o.push('');
  }
  if (r.warnings.length) o.push(...r.warnings.map((w) => `- warning: ${safe(w)}`));
  return o.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Write a file atomically (temp file + rename). @param {string} file @param {string} data */
export function writeFileAtomic(file, data) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
