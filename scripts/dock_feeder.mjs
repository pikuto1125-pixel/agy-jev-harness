#!/usr/bin/env node
// dock_feeder.mjs — feeds the weekly Harness Dock. Zero model calls: 0 tokens.
//
// Discipline: WEEKDAY HARNESS FREEZE + WEEKLY DOCK MAINTENANCE. Monday to Friday the harness is not edited: whatever annoys
// you goes into harness_dock/BACKLOG.md as one line. On the dock day (default saturday; "dockDay" in sessions_keep.json) the
// harness_dock desk reads this digest, applies the backlog in ONE sitting, and retires one rule for every rule it adds.
//
// The digest folds together what the local telemetry saw in the last 7 days:
//   guard_events.jsonl       which command-guard rules fired, and how often
//   eval_history.jsonl       evaluator runs: pass / fail / cannot_judge, assay_invalid
//   compaction_events.jsonl  compaction rescues
//   bloat_guard              always-on prompt size, skill count, hooks health
//   harness_dock/BACKLOG.md  open "- [ ]" items
//
//   node dock_feeder.mjs digest [--root <workspace>] [--days 7] [--out <file>] [--stdout]
//   node dock_feeder.mjs status [--root <workspace>]          freeze state + counts, writes nothing
//
// A previous WEEKLY_DIGEST.md is copied to _backups/ before it is replaced (nothing is silently overwritten).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isMain, parseArgs } from './jev_client.mjs';
import { measure } from './bloat_guard.mjs';
import { readEvents } from './telemetry.mjs';
import { findWorkspaceRoot, loadSessionsKeep } from './workspace.mjs';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DIGEST_REL = path.join('harness_dock', 'WEEKLY_DIGEST.md');
export const BACKLOG_REL = path.join('harness_dock', 'BACKLOG.md');

const tally = (items, key) => {
  const o = {};
  for (const i of items) o[key(i)] = (o[key(i)] || 0) + 1;
  return o;
};
const top = (o, n = 4) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

/** Open and done "- [ ]" / "- [x]" items of BACKLOG.md. */
export function parseBacklog(text) {
  const open = [];
  let done = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === ' ') open.push(m[2]);
    else done++;
  }
  return { open, done };
}

export function freezeState({ dockDay = 'sat', now = new Date() } = {}) {
  const day = DAYS.includes(String(dockDay).toLowerCase().slice(0, 3)) ? String(dockDay).toLowerCase().slice(0, 3) : 'sat';
  const today = DAYS[now.getDay()];
  return { dockDay: day, today, freeze: today === day ? 'OFF (dock day: apply the backlog now)' : 'ON (park ideas in BACKLOG.md, do not edit the harness)', dockDayToday: today === day };
}

/** Everything the digest says, as data. */
export function collect({ root, env = process.env, days = 7, now = new Date(), stateDir = '' } = {}) {
  const sinceMs = now.getTime() - days * 86_400_000;
  const ws = root ? loadSessionsKeep(root) : null;
  const guard = readEvents('guard', { env, dir: stateDir, sinceMs });
  const evals = readEvents('eval', { env, dir: stateDir, sinceMs });
  const compaction = readEvents('compaction', { env, dir: stateDir, sinceMs });
  let backlogText = '';
  try {
    backlogText = fs.readFileSync(path.join(root, BACKLOG_REL), 'utf8');
  } catch {
    /* no backlog yet */
  }
  const backlog = parseBacklog(backlogText);
  const bloat = root ? measure(root) : null;
  const byRule = tally(guard, (e) => e.rule || 'unknown');
  const byStatus = tally(evals, (e) => e.status || 'unknown');
  const byPack = tally(evals.filter((e) => e.status !== 'pass'), (e) => e.pack || 'unknown');
  return {
    since: new Date(sinceMs).toISOString().slice(0, 10),
    until: now.toISOString().slice(0, 10),
    freeze: freezeState({ dockDay: ws?.ok ? ws.data.dockDay : 'sat', now }),
    guard: { total: guard.length, byRule },
    eval: { total: evals.length, byStatus, notPassingByPack: byPack, assayInvalid: evals.filter((e) => e.assayValid === false).length },
    compaction: { rescues: compaction.filter((e) => e.kind === 'rescue').length, capsules: compaction.filter((e) => e.rescued).length },
    bloat: bloat && { status: bloat.status, chars: bloat.prompt.totalChars, budget: bloat.prompt.budget, skills: bloat.skills.count, skillCap: bloat.skills.cap, hooks: bloat.hooks.present ? bloat.hooks.status : 'none', reasons: bloat.reasons },
    backlog,
  };
}

export function suggestions(d) {
  const s = [];
  if (d.bloat?.status === 'RED_BLOAT') s.push('Always-on prompt / skills are over budget: retire or merge before adding anything.');
  else if (d.bloat?.status === 'YELLOW_WATCH') s.push('Always-on prompt is near its ceiling: every new rule must retire an old one.');
  for (const [rule, n] of top(d.guard.byRule)) if (n >= 3) s.push(`Command-guard rule "${rule}" fired ${n}x: is the habit worth fixing (or the rule worth narrowing)?`);
  if (d.eval.assayInvalid) s.push(`${d.eval.assayInvalid} evaluator run(s) failed the assay: the rubric cannot tell its gold anchor from its near-miss. Rewrite the anchors or the questions before trusting any score.`);
  const cj = d.eval.byStatus.cannot_judge || 0;
  if (cj >= 3) s.push(`${cj} evaluator runs were cannot_judge: check the Gemini key opt-in and input sizes.`);
  if (d.compaction.rescues >= 5) s.push(`${d.compaction.rescues} compaction rescues: handover_now.md is probably too thin or too stale.`);
  if (d.backlog.open.length > 10) s.push(`${d.backlog.open.length} parked ideas: pick at most 3 for this sitting, drop the rest.`);
  if (!d.backlog.open.length && !s.length) s.push('Nothing to fix: leave the harness alone.');
  return s;
}

export function renderDigest(d) {
  const L = [];
  L.push(`# Harness Dock: weekly digest (${d.since} .. ${d.until})`);
  L.push('');
  L.push(`> Weekday freeze: ${d.freeze.freeze}`);
  L.push('> Rule: apply the backlog in ONE sitting on the dock day, and retire one rule for every rule you add.');
  L.push('');
  L.push('## Signals');
  L.push(`- Command guard: ${d.guard.total} prompt(s)${d.guard.total ? ' - ' + top(d.guard.byRule).map(([k, n]) => `${k} x${n}`).join(', ') : ''}`);
  L.push(`- Evaluator: ${d.eval.total} run(s)${d.eval.total ? ' - ' + Object.entries(d.eval.byStatus).map(([k, n]) => `${k} ${n}`).join(', ') : ''}${d.eval.assayInvalid ? ` (assay_invalid ${d.eval.assayInvalid})` : ''}`);
  L.push(`- Compaction rescues: ${d.compaction.rescues} (${d.compaction.capsules} capsule(s) injected)`);
  if (d.bloat) L.push(`- Bloat: ${d.bloat.status}, ${d.bloat.chars}/${d.bloat.budget} always-on chars, ${d.bloat.skills}/${d.bloat.skillCap} skills, hooks ${d.bloat.hooks}`);
  L.push('');
  L.push(`## Backlog (${d.backlog.open.length} open, ${d.backlog.done} done)`);
  if (d.backlog.open.length) d.backlog.open.slice(0, 15).forEach((t, i) => L.push(`${i + 1}. ${t}`));
  else L.push('(empty)');
  L.push('');
  L.push('## Suggested actions');
  suggestions(d).forEach((t) => L.push(`- ${t}`));
  L.push('');
  return L.join('\n');
}

/** Writes harness_dock/WEEKLY_DIGEST.md under root; a previous digest is copied to _backups/ first. */
export function writeDigest({ root, text, out = '', now = new Date() }) {
  const file = out ? path.resolve(out) : path.join(root, DIGEST_REL);
  let backedUp = null;
  if (fs.existsSync(file)) {
    const dir = path.join(root, '_backups');
    fs.mkdirSync(dir, { recursive: true });
    backedUp = path.join(dir, `WEEKLY_DIGEST.${now.toISOString().replace(/[:.]/g, '-')}.md`);
    fs.copyFileSync(file, backedUp);
  }
  atomicWriteFileSync(file, text);
  return { file, backedUp };
}

function main() {
  const args = parseArgs();
  const cmd = args._[0];
  if (!['digest', 'status'].includes(cmd)) {
    console.error('usage: dock_feeder.mjs digest [--root <workspace>] [--days 7] [--out file] [--stdout] | status [--root <workspace>]');
    process.exitCode = 2;
    return;
  }
  const root = findWorkspaceRoot({ root: args.root ? String(args.root) : '' }) || (args.root ? path.resolve(String(args.root)) : null);
  if (!root) {
    console.error('error: no workspace (pass --root <dir> or set JEV_WORKSPACE_DIR; init_workspace.mjs creates one)');
    process.exitCode = 1;
    return;
  }
  const d = collect({ root, days: Number(args.days || 7), stateDir: args['state-dir'] ? String(args['state-dir']) : '' });
  if (cmd === 'status') {
    console.log(JSON.stringify({ freeze: d.freeze, backlogOpen: d.backlog.open.length, bloat: d.bloat?.status, guardPrompts: d.guard.total, evalRuns: d.eval.total }, null, 2));
    return;
  }
  const text = renderDigest(d);
  if (args.stdout) {
    console.log(text);
    return;
  }
  const w = writeDigest({ root, text, out: args.out ? String(args.out) : '' });
  console.log(JSON.stringify({ ok: true, digest: path.relative(root, w.file) || w.file, backedUp: w.backedUp ? path.relative(root, w.backedUp) : null, freeze: d.freeze.freeze }, null, 2));
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${String(err?.message || err).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
