#!/usr/bin/env node
// security_scan.mjs — deterministic "zero secrets / zero PII / zero private identifiers" scanner.
//
// * No network, no model, no dependencies. Exit 0 = clean, exit 1 = findings, exit 2 = usage error.
// * Findings never echo the matched text (only rule id, file and line), so the scan log cannot leak.
// * Secret and private-path patterns come from jev_client.mjs (SECRET_RULES): one source of truth.
// * Words that must never be published (your employer, your OS user name, product code names ...) are NOT stored
//   in this repository, in any encoding. You supply them at scan time:
//     JEV_SCAN_EXTRA_B64="<base64>,<base64>"      comma separated, base64 of UTF-8
//     JEV_SCAN_DENYLIST_FILE=<path>               one word per line; '#' comments; 'b64:<base64>' lines allowed
//     ~/.config/jev-harness/denylist.txt          read automatically when it exists
//
//   node scripts/security_scan.mjs [dir] [--history]     (--history also scans every commit: patches + metadata)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_RULES, configDir, expandHome, isMain } from './jev_client.mjs';

const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const KATAKANA = 'ァ-ヶー';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Extra, non-secret rules that only make sense for a repository scan. */
export const PATTERN_RULES = [
  ...SECRET_RULES.map(({ id, re }) => ({ id, re })),
  { id: 'uuid_session_id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
  { id: 'phone_number_jp', re: /\b0\d{1,4}-\d{1,4}-\d{4}\b/ },
];

/** User-supplied forbidden words from the environment / files. Returns { terms, sources }. */
export function loadDenylist(env = process.env) {
  const terms = [];
  const sources = { env: 0, file: 0 };
  for (const enc of String(env.JEV_SCAN_EXTRA_B64 || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const w = b64(enc).trim();
    if (w) {
      terms.push(w);
      sources.env++;
    }
  }
  const file = env.JEV_SCAN_DENYLIST_FILE ? expandHome(env.JEV_SCAN_DENYLIST_FILE) : path.join(configDir(env), 'denylist.txt');
  try {
    if (fs.existsSync(file)) {
      for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const w = line.startsWith('b64:') ? b64(line.slice(4).trim()).trim() : line;
        if (w) {
          terms.push(w);
          sources.file++;
        }
      }
    }
  } catch {
    /* an unreadable denylist is reported as zero terms; doctor/README explain where it lives */
  }
  return { terms: [...new Set(terms)], sources };
}

export function denylistRules(env = process.env) {
  return loadDenylist(env).terms.map((word, i) => {
    const kata = new RegExp(`^[${KATAKANA}]+$`).test(word);
    // katakana words must not match inside longer katakana words (a short term would hit unrelated loanwords)
    const src = kata ? `(?<![${KATAKANA}])${escapeRe(word)}(?![${KATAKANA}])` : escapeRe(word);
    return { id: `denylist_term_${i}`, re: new RegExp(src, 'i') };
  });
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.jev-state']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.wav', '.mp3', '.webm', '.m4a', '.ogg', '.flac', '.zip', '.gz', '.pdf']);

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) yield* walk(path.join(dir, ent.name));
    } else if (ent.isFile() && !BINARY_EXT.has(path.extname(ent.name).toLowerCase())) {
      yield path.join(dir, ent.name);
    }
  }
}

/** Scan one text blob. Returns [{ rule, line }] (never the matched text). */
export function scanText(text, rules = [...PATTERN_RULES, ...denylistRules()]) {
  const findings = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const r of rules) if (r.re.test(line)) findings.push({ rule: r.id, line: i + 1 });
    });
  return findings;
}

export function scanRepo(root, env = process.env) {
  const rules = [...PATTERN_RULES, ...denylistRules(env)];
  const findings = [];
  let files = 0;
  for (const file of walk(root)) {
    files++;
    const rel = path.relative(root, file).split(path.sep).join('/');
    for (const f of scanText(rel, rules)) findings.push({ file: rel, line: 0, rule: f.rule, where: 'path' });
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const f of scanText(text, rules)) findings.push({ file: rel, ...f, where: 'content' });
  }
  return { files, findings };
}

/** Scan commit metadata + every patch ever committed (all refs). No-op when `root` is not a git repo. */
export function scanGitHistory(root, env = process.env) {
  if (!fs.existsSync(path.join(root, '.git'))) return { commits: 0, findings: [] };
  const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  let log = '';
  let commits = 0;
  try {
    commits = Number(run(['rev-list', '--all', '--count']).trim()) || 0;
    if (commits === 0) return { commits: 0, findings: [] };
    log = run(['log', '--all', '-p', '--format=COMMIT %H%nAUTHOR %an <%ae>%nCOMMITTER %cn <%ce>%nMESSAGE %B']);
  } catch {
    return { commits, findings: [{ file: '(git)', line: 0, rule: 'git_history_unreadable', where: 'history' }] };
  }
  const findings = scanText(log, [...PATTERN_RULES, ...denylistRules(env)]).map((f) => ({ file: '(git history)', ...f, where: 'history' }));
  return { commits, findings };
}

function main() {
  const argv = process.argv.slice(2);
  const history = argv.includes('--history');
  const dirArg = argv.find((a) => !a.startsWith('--'));
  const root = path.resolve(dirArg || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (!fs.existsSync(root)) {
    console.error(`not found: ${path.basename(root)}`);
    process.exitCode = 2;
    return;
  }
  const deny = loadDenylist();
  const r = scanRepo(root);
  const h = history ? scanGitHistory(root) : { commits: 0, findings: [] };
  const all = [...r.findings, ...h.findings];
  for (const f of all) console.log(`FINDING ${f.rule} ${f.file}:${f.line} (${f.where})`);
  console.log(`${all.length} findings (${r.files} files${history ? `, ${h.commits} commits` : ''} scanned; ${deny.terms.length} denylist terms loaded)`);
  process.exitCode = all.length ? 1 : 0;
}

if (isMain(import.meta.url)) main();
