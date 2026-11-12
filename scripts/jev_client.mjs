#!/usr/bin/env node
// jev_client.mjs — gemini-decision-1 (Gemini Decisions API) client and shared safety helpers.
//
// This file is the ONE place that knows
//   * what a secret / private path looks like   (SECRET_RULES, redact, SECRET_PATH_RE, readTextFileSafe)
//   * whether a Gemini key may be used          (keyStatus / loadApiKey: explicit opt-in only)
//   * how to write state safely                 (atomicWriteFileSync)
// Every other script imports these instead of keeping its own copy.
//
// Design goals: Node >= 20, standard library only, never crash the host agent (every failure degrades to a
// deterministic heuristic), nothing leaves the machine unless a key was explicitly opted in.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JEV_MODEL = 'gemini-decision-1';
export const JEV_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
export const MAX_QUESTIONS_PER_REQUEST = 400;
export const DEFAULT_TIMEOUT_MS = 8000;
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ───────────────────────── paths / config ─────────────────────────

/** `~` and `~/x` -> the home directory. Anything else is returned unchanged. */
export function expandHome(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

export function configDir(env = process.env) {
  return expandHome(env.JEV_HARNESS_CONFIG_DIR || path.join(os.homedir(), '.config', 'jev-harness'));
}

/** Persistent state directory. Antigravity sets PLUGIN_DATA for installed plugins. */
export function stateDir(env = process.env) {
  return expandHome(env.PLUGIN_DATA || configDir(env));
}

/** Write via tmp -> rename so a concurrent reader never sees half a file. Falls back to a direct write. */
export function atomicWriteFileSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(file, data, 'utf8');
  }
}

// ───────────────────────── opt-in key handling ─────────────────────────

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

function readEnvFile(env) {
  const out = {};
  try {
    const file = path.join(configDir(env), '.env');
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* unreadable config is treated as "no key" */
  }
  return out;
}

/**
 * A Gemini key is used for outgoing requests ONLY when the user clearly meant it for this plugin:
 *   1. JEV_GEMINI_API_KEY (env or the plugin's own ~/.config/jev-harness/.env), or
 *   2. GEMINI_API_KEY written in that same .env file, or
 *   3. GEMINI_API_KEY from the environment together with JEV_OPT_IN_GEMINI_KEY=1.
 * A GEMINI_API_KEY that was set up for some other tool is never used silently.
 */
export function keyStatus(env = process.env) {
  const file = readEnvFile(env);
  const dedicated = String(env.JEV_GEMINI_API_KEY || file.JEV_GEMINI_API_KEY || '').trim();
  if (dedicated) return { present: true, key: dedicated, source: 'JEV_GEMINI_API_KEY' };
  const fromFile = String(file.GEMINI_API_KEY || '').trim();
  if (fromFile) return { present: true, key: fromFile, source: 'GEMINI_API_KEY in the plugin .env file' };
  const generic = String(env.GEMINI_API_KEY || '').trim();
  if (generic && (truthy(env.JEV_OPT_IN_GEMINI_KEY) || truthy(file.JEV_OPT_IN_GEMINI_KEY))) {
    return { present: true, key: generic, source: 'GEMINI_API_KEY (opted in with JEV_OPT_IN_GEMINI_KEY=1)' };
  }
  if (generic) {
    return { present: false, key: '', source: '', reason: 'GEMINI_API_KEY is set, but not opted in for this plugin' };
  }
  return { present: false, key: '', source: '', reason: 'no key configured' };
}

export function loadApiKey(env = process.env) {
  return keyStatus(env).key;
}

// ───────────────────────── secrets / private data: single source of truth ─────────────────────────

// Pattern pieces are concatenated so this source never contains a complete example of what it detects
// (the repository scanner reads this file too).
const P = (...parts) => new RegExp(parts.join(''));
const QUOTE_END = '"\'`<>*|?';

/**
 * id, category ('secret' | 'private'), re (single-line detector), redactRe (optional multi-line masker).
 * Used by redact() (outgoing text), by the physical floor of the rubric gate, and by security_scan.mjs.
 */
export const SECRET_RULES = [
  { id: 'google_api_key', category: 'secret', re: P('AI', 'za[0-9A-Za-z_-]{30,}') },
  { id: 'openai_style_key', category: 'secret', re: P('\\bs', 'k-[0-9A-Za-z_-]{20,}') },
  { id: 'github_token', category: 'secret', re: P('\\bgh', '[pousr]_[0-9A-Za-z]{20,}|\\bgithub_', 'pat_[0-9A-Za-z_]{20,}') },
  { id: 'google_oauth_token', category: 'secret', re: P('\\bya', '29\\.[0-9A-Za-z._-]{20,}') },
  { id: 'aws_access_key_id', category: 'secret', re: P('\\b(?:AK', 'IA|AS', 'IA)[0-9A-Z]{16}\\b') },
  { id: 'slack_token', category: 'secret', re: P('\\bx', 'ox[abprs]-[0-9A-Za-z-]{10,}') },
  { id: 'jwt', category: 'secret', re: P('\\bey', 'J[0-9A-Za-z_-]{8,}\\.[0-9A-Za-z_-]{8,}\\.[0-9A-Za-z_-]*') },
  { id: 'bearer_token', category: 'secret', re: /\bBearer\s+[0-9A-Za-z._~+/-]{16,}=*/ },
  {
    id: 'private_key_block',
    category: 'secret',
    re: P('-----BEGIN [A-Z ]*PRIV', 'ATE KEY-----'),
    redactRe: P('-----BEGIN [A-Z ]*PRIV', 'ATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIV', 'ATE KEY-----|$)'),
  },
  { id: 'windows_user_path', category: 'private', re: P('[A-Za-z]:[\\\\/]+Us', `ers[\\\\/]+[^\\s${QUOTE_END}]+`) },
  { id: 'posix_home_path', category: 'private', re: P('(?<![A-Za-z0-9_.-])/(?:Us', 'ers|ho', `me)/[^\\s${QUOTE_END}\\\\/]+(?:/[^\\s${QUOTE_END}\\\\]*)?`) },
  // public no-reply addresses (GitHub, the co-author trailer) are not personal data
  {
    id: 'email_address',
    category: 'private',
    re: /\b(?!noreply@(?:anthropic|github)\.com\b)[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  },
];

const compiled = SECRET_RULES.map((r) => ({
  ...r,
  global: new RegExp((r.redactRe || r.re).source, 'g'),
}));

/** Mask secrets, e-mails and personal paths. Pass maxChars to cap the length (default: no cap). */
export function redact(text = '', maxChars = Infinity) {
  let s = String(text ?? '');
  for (const r of compiled) s = s.replace(r.global, '<REDACTED>');
  return Number.isFinite(maxChars) ? s.slice(0, maxChars) : s;
}

/** True when the text contains a secret (category 'secret'); pass 'private' or 'any' to widen. */
export function containsSecret(text, category = 'secret') {
  const t = String(text ?? '');
  return SECRET_RULES.some((r) => (category === 'any' || r.category === category) && r.re.test(t));
}

/** Paths a plugin must never read: credential stores, key material, dotenv files. */
export const SECRET_PATH_RE =
  /(?:^|[\\/])(?:\.secrets?|secrets?|credentials?|\.env(?:\.[^\\/]+)?|auth\.json|oauth_creds[^\\/]*|\.npmrc|\.netrc|\.aws|\.ssh|id_(?:rsa|ed25519|ecdsa|dsa)[^\\/]*|[^\\/]*\.(?:pem|key|p12|pfx))(?:$|[\\/])/i;

/** Resolve (and follow symlinks of) a user-supplied path and refuse credential locations. Returns the real path. */
export function assertSafePath(file) {
  const resolved = path.resolve(expandHome(file));
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    /* missing files are reported by the caller */
  }
  if (SECRET_PATH_RE.test(resolved) || SECRET_PATH_RE.test(real)) throw new Error(`FORBIDDEN_SECRET_PATH:${path.basename(resolved)}`);
  return real;
}

/** The only way scripts read a user-named text file (`--file`, `--transcript`, `--user`, `--deliverable`, ...). */
export function readTextFileSafe(file, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const real = assertSafePath(file);
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    throw new Error(`FILE_NOT_FOUND:${path.basename(String(file))}`);
  }
  if (!st.isFile()) throw new Error(`NOT_A_FILE:${path.basename(String(file))}`);
  if (st.size > maxBytes) throw new Error(`FILE_TOO_LARGE:${path.basename(String(file))}`);
  return fs.readFileSync(real, 'utf8');
}

/** Label put in front of the human's own words when they are relayed. Configurable, default is neutral. */
export function userLabel(env = process.env) {
  const v = String(env.JEV_USER_LABEL || '').replace(/[\r\n]/g, ' ').trim().slice(0, 40);
  return v || '[User (Verbatim)]';
}

// ───────────────────────── tiny CLI helpers ─────────────────────────

/** `--key value`, `--flag`, `--key=value`; positionals land in `_`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export async function readStdin(timeoutMs = 1500) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let buf = '';
    const done = () => resolve(buf);
    const t = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      done();
    });
  });
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** Compare real paths so Windows junctions / symlinks do not make a script think it was imported. */
export function isMain(metaUrl) {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

// ───────────────────────── multimodal input ─────────────────────────

const MEDIA = {
  '.wav': ['audio', 'audio/wav'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.webm': ['audio', 'audio/webm'],
  '.m4a': ['audio', 'audio/m4a'],
  '.aac': ['audio', 'audio/aac'],
  '.ogg': ['audio', 'audio/ogg'],
  '.opus': ['audio', 'audio/opus'],
  '.flac': ['audio', 'audio/flac'],
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.webp': ['image', 'image/webp'],
  '.pdf': ['document', 'application/pdf'],
};
const MAX_MEDIA_BYTES = 48 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_BYTES = 75 * 1024 * 1024;
export const MAX_MEDIA_FILES = 8;

export function mediaKindFor(file) {
  return MEDIA[path.extname(String(file)).toLowerCase()] || null;
}

/**
 * Validate media paths WITHOUT reading them: assertSafePath (no credential locations, symlinks resolved), the file exists,
 * a supported extension, per-file / total / count caps. Throws Error('<CODE>[:<name>]'). Returns [{ file, real, kind, mime, size }].
 */
export function inspectMedia(files = []) {
  const list = files.filter(Boolean);
  if (list.length > MAX_MEDIA_FILES) throw new Error('TOO_MANY_MEDIA_FILES');
  const items = [];
  let total = 0;
  for (const f of list) {
    const real = assertSafePath(f);
    let st;
    try {
      st = fs.statSync(real);
    } catch {
      throw new Error(`FILE_NOT_FOUND:${path.basename(String(f))}`);
    }
    if (!st.isFile()) throw new Error(`NOT_A_FILE:${path.basename(String(f))}`);
    const spec = mediaKindFor(real);
    if (!spec) throw new Error(`UNSUPPORTED_MEDIA_EXT:${path.extname(real)}`);
    total += st.size;
    if (st.size > MAX_MEDIA_BYTES || total > MAX_MEDIA_TOTAL_BYTES) throw new Error('FILE_TOO_LARGE_INLINE');
    items.push({ file: String(f), real, kind: spec[0], mime: spec[1], size: st.size });
  }
  return items;
}

/** Build the `input` field: plain string, or Content[] (inline base64 media parts + a text part) when media files are attached. */
export function buildInput({ text = '', files = [] } = {}) {
  const blocks = inspectMedia(files).map((m) => ({ type: m.kind, mime_type: m.mime, data: fs.readFileSync(m.real).toString('base64') }));
  const clean = redact(text);
  if (blocks.length === 0) return clean || '(empty)';
  if (clean) blocks.push({ type: 'text', text: `\n${clean}` });
  return blocks;
}

function sanitizeInput(input) {
  if (typeof input === 'string') return redact(input);
  if (Array.isArray(input)) return input.map((b) => (b && b.type === 'text' ? { ...b, text: redact(b.text) } : b));
  return redact(JSON.stringify(input ?? ''));
}

function inputChars(input) {
  if (typeof input === 'string') return input.length;
  if (Array.isArray(input)) return input.reduce((n, b) => n + (b && b.type === 'text' ? String(b.text || '').length : 0), 0);
  return 0;
}

// ───────────────────────── chunking ─────────────────────────

export function resolveChunkSize(env = process.env, requested) {
  const n = Number(requested ?? env.JEV_CHUNK_SIZE ?? MAX_QUESTIONS_PER_REQUEST);
  if (!Number.isFinite(n) || n < 1) return MAX_QUESTIONS_PER_REQUEST;
  return Math.min(Math.floor(n), MAX_QUESTIONS_PER_REQUEST);
}

/** Split a questions object into objects of at most `size` keys, preserving order. */
export function chunkQuestions(questions, size = MAX_QUESTIONS_PER_REQUEST) {
  const keys = Object.keys(questions || {});
  const cap = Math.max(1, Math.min(size, MAX_QUESTIONS_PER_REQUEST));
  const chunks = [];
  for (let i = 0; i < keys.length; i += cap) {
    const part = {};
    for (const k of keys.slice(i, i + cap)) part[k] = questions[k];
    chunks.push(part);
  }
  return chunks;
}

// ───────────────────────── small budget / cooldown guard ─────────────────────────

const budgetFile = (env) => path.join(stateDir(env), 'jev_budget.json');

function readBudget(env, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let st = null;
  try {
    st = JSON.parse(fs.readFileSync(budgetFile(env), 'utf8'));
  } catch {
    /* first run */
  }
  if (!st || st.day !== day) st = { day, calls: 0, cooldownUntilMs: st?.cooldownUntilMs || 0 };
  return st;
}

function writeBudget(env, st) {
  try {
    atomicWriteFileSync(budgetFile(env), JSON.stringify(st) + '\n');
  } catch {
    /* state is best-effort */
  }
}

// ───────────────────────── core call ─────────────────────────

/**
 * Call gemini-decision-1. Questions are auto-chunked (<= 400 per request) and merged.
 * Returns { ok, answers, chunks, latencyMs, reason?, partialAnswers? }. Never throws.
 * Oversized input is refused (INPUT_TOO_LARGE), never silently cut: callers decide how to shrink it.
 */
export async function callDecisions({
  input,
  questions,
  apiKey = undefined,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  chunkSize = undefined,
  env = process.env,
  offline = false,
} = {}) {
  // privacy gate: callers handling local_only / uncertain material pass offline:true -> zero bytes reach the network
  if (offline) return { ok: false, reason: 'OFFLINE_PRIVACY', answers: {}, chunks: 0 };
  const key = String(apiKey ?? loadApiKey(env)).trim();
  if (!key) return { ok: false, reason: 'NO_GEMINI_API_KEY', answers: {}, chunks: 0 };
  if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    return { ok: false, reason: 'EMPTY_QUESTIONS', answers: {}, chunks: 0 };
  }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'NO_FETCH', answers: {}, chunks: 0 };
  const maxChars = Number(env.JEV_MAX_INPUT_CHARS || 60000);
  if (inputChars(input) > maxChars) return { ok: false, reason: 'INPUT_TOO_LARGE', answers: {}, chunks: 0 };

  const nowMs = Date.now();
  const budget = readBudget(env, nowMs);
  const dailyCap = Number(env.JEV_DAILY_CALL_CAP || 5000);
  if (budget.cooldownUntilMs > nowMs) return { ok: false, reason: 'COOLDOWN_ACTIVE', answers: {}, chunks: 0 };
  if (budget.calls >= dailyCap) return { ok: false, reason: 'DAILY_CALL_CAP_REACHED', answers: {}, chunks: 0 };

  const body = sanitizeInput(input);
  const parts = chunkQuestions(questions, resolveChunkSize(env, chunkSize));
  const merged = {};
  const t0 = Date.now();
  let done = 0;

  for (const part of parts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(JEV_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ model: JEV_MODEL, input: body, questions: part }),
        signal: controller.signal,
      });
      const raw = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* non-JSON error body */
      }
      budget.calls += 1;
      if (!res.ok || !parsed || typeof parsed.answers !== 'object' || !parsed.answers) {
        if (res.status === 429) budget.cooldownUntilMs = Date.now() + 5 * 60_000;
        writeBudget(env, budget);
        const code = parsed?.error?.status || parsed?.error?.code || `HTTP_${res.status}`;
        return { ok: false, reason: redact(`${code}`, 80), status: res.status, answers: {}, partialAnswers: merged, chunks: done, latencyMs: Date.now() - t0 };
      }
      Object.assign(merged, parsed.answers);
      done += 1;
    } catch (err) {
      writeBudget(env, budget);
      return {
        ok: false,
        reason: err?.name === 'AbortError' ? 'TIMEOUT' : redact(err?.message || 'NETWORK_ERROR', 80),
        answers: {},
        partialAnswers: merged,
        chunks: done,
        latencyMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  writeBudget(env, budget);
  return { ok: true, answers: merged, chunks: done, latencyMs: Date.now() - t0 };
}

/**
 * Jev when possible, deterministic heuristic otherwise. Always resolves.
 * heuristic(input, questions) must return answers in the same shape as the API.
 * source: 'jev' | 'jev+heuristic' (partial API failure) | 'heuristic' | 'none'
 */
export async function decide({ input, questions, heuristic = null, ...opts } = {}) {
  const text = typeof input === 'string' ? input : '';
  const api = await callDecisions({ input, questions, ...opts });
  if (api.ok) return { ok: true, source: 'jev', answers: api.answers, chunks: api.chunks, latencyMs: api.latencyMs };

  if (typeof heuristic !== 'function') {
    return { ok: false, source: 'none', reason: api.reason, answers: api.partialAnswers || {} };
  }
  const have = api.partialAnswers || {};
  const missing = {};
  for (const [k, q] of Object.entries(questions || {})) if (!(k in have)) missing[k] = q;
  let filled = {};
  try {
    filled = heuristic(input ?? text, missing) || {};
  } catch {
    filled = {};
  }
  return {
    ok: true,
    source: Object.keys(have).length ? 'jev+heuristic' : 'heuristic',
    degraded: api.reason,
    answers: { ...filled, ...have },
    chunks: api.chunks || 0,
    latencyMs: api.latencyMs || 0,
  };
}

// ───────────────────────── answer readers ─────────────────────────

export function noul(answers, key, dflt = 0) {
  const v = answers?.[key]?.noul;
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

export function score(answers, key, dflt = 0) {
  const v = answers?.[key]?.score;
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Probability table for a choice answer; falls back to confidence on the chosen key. */
export function choiceProbs(answers, key, options) {
  const a = answers?.[key] || {};
  const out = Object.fromEntries(options.map((o) => [o, 0]));
  if (a.probabilities && typeof a.probabilities === 'object') {
    for (const o of options) out[o] = Number(a.probabilities[o] ?? 0) || 0;
  } else if (a.choice && options.includes(a.choice)) {
    const conf = Math.min(1, Math.max(0, Number(a.confidence ?? 0.6)));
    const rest = options.length > 1 ? (1 - conf) / (options.length - 1) : 0;
    for (const o of options) out[o] = o === a.choice ? conf : rest;
  }
  return out;
}

export const clamp01 = (n) => Math.max(0, Math.min(1, n));
export const round3 = (n) => Math.round(n * 1000) / 1000;

// ───────────────────────── doctor ─────────────────────────

const quote = (p) => `"${p}"`;

/** One-shot diagnosis: node, paths, key opt-in, hook wiring, guard behaviour and (with a key) one live question. */
export async function runDoctor({ env = process.env, live = true, fetchImpl = globalThis.fetch } = {}) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const root = PLUGIN_ROOT;

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'fail', `node ${process.versions.node} (needs >= 20)`);

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    add('manifest', 'ok', `${manifest.name} ${manifest.version}`);
  } catch {
    add('manifest', 'fail', 'plugin.json missing or unreadable');
  }

  const cfg = configDir(env);
  const st = stateDir(env);
  try {
    fs.mkdirSync(st, { recursive: true });
    const probe = path.join(st, `.doctor_${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    add('state_dir', 'ok', `writable: ${st}`);
  } catch {
    add('state_dir', 'warn', `not writable: ${st} (hooks still run, state is skipped)`);
  }
  add('config_dir', fs.existsSync(cfg) ? 'ok' : 'skip', `${cfg}${fs.existsSync(cfg) ? '' : ' (not created yet; only needed for a .env key or denylist)'}`);

  const ks = keyStatus(env);
  add('gemini_key', ks.present ? 'ok' : 'skip', ks.present ? `opted in via ${ks.source}` : `${ks.reason}; running in zero-token deterministic mode`);
  const nextSteps = [];
  if (!ks.present) {
    nextSteps.push('Optional: enable the Decisions API. Set JEV_GEMINI_API_KEY, or set GEMINI_API_KEY together with JEV_OPT_IN_GEMINI_KEY=1, or write the key into the config .env file shown above.');
    nextSteps.push('Read the README section "What leaves your machine" before opting in.');
  }

  // hooks.json wiring
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks.json'), 'utf8'));
    const events = Object.values(hooks).flatMap((h) => Object.keys(h).filter((k) => k !== 'enabled'));
    add('hooks_json', 'ok', `events: ${events.join(', ')}`);
  } catch {
    add('hooks_json', 'fail', 'hooks.json missing or unreadable');
  }

  // hook smoke tests: run the real entry point as Antigravity would (stdin JSON -> stdout JSON)
  const entry = path.join(root, 'scripts', 'hook_entry.mjs');
  const runHook = (event, payload) => {
    const r = spawnSync(process.execPath, [entry, event], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...env, JEV_HARNESS_CONFIG_DIR: cfg, PLUGIN_DATA: st, JEV_GEMINI_API_KEY: '', GEMINI_API_KEY: '', JEV_OPT_IN_GEMINI_KEY: '' },
    });
    try {
      return { status: r.status, json: JSON.parse(String(r.stdout || '').trim()) };
    } catch {
      return { status: r.status, json: null };
    }
  };
  const quiet = runHook('PreInvocation', { conversationId: 'doctor-probe', lastUserInput: 'hello there' });
  add('hook_preinvocation', quiet.status === 0 && quiet.json && !quiet.json.injectSteps ? 'ok' : 'fail', quiet.json ? 'ordinary turn -> silent {}' : 'no valid JSON from hook');
  const guard = runHook('PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } } });
  add('hook_pretooluse', guard.json && ['ask', 'deny', 'force_ask'].includes(guard.json.decision) ? 'ok' : 'fail', guard.json ? `force-push -> ${guard.json.decision || '(no decision)'}` : 'no valid JSON from hook');
  const calm = runHook('PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'node --test' } } });
  add('hook_pretooluse_calm', calm.json && !calm.json.decision ? 'ok' : 'fail', 'ordinary command -> no decision (your normal permission flow applies)');

  // live round trip: ONE question, fixed text, no user data
  if (!ks.present) add('live_ping', 'skip', 'no key opted in');
  else if (!live) add('live_ping', 'skip', '--offline given');
  else {
    const r = await callDecisions({ input: 'Jev doctor ping.', questions: { ping: { type: 'noul', instructions: 'Is this a short test message?' } }, fetchImpl, env, timeoutMs: 6000 });
    add('live_ping', r.ok ? 'ok' : 'fail', r.ok ? `answered in ${r.latencyMs} ms` : `failed: ${r.reason}`);
  }

  const failed = checks.filter((c) => c.status === 'fail');
  return {
    ok: failed.length === 0,
    pluginRoot: root,
    configDir: cfg,
    stateDir: st,
    mode: ks.present ? 'jev' : 'deterministic (zero-token)',
    checks,
    nextSteps,
    commands: {
      doctor: `node ${quote(path.join(root, 'scripts', 'jev_client.mjs'))} doctor`,
      router: `node ${quote(path.join(root, 'scripts', 'smart_router.mjs'))} --text "<request>"`,
    },
  };
}

// ───────────────────────── CLI ─────────────────────────

async function main() {
  const args = parseArgs();
  const cmd = args._[0] || 'status';
  if (cmd === 'status') {
    const ks = keyStatus();
    console.log(
      JSON.stringify(
        {
          model: JEV_MODEL,
          apiKey: ks.present ? `opted in (${ks.source})` : `absent (${ks.reason}); zero-token deterministic mode`,
          maxQuestionsPerRequest: MAX_QUESTIONS_PER_REQUEST,
          configDir: configDir(),
          stateDir: stateDir(),
        },
        null,
        2
      )
    );
    return;
  }
  if (cmd === 'doctor') {
    const r = await runDoctor({ live: !args.offline });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'ask') {
    const text = String(args.text || (await readStdin()));
    const files = args.audio ? [String(args.audio)] : [];
    const qs = { q1: { type: 'noul', instructions: String(args.question || 'Is the input a complete, self-contained sentence?') } };
    const input = buildInput({ text, files });
    const r = await decide({
      input,
      questions: qs,
      heuristic: (_i, q) => Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.5 }])),
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.error('usage: jev_client.mjs [status | doctor [--offline] | ask --text "..." [--question "..."] [--audio file]]');
  process.exitCode = 2;
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(`error: ${redact(err?.message || String(err), 200)}`);
    process.exitCode = 1;
  }
}
