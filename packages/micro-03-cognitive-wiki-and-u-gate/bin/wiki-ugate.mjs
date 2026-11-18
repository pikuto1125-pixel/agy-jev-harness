#!/usr/bin/env node
import fs from 'node:fs';
import { lintWiki, scanPath, renderLintText, renderGateText, VERSION } from '../src/wiki_ugate.mjs';

const HELP = `wiki-ugate ${VERSION} - knowledge wiki linter and [U] unverified-claim gate

Usage:
  wiki-ugate lint <dir>          [--json] [--entry file] [--max-lines N] [--ignore prefix]
  wiki-ugate ugate <file|dir>    [--json] [--window N] [--include-code] [--ignore prefix]

lint   checks 1 role per file, entrypoint <= 200 lines, broken links and [[wikilinks]], orphans.
ugate  blocks unresolved [U] markers, bare estimates and unsourced statistics.
       [U->verified: <source>] (or the arrow character) marks a resolved claim.

Options:
  --json         machine-readable output
  -h, --help     show this help
  --version      print the version

Exit codes: 0 pass, 1 findings (gate failure), 2 bad usage or unreadable path.
`;

function fail(msg) {
  process.stderr.write(`wiki-ugate: ${msg}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(HELP); process.exit(0); }
if (argv.includes('--version')) { process.stdout.write(VERSION + '\n'); process.exit(0); }

const cmd = argv[0];
if (cmd !== 'lint' && cmd !== 'ugate') fail(`unknown or missing subcommand "${cmd ?? ''}" (expected lint or ugate; see --help)`);
let target = ''; let json = false; let entry; let maxLines; let win; let includeCode = false; const ignore = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
  const int = () => { const v = val(); if (!/^\d+$/.test(v)) fail(`${a} must be a non-negative integer, got "${v}"`); return Number(v); };
  if (a === '--json') json = true;
  else if (a === '--entry') entry = val();
  else if (a === '--max-lines') maxLines = int();
  else if (a === '--window') win = int();
  else if (a === '--include-code') includeCode = true;
  else if (a === '--ignore') ignore.push(val());
  else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else if (target) fail(`unexpected extra argument ${a}`);
  else target = a;
}
if (!target) fail(`missing <${cmd === 'lint' ? 'dir' : 'file|dir'}>`);
if (!fs.existsSync(target)) fail(`path not found: ${target}`);
if (cmd === 'lint' && !fs.statSync(target).isDirectory()) fail(`lint needs a directory: ${target}`);

let result;
try {
  result = cmd === 'lint'
    ? lintWiki(target, { entry, maxEntryLines: maxLines, ignore })
    : scanPath(target, { window: win, includeCode, ignore });
} catch (e) { fail(`cannot read ${target}: ${e.code || e.message}`); }
process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : cmd === 'lint' ? renderLintText(result) : renderGateText(result));
process.exitCode = result.ok ? 0 : 1;
