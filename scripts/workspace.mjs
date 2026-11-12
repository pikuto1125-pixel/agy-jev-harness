#!/usr/bin/env node
// workspace.mjs — shared helpers for the multi-desk workspace kit (session_bus, verbatim_relay, bloat_guard, dock_feeder,
// tool_guard). Zero model calls. A "workspace" is a folder that holds Tasks/sessions_keep.json (see starter/).
//
// How a script finds the workspace, strongest first:
//   1. --root <dir>                      (CLI) / opts.root
//   2. JEV_WORKSPACE_DIR                 (env; set it once for hooks, which run with the plugin as working directory)
//   3. a folder named in the hook payload (cwd / workspaceRoot / workspacePath / workspaceFolders[0])
//   4. the current directory and up to 3 parents
// `JEV_WORKSPACE_DIR` is authoritative: when it is set, nothing else is searched.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, expandHome } from './jev_client.mjs';

export const PERSISTENT_DESKS = ['coordinator', 'venture_lab', 'quant_lab', 'creative_studio', 'harness_dock'];
export const SESSIONS_KEEP_FILES = [path.join('Tasks', 'sessions_keep.json'), 'sessions_keep.json'];
export const PRIVACY_CLASSES = ['cloud_ok', 'local_only'];
export const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** The sessions_keep.json inside `root`, or null. */
export function sessionsKeepPath(root) {
  if (!root) return null;
  for (const rel of SESSIONS_KEEP_FILES) {
    const p = path.join(root, rel);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Parse + validate sessions_keep.json. Returns { ok, file, data, desks } or { ok:false, reason }. */
export function loadSessionsKeep(root) {
  const file = sessionsKeepPath(root);
  if (!file) return { ok: false, reason: 'no_sessions_keep' };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, file, reason: 'sessions_keep_invalid_json' };
  }
  if (!data || typeof data !== 'object' || !data.desks || typeof data.desks !== 'object' || Array.isArray(data.desks)) return { ok: false, file, reason: 'sessions_keep_no_desks' };
  const desks = {};
  for (const [name, d] of Object.entries(data.desks)) {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(name) || !d || typeof d !== 'object') continue;
    const privacy = PRIVACY_CLASSES.includes(d.privacy) ? d.privacy : 'cloud_ok';
    desks[name] = { name, convId: typeof d.convId === 'string' ? d.convId : '', privacy, role: d.role || '', handover: d.handover || data.handover || path.join('Tasks', 'handover_now.md') };
  }
  return { ok: true, file, data, desks };
}

/** Windows and macOS file systems resolve <brain>/<convId> case-insensitively, so ids must be compared the same way there. */
export const FS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

export function deskForConv(desks, convId, { caseInsensitive = FS_CASE_INSENSITIVE } = {}) {
  if (!convId) return null;
  const fold = (s) => (caseInsensitive ? String(s).toLowerCase() : String(s));
  const want = fold(convId);
  return Object.values(desks || {}).find((d) => d.convId && fold(d.convId) === want) || null;
}

/**
 * Is the privacy of a conversation uncertain? '' = no. Fail closed: an unreadable sessions_keep.json, or a workspace that
 * still has a local_only desk with no bound conversation (this conversation could be it), means "treat as local_only".
 */
export function privacyUncertainReason(ws, bound) {
  if (ws && !ws.ok) return 'sessions_keep_unreadable';
  if (ws?.ok && !bound && Object.values(ws.desks).some((d) => d.privacy === 'local_only' && !d.convId)) return 'unbound_local_only_desk';
  return '';
}

function firstWorkspaceFolder(payload) {
  for (const k of ['workspaceRoot', 'workspacePath', 'cwd']) if (typeof payload?.[k] === 'string' && payload[k]) return payload[k];
  for (const k of ['workspaceFolders', 'workspace_folders', 'workspaces']) {
    const v = payload?.[k];
    if (Array.isArray(v) && v.length) {
      const f = typeof v[0] === 'string' ? v[0] : v[0]?.path || v[0]?.uri;
      if (typeof f === 'string' && f) return f.replace(/^file:\/\/\/?/, '');
    }
  }
  return '';
}

/** Find the workspace root (the folder holding sessions_keep.json) or null. Never throws. */
export function findWorkspaceRoot({ root = '', env = process.env, payload = null } = {}) {
  try {
    const explicit = String(root || '').trim();
    if (explicit) return sessionsKeepPath(path.resolve(expandHome(explicit))) ? path.resolve(expandHome(explicit)) : null;
    const fromEnv = String(env.JEV_WORKSPACE_DIR ?? '').trim();
    if (env.JEV_WORKSPACE_DIR !== undefined) return fromEnv && sessionsKeepPath(path.resolve(expandHome(fromEnv))) ? path.resolve(expandHome(fromEnv)) : null;
    const starts = [firstWorkspaceFolder(payload), process.cwd()].filter(Boolean);
    for (const s of starts) {
      let dir = path.resolve(expandHome(s));
      for (let i = 0; i < 4; i++) {
        if (sessionsKeepPath(dir)) return dir;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Write sessions_keep.json back atomically (used by `bind`). Keeps every unknown field. */
export function saveSessionsKeep(file, data) {
  atomicWriteFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
