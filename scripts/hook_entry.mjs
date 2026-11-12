#!/usr/bin/env node
// hook_entry.mjs — Antigravity lifecycle hook entry point (SessionStart / PreInvocation / PreToolUse).
//
// Contract: JSON on stdin, JSON on stdout, camelCase keys.
//   PreInvocation: {"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}  -> inject context, {} -> nothing
//   PreToolUse:    {"decision":"ask"|"deny","reason":"..."}                      -> destructive run_command, {} -> no opinion
//
// FAIL-SAFE: this script must NEVER block or break the agent loop.
//   * any exception, bad stdin, missing key, network error -> prints `{}` and exits 0
//   * time budget: rescue 1500 ms + routing 1500 ms, hard watchdog JEV_HOOK_BUDGET_MS (default 4000 ms) -> prints `{}`
//   * without an opted-in Gemini key the router runs in deterministic zero-token mode and only speaks up when a
//     clearly actionable signal (public / irreversible / pivot / overreach) is present.
//
// Privacy: per-conversation state lives in hook_state_<hash(conversationId)>.json. It stores hashes and counters,
// never the user's words (the previous message is kept in plain text only with JEV_STORE_PREV_INPUT=1).
//
// Env: JEV_HARNESS_MODE=off|lite|full (default full), JEV_HARNESS_VERBOSE=1 (always inject the lane line),
//      JEV_GUARD_MODE=ask|deny|force_ask|off (PreToolUse), JEV_STORE_PREV_INPUT=1 (opt-in plain-text prevInput).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isMain, readStdin, sha256, stateDir } from './jev_client.mjs';
import { rescueNuance } from './nuance_rescue.mjs';
import { routeTurn } from './smart_router.mjs';
import { evaluateToolCall } from './tool_guard.mjs';
import { readTranscriptTurns, scanSummaries } from './verbatim_relay.mjs';
import { drainFor } from './session_bus.mjs';
import { appendEvent } from './telemetry.mjs';
import { selfCorrectionNote } from './voice_conversation_gate.mjs';
import { deskForConv, findWorkspaceRoot, loadSessionsKeep, privacyUncertainReason } from './workspace.mjs';

export const RESCUE_TIMEOUT_MS = 1500;
export const ROUTE_TIMEOUT_MS = 1500;
export const DEFAULT_WATCHDOG_MS = 4000;
const STATE_TTL_DAYS = 30;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/** File name of the per-conversation state. The conversation id itself never appears in it. */
export function stateFileFor(convId, env = process.env) {
  return path.join(stateDir(env), `hook_state_${sha256(String(convId || 'default')).slice(0, 16)}.json`);
}

export function loadState(convId, env = process.env) {
  try {
    const st = JSON.parse(fs.readFileSync(stateFileFor(convId, env), 'utf8'));
    return st && typeof st === 'object' ? st : {};
  } catch {
    return {};
  }
}

export function saveState(convId, st, env = process.env) {
  try {
    atomicWriteFileSync(stateFileFor(convId, env), JSON.stringify({ ...st, updatedAt: new Date().toISOString() }) + '\n');
    pruneOldState(env);
  } catch {
    /* state is best effort */
  }
}

/** Drop state files untouched for STATE_TTL_DAYS. Cheap: only runs for ~1 write in 20. */
function pruneOldState(env) {
  if (Math.random() > 0.05) return;
  try {
    const dir = stateDir(env);
    const cutoff = Date.now() - STATE_TTL_DAYS * 86_400_000;
    for (const f of fs.readdirSync(dir)) {
      if (!/^hook_state_[0-9a-f]{16}\.json$/.test(f)) continue;
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch {
    /* ignore */
  }
}

const sys = (text) => ({ systemMessage: { systemMessage: text } });

function pick(payload, ...keys) {
  for (const k of keys) {
    const v = payload?.[k];
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return '';
}

/**
 * Zero-cloud decision. True when this conversation is bound to a local_only desk, or its privacy is uncertain (broken
 * sessions_keep.json / an unbound local_only desk could be this conversation). Never throws; no workspace -> false.
 */
export function mustStayLocal(convId, env, payload) {
  try {
    const root = findWorkspaceRoot({ env, payload });
    // an explicit JEV_WORKSPACE_DIR that holds no valid sessions_keep.json means privacy cannot be established: stay local
    // (same rule as verbatim_relay `current`); with no explicit directory, "no workspace" is plain plugin-only mode.
    if (!root) return String(env.JEV_WORKSPACE_DIR ?? '').trim() !== '';
    const ws = loadSessionsKeep(root);
    const bound = ws.ok ? deskForConv(ws.desks, convId) : null;
    return bound?.privacy === 'local_only' || Boolean(privacyUncertainReason(ws, bound));
  } catch {
    return true; // cannot establish privacy -> stay local
  }
}

/**
 * Compaction check. Counts <CONTEXT_SUMMARY> blocks that sit inside USER_INPUT entries only (a tool result or an
 * agent answer that merely mentions the tag is ignored) and reads the transcript incrementally from a stored offset.
 */
export function detectCompaction(transcriptPath, conv, { budgetMs = 800 } = {}) {
  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return { fresh: false, count: conv.summaryCount || 0, maxStep: conv.summaryStep ?? -1, offset: conv.scanOffset || 0 };
  }
  const rewound = (conv.scanOffset || 0) > size; // file was replaced: start over
  const prevCount = rewound ? 0 : conv.summaryCount || 0;
  const prevStep = rewound ? -1 : conv.summaryStep ?? -1;
  const r = scanSummaries(transcriptPath, { startOffset: rewound ? 0 : conv.scanOffset || 0, deadlineMs: Date.now() + budgetMs });
  const count = prevCount + r.count;
  const maxStep = Math.max(prevStep, r.maxStepIndex);
  return { fresh: count > prevCount || maxStep > prevStep, count, maxStep, offset: r.offset };
}

export async function handleHook(event, payload, env = process.env, opts = {}) {
  const mode = String(env.JEV_HARNESS_MODE || 'full').toLowerCase();
  if (mode === 'off') return {};

  if (event === 'PreToolUse') {
    const out = evaluateToolCall(payload, env, { findRoot: () => findWorkspaceRoot({ env, payload }) });
    if (out.decision) appendEvent('guard', { rule: (String(out.reason || '').match(/guard:([a-z_0-9]+)/) || [])[1] || 'unknown', decision: out.decision }, env);
    return out;
  }

  if (event === 'SessionStart') {
    // Silent by default (zero tokens). Opt in with JEV_HARNESS_VERBOSE=1.
    return truthy(env.JEV_HARNESS_VERBOSE) ? { injectSteps: [sys('[jev-harness] active. Router hints appear only when a turn needs a different lane.')] } : {};
  }
  if (event !== 'PreInvocation') return {};

  const convId = pick(payload, 'conversationId', 'session_id', 'sessionId') || 'default';
  const input = pick(payload, 'lastUserInput', 'userInput', 'prompt', 'userMessage').trim();
  const transcriptPath = pick(payload, 'transcriptPath', 'transcript_path');
  const conv = loadState(convId, env);
  const steps = [];
  // local_only desks (or uncertain privacy): no prompt / transcript text may reach gemini-decision-1; heuristics only
  const localOnly = mustStayLocal(convId, env, payload);
  const net = localOnly ? { offline: true } : {};

  // 1) Compaction: a new <CONTEXT_SUMMARY> appeared in a USER_INPUT entry -> rescue the user's raw nuance.
  if (mode === 'full' && transcriptPath) {
    try {
      const c = detectCompaction(transcriptPath, conv);
      if (c.fresh) {
        const r = await rescueNuance(readTranscriptTurns(transcriptPath, { roles: ['user'], deadlineMs: Date.now() + 1000 }), {
          timeoutMs: RESCUE_TIMEOUT_MS,
          env,
          ...opts,
          ...net,
        });
        if (r.capsule) steps.push(sys(r.capsule));
        appendEvent('compaction', { kind: 'rescue', rescued: Boolean(r.capsule) }, env);
      }
      conv.summaryCount = c.count;
      conv.summaryStep = c.maxStep;
      conv.scanOffset = c.offset;
    } catch {
      /* an unreadable transcript must not stop routing */
    }
  }

  // 1b) Multi-desk bus: unread messages from other desks, delivered once. Only when the workspace has a sessions_keep.json.
  try {
    const root = findWorkspaceRoot({ env, payload });
    if (root) {
      const d = drainFor({ convId, root, env });
      if (d.text) steps.push(sys(d.text));
    }
  } catch {
    /* the bus must never stop a turn */
  }

  // 2) Routing + voice note: PreInvocation fires after every tool step too, so act only on a NEW user message.
  const h = input ? sha256(input) : '';
  if (h && h !== conv.inputHash) {
    const storePrev = truthy(env.JEV_STORE_PREV_INPUT);
    const r = await routeTurn(input, {
      previousInput: storePrev ? conv.prevInput || '' : '',
      timeoutMs: ROUTE_TIMEOUT_MS,
      env,
      verbose: truthy(env.JEV_HARNESS_VERBOSE),
      ...opts,
      ...net,
    });
    if (r.hint) steps.push(sys(r.hint));
    // spoken self-correction ("A じゃなくて B"): the message is never rewritten, one advisory line is added next to it
    const note = selfCorrectionNote(input);
    if (note.detected) steps.push(sys(note.note));
    conv.inputHash = h;
    if (storePrev) conv.prevInput = input.slice(0, 1500);
    else delete conv.prevInput; // never keep plain text unless the user opted in
  }

  saveState(convId, conv, env);
  return steps.length ? { injectSteps: steps } : {};
}

async function main() {
  const budget = Number(process.env.JEV_HOOK_BUDGET_MS || DEFAULT_WATCHDOG_MS);
  const watchdog = setTimeout(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  }, budget);
  let out = {};
  try {
    const event = process.argv[2] || 'PreInvocation';
    let payload = {};
    try {
      payload = JSON.parse((await readStdin(1000)) || '{}');
    } catch {
      payload = {};
    }
    out = await handleHook(event, payload);
  } catch {
    out = {};
  }
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

if (isMain(import.meta.url)) await main();
