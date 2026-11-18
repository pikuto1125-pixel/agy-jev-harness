#!/usr/bin/env node
import { lintFile, renderJson, renderMarkdown, writeFileAtomic, VERSION } from '../src/linter.mjs';

const HELP = `retro-lint ${VERSION} - post-mortem and session failure linter

Usage:
  retro-lint <logfile> [--format json|md] [--threshold 2] [--out file]

Options:
  --format json|md   report format (default: md)
  --json             same as --format json
  --threshold N      failures of one signature allowed before escalation (default: 2)
  --out file         write the report to a file instead of stdout
  -h, --help         show this help
  --version          print the version

Exit codes: 0 clean, 1 escalation required or a high finding, 2 bad usage or unreadable file.
`;

function fail(msg) {
  process.stderr.write(`retro-lint: ${msg}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(HELP); process.exit(0); }
if (argv.includes('--version')) { process.stdout.write(VERSION + '\n'); process.exit(0); }

let file = ''; let format = 'md'; let threshold = 2; let out = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
  if (a === '--format') format = val();
  else if (a === '--json') format = 'json';
  else if (a === '--threshold') {
    const v = val();
    if (!/^[1-9]\d*$/.test(v)) fail(`--threshold must be a positive integer, got "${v}"`);
    threshold = Number(v);
  } else if (a === '--out') out = val();
  else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else if (file) fail(`unexpected extra argument ${a}`);
  else file = a;
}
if (!file) fail('missing <logfile> (see --help)');
if (format !== 'json' && format !== 'md') fail(`--format must be json or md, got "${format}"`);

let report;
try { report = lintFile(file, { threshold }); } catch (e) { fail(`cannot read ${file}: ${e.code || e.message}`); }
const text = format === 'json' ? renderJson(report) : renderMarkdown(report);
if (out) {
  try { writeFileAtomic(out, text); } catch (e) { fail(`cannot write ${out}: ${e.code || e.message}`); }
  process.stdout.write(`wrote ${out} (escalate=${report.escalate}, findings=${report.findings.length})\n`);
} else process.stdout.write(text);
process.exitCode = report.escalate || report.summary.by_severity.high > 0 ? 1 : 0;
