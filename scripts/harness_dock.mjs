#!/usr/bin/env node
// harness_dock.mjs — keep an agent harness lean. Zero model calls: 0 tokens.
//
//   bloat-check [files...]   measure always-on rule files (lines / chars / ~tokens / duplicate lines / bullets)
//   dock add "<idea>"        park a harness improvement idea (secrets and personal paths are masked before saving)
//   dock list                show parked ideas and whether the weekly review is due
//   dock review              weekly: print parked ideas + bloat report, then stamp the review time
//   dock done <n>            drop idea number n after it has been applied (or rejected)
//
// Optional workflow: collect ideas in the dock while you work, apply them in one weekly sitting, and retire one
// rule for every rule you add. Files are read through the shared safe reader (credential locations are refused).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isMain, parseArgs, readTextFileSafe, redact, round3, stateDir } from './jev_client.mjs';

export const DEFAULT_LIMITS = { maxLines: 120, maxChars: 9000, maxTokens: 2600, dupWarn: 3 };
const REVIEW_INTERVAL_DAYS = 7;

/** Rough token estimate: ~4 chars per token for Latin text, ~1.6 for CJK. */
export function estimateTokens(text) {
  const s = String(text ?? '');
  const cjk = (s.match(/[぀-ヿ㐀-鿿＀-￯]/g) || []).length;
  return Math.ceil((s.length - cjk) / 4 + cjk / 1.6);
}

export function bloatCheckText(text, limits = DEFAULT_LIMITS) {
  const lines = String(text).split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim());
  const seen = new Map();
  for (const l of nonEmpty) {
    const k = l.trim().toLowerCase();
    if (k.length >= 12) seen.set(k, (seen.get(k) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n >= 2).map(([k, n]) => ({ line: k.slice(0, 60), count: n }));
  const tokens = estimateTokens(text);
  const issues = [];
  if (lines.length > limits.maxLines) issues.push(`lines ${lines.length} > ${limits.maxLines}`);
  if (text.length > limits.maxChars) issues.push(`chars ${text.length} > ${limits.maxChars}`);
  if (tokens > limits.maxTokens) issues.push(`~tokens ${tokens} > ${limits.maxTokens}`);
  if (duplicates.length >= limits.dupWarn) issues.push(`${duplicates.length} duplicated lines`);
  const bullets = nonEmpty.filter((l) => /^\s*(?:[-*]|\d+\.)\s/.test(l)).length;
  if (bullets > 60) issues.push(`${bullets} bullets: probably a changelog, not a rule`);
  return { lines: lines.length, chars: text.length, tokens, bullets, duplicates, issues, bloated: issues.length > 0 };
}

export function bloatCheckFiles(files, limits = DEFAULT_LIMITS) {
  const report = files.map((f) => {
    try {
      return { file: path.basename(String(f)), ...bloatCheckText(readTextFileSafe(f, { maxBytes: 2 * 1024 * 1024 }), limits) };
    } catch (err) {
      const reason = String(err?.message || '').startsWith('FORBIDDEN_SECRET_PATH') ? 'FORBIDDEN_SECRET_PATH' : 'UNREADABLE';
      return { file: path.basename(String(f)), error: reason, bloated: false, issues: [] };
    }
  });
  const totalTokens = report.reduce((s, r) => s + (r.tokens || 0), 0);
  return { totalTokens, bloated: report.some((r) => r.bloated), files: report };
}

/** Always-on files worth checking in a workspace. */
export function discoverRuleFiles(root = process.cwd()) {
  const cands = ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md', '.agents/rules', 'rules'];
  const out = [];
  for (const c of cands) {
    const p = path.join(root, c);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) if (f.endsWith('.md')) out.push(path.join(p, f));
    } else {
      out.push(p);
    }
  }
  return out;
}

// ───────────────────────── dock storage ─────────────────────────

const dockFile = (env) => path.join(stateDir(env), 'harness_dock.json');

export function loadDock(env = process.env) {
  try {
    const d = JSON.parse(fs.readFileSync(dockFile(env), 'utf8'));
    return { items: Array.isArray(d.items) ? d.items : [], lastReview: d.lastReview || null };
  } catch {
    return { items: [], lastReview: null };
  }
}

export function saveDock(dock, env = process.env) {
  atomicWriteFileSync(dockFile(env), JSON.stringify(dock, null, 2) + '\n');
}

export function dockAdd(idea, env = process.env, now = new Date()) {
  const text = redact(String(idea ?? '').trim()).slice(0, 400);
  if (!text) return { ok: false, reason: 'EMPTY_IDEA' };
  const dock = loadDock(env);
  if (dock.items.some((i) => i.text.toLowerCase() === text.toLowerCase())) return { ok: true, duplicate: true, count: dock.items.length };
  dock.items.push({ text, addedAt: now.toISOString() });
  saveDock(dock, env);
  return { ok: true, count: dock.items.length };
}

export function reviewDue(dock, now = new Date()) {
  if (!dock.lastReview) return dock.items.length > 0;
  return (now - new Date(dock.lastReview)) / 86_400_000 >= REVIEW_INTERVAL_DAYS;
}

export function dockReview(env = process.env, { files = discoverRuleFiles(), now = new Date(), stamp = true } = {}) {
  const dock = loadDock(env);
  const bloat = bloatCheckFiles(files);
  const result = {
    due: reviewDue(dock, now),
    parked: dock.items.map((i, n) => ({ n: n + 1, text: i.text, addedAt: i.addedAt })),
    bloat,
    advice: [
      'Apply parked ideas in one sitting; for every rule you add, retire one.',
      bloat.bloated ? 'Always-on rules are bloated: move detail into on-demand skills, delete duplicates.' : 'Always-on rules are within limits.',
    ],
  };
  if (stamp) {
    dock.lastReview = now.toISOString();
    saveDock(dock, env);
  }
  return result;
}

export function dockDone(n, env = process.env) {
  const dock = loadDock(env);
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= dock.items.length) return { ok: false, reason: 'NO_SUCH_ITEM' };
  const [gone] = dock.items.splice(i, 1);
  saveDock(dock, env);
  return { ok: true, removed: gone.text, count: dock.items.length };
}

// ───────────────────────── CLI ─────────────────────────

function main() {
  const args = parseArgs();
  const [cmd, sub, ...rest] = args._;
  let out;
  if (cmd === 'bloat-check') {
    const files = [sub, ...rest].filter(Boolean);
    out = bloatCheckFiles(files.length ? files : discoverRuleFiles());
    out.totalTokens = round3(out.totalTokens);
    process.exitCode = out.bloated ? 1 : 0;
  } else if (cmd === 'dock' && sub === 'add') out = dockAdd(rest.join(' '));
  else if (cmd === 'dock' && sub === 'list') out = { ...loadDock(), due: reviewDue(loadDock()) };
  else if (cmd === 'dock' && sub === 'review') out = dockReview();
  else if (cmd === 'dock' && sub === 'done') out = dockDone(rest[0]);
  else {
    console.error('usage: harness_dock.mjs bloat-check [files...] | dock add "<idea>" | dock list | dock review | dock done <n>');
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(out, null, 2));
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${redact(String(err?.message || err), 200)}`);
    process.exitCode = 1;
  }
}
