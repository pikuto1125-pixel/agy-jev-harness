// telemetry.mjs — tiny local event log (JSON lines) that dock_feeder.mjs summarises once a week. No network, no user text:
// events carry rule ids, statuses and counters only. Best effort: logging never throws and never blocks a hook.
//
//   guard_events.jsonl       {ts, rule, decision}                 written by hook_entry when the command guard speaks
//   eval_history.jsonl       {ts, pack, persona, status, ...}     written by anchored_eval
//   compaction_events.jsonl  {ts, kind, rescued}                  written by hook_entry after a real compaction

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './jev_client.mjs';

const MAX_BYTES = 1024 * 1024;

export const EVENT_FILES = { guard: 'guard_events.jsonl', eval: 'eval_history.jsonl', compaction: 'compaction_events.jsonl' };

export function eventFile(kind, env = process.env, dir = '') {
  return path.join(dir || stateDir(env), EVENT_FILES[kind] || `${kind}.jsonl`);
}

export function appendEvent(kind, event, env = process.env, dir = '') {
  try {
    const f = eventFile(kind, env, dir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, `${f}.1`); // keep one previous generation
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Events newer than `sinceMs` (epoch ms), oldest first. Torn / foreign lines are skipped. */
export function readEvents(kind, { env = process.env, dir = '', sinceMs = 0 } = {}) {
  const out = [];
  for (const f of [`${eventFile(kind, env, dir)}.1`, eventFile(kind, env, dir)]) {
    let raw = '';
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e === 'object' && Date.parse(e.ts) >= sinceMs) out.push(e);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}
