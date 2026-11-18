#!/usr/bin/env node
import fs from 'node:fs';
import { buildPortal, resolveId, verifyPortal, VERSION, DEFAULT_EXTENSIONS } from '../src/portal.mjs';

const HELP = `shortlink-portal ${VERSION} - pure-ASCII shortlink portal and static index builder

Usage:
  shortlink-portal build <inDir> <outDir> [--title T] [--ext .html,.md,.pdf,.txt] [--html-mode copy|redirect] [--list file] [--force] [--json]
  shortlink-portal resolve <manifest> <id> [--json]
  shortlink-portal verify <outDir> [--json]

build    maps deliverables to /m/id/<10hex>.html (10 hex = sha256 of the normalised relative path),
         writes redirect stubs or HTML copies, index.html (searchable, self-contained) and manifest.json.
         --list file reads one relative path per line instead of walking <inDir>.
         --force allows a non-empty <outDir> without manifest.json.
resolve  prints the original relative path for an id (bare hex, <hex>.html, /m/id/<hex>.html or a URL).
verify   checks a built portal (ids, hashes, ASCII URLs, no external resources).

Default extensions: ${DEFAULT_EXTENSIONS.join(' ')}

Options:
  --json         machine-readable output
  -h, --help     show this help
  --version      print the version

Exit codes: 0 success, 1 rejected unsafe paths / id not found / verification issues, 2 bad usage or unreadable input.
`;

function fail(msg) {
  process.stderr.write(`shortlink-portal: ${msg}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(HELP); process.exit(0); }
if (argv.includes('--version')) { process.stdout.write(VERSION + '\n'); process.exit(0); }

const cmd = argv[0];
if (!['build', 'resolve', 'verify'].includes(cmd)) fail(`unknown or missing subcommand "${cmd ?? ''}" (expected build, resolve or verify; see --help)`);
const pos = []; let json = false; let title; let ext; let htmlMode; let list; let force = false;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
  if (a === '--json') json = true;
  else if (a === '--force' && cmd === 'build') force = true;
  else if (a === '--title') title = val();
  else if (a === '--ext') ext = val().split(',').map((x) => x.trim()).filter(Boolean);
  else if (a === '--html-mode') htmlMode = val();
  else if (a === '--list') list = val();
  else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else pos.push(a);
}
const need = cmd === 'verify' ? 1 : 2;
if (pos.length !== need) fail(`${cmd} needs ${need} argument(s), got ${pos.length} (see --help)`);
const out = (obj, text) => process.stdout.write(json ? JSON.stringify(obj, null, 2) + '\n' : text);

if (cmd === 'build') {
  let files;
  if (list) {
    try { files = fs.readFileSync(list, 'utf8').split(/\r?\n/).filter((l) => l.trim()); } catch (e) { fail(`cannot read list ${list}: ${e.code || e.message}`); }
  }
  let r;
  try { r = buildPortal(pos[0], pos[1], { title, extensions: ext, htmlMode, files, force }); } catch (e) { fail(e.message); }
  const lines = [`built ${r.count} page(s) into ${pos[1]}`, `index: ${r.index}  manifest: ${r.manifest}`];
  for (const s of r.skipped) lines.push(`rejected: ${s.path} (${s.reason})`);
  out(r, lines.join('\n') + '\n');
  process.exitCode = r.ok ? 0 : 1;
} else if (cmd === 'resolve') {
  let e;
  try { e = resolveId(pos[0], pos[1]); } catch (err) { fail(`cannot read manifest ${pos[0]}: ${err.code || err.message}`); }
  out(e, e ? `${e.path}\n` : '');
  if (!e) { process.stderr.write(`shortlink-portal: id not found: ${pos[1]}\n`); process.exitCode = 1; }
} else {
  if (!fs.existsSync(pos[0])) fail(`path not found: ${pos[0]}`);
  const r = verifyPortal(pos[0]);
  out(r, [...r.issues.map((i) => `${i.code}${i.id ? ' ' + i.id : ''}: ${i.message}`), r.ok ? `OK (${r.count} entries)` : `FAIL (${r.issues.length} issue(s))`].join('\n') + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
