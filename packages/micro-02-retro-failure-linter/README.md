# retro-failure-linter

A post-mortem linter for AI agent session logs. It reads a JSONL or Markdown transcript, groups recurring failures, flags five failure modes with exact line numbers, and enforces a stop-after-2-failures escalation rule: when the same failure signature shows up a third time, the report says `escalate: true` and the CLI exits 1.

- Zero dependencies, Node 20 or newer, MIT licensed.
- Offline and deterministic: same log in, same report out. No network, no timestamps.
- Part of the Jev Harness family (see the end of this file).

## What it checks

| Mode | Meaning | Typical trigger |
| --- | --- | --- |
| `repeat_failure` | The same failure keeps coming back. | Same normalised error 2 or more times; more than `--threshold` times sets `escalate:true`. |
| `unverified_claim` | "Done / fixed / all tests pass" with no evidence before it. | Claim line with no passing tool result in the previous 8 events (high severity if a failure is still unresolved). |
| `guardrail_drift` | A protection was bypassed. | `--no-verify`, `git push --force`, `rm -rf`, `--dangerously-*`, "skip the tests", "disable the hooks". |
| `scope_creep` | Work expanded past the request. | "while I'm at it", "let me also", "out of scope", "also refactored". |
| `tool_misuse` | The tool was called wrongly or in a loop. | "unknown option", "missing required", "command not found", ENOENT, or the same call 3 times in a row. |

### Escalation rule

A failure **signature** is the tool name plus the first failing line after normalisation (numbers, paths, file names, hashes, URLs and timestamps are replaced, so `Cannot find module ./gen-12.js` and `Cannot find module ./gen-97.js` are one signature).

With the default threshold of 2:

- 2 failures of one signature: finding `repeat_failure` (medium), `escalate_next: true`. The next attempt must escalate, not retry. If an escalation message (escalate, hand off, blocked, ask the user) already follows the second failure, the signature is marked `acknowledged` and no finding is raised.
- 3 or more failures: `escalate: true`, finding `repeat_failure` (high) pointing at the third failure line, and a human-readable `escalation_reason`.

## 30-second quickstart

```bash
cd micro-02-retro-failure-linter
cat > session.jsonl <<'EOF'
{"role":"user","type":"message","text":"make the build pass"}
{"role":"tool","type":"tool_result","tool":"npm","status":"error","text":"Error: Cannot find module './gen-12.js'"}
{"role":"tool","type":"tool_result","tool":"npm","status":"error","text":"Error: Cannot find module './gen-97.js'"}
{"role":"tool","type":"tool_result","tool":"npm","status":"error","text":"Error: Cannot find module './gen-3.js'"}
{"role":"assistant","type":"message","text":"Fixed, the build is done."}
EOF
node bin/retro-lint.mjs session.jsonl                      # Markdown report to stdout
node bin/retro-lint.mjs session.jsonl --format json --out report.json
echo $?                                                    # 1: third failure of one signature, plus an unverified claim
```

The report names line 4 as the third failure of `npm|error: cannot find module ...`, sets `escalate: true`, and flags line 5 ("Fixed, done") as a claim made after an unresolved failure.

## Accepted log shapes

Every line is tried as JSON first; a line that does not parse as a JSON object is treated as free-form text, so JSONL, Markdown and mixed files all work. CRLF line endings and a UTF-8 BOM are handled. Line numbers in findings are 1-based physical line numbers of the input file.

JSONL events (all fields optional):

```json
{"role":"assistant","type":"tool_call","tool":"bash","input":{"command":"npm test"}}
{"role":"tool","type":"tool_result","tool":"bash","status":"error","exit_code":1,"text":"Error: ..."}
{"role":"assistant","type":"message","text":"All tests pass."}
```

| Field | Used for |
| --- | --- |
| `role` | `user`, `assistant`, `system`, `tool` (aliases: human, ai, claude, function). User and system lines are never flagged. |
| `type` | `tool_call`, `tool_result`, `message`, `error`. |
| `tool` (or `tool_name`, `name`) | Part of the failure signature. |
| `status` | `error`, `failed`, `timeout`, `denied` count as failure; `ok`, `success`, `passed` count as evidence. |
| `exit_code` (or `exitCode`) | Non-zero is a failure, zero is evidence. |
| `text` (or `content`, `message`, `error`, `output`, `stderr`, `result`) | Message body; `content` may be a string or an array of `{text}` parts. |
| `input` (or `args`, `arguments`, `params`) | Scanned for guardrail bypass flags and loop detection. |

Markdown or free-form lines:

```text
**User:** fix the build
Assistant: running the tests
Tool: npm test
Error: Cannot find module ./gen-12.js
- exit code 2
Assistant: Done, fixed.
```

Role markers (`User:`, `**Assistant:**`, `## Tool`, `Claude:`) set the role for the lines that follow. A `Tool: name` or `` Ran `cmd` `` line sets the tool for following lines. A line is a failure when it matches `Error:`, `Traceback`, `FAIL`, `exit code N` (non-zero), `command not found`, `permission denied`, `ENOENT`, a leading `error`/`fatal`, a failure mark, or, outside assistant prose, the words "failed" / "timed out".

## CLI reference

```text
retro-lint <logfile> [--format json|md] [--threshold 2] [--out file]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--format json\|md` | `md` | Report format. `--json` is an alias for `--format json`. |
| `--threshold N` | `2` | Failures of one signature allowed before the next attempt must escalate. |
| `--out file` | stdout | Write the report atomically (temp file + rename) and print a one-line summary. |
| `-h`, `--help` | | Usage. |
| `--version` | | Prints `1.0.0`. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No escalation and no high-severity finding. |
| 1 | `escalate:true` or at least one high finding. |
| 2 | Bad argument, missing or unreadable file. |

## JavaScript API

```js
import { lintFile, lintLog, renderMarkdown, renderJson, normaliseSignature } from 'retro-failure-linter';

const report = lintFile('session.jsonl', { threshold: 2 });
if (report.escalate) console.error(report.escalation_reason);
console.log(renderMarkdown(report));
```

| Export | Purpose |
| --- | --- |
| `lintLog(text, {threshold, source})` | Lint a string, returns the report object. Throws `RangeError` for a threshold below 1. |
| `lintFile(path, opts)` | Read a UTF-8 file and lint it. |
| `parseLog(text)` | Returns `{events, warnings, jsonLines, textLines}`. |
| `normaliseSignature(text)` | The normaliser used for clustering. |
| `renderMarkdown(report)` / `renderJson(report)` | Report text. |
| `writeFileAtomic(file, data)` | Temp file + rename. |
| `VERSION`, `FAILURE_MODES`, `DEFAULT_THRESHOLD` | Constants. |

### Report schema

```json
{
  "tool": "retro-lint", "version": "1.0.0", "source": "session.jsonl",
  "threshold": 2, "format": "jsonl|markdown|mixed",
  "events": 8, "failures": 3,
  "escalate": true, "escalate_next": false, "escalation_reason": "signature ... failed 3 times (lines 3, 5, 7); ...",
  "ok": false,
  "summary": { "by_mode": { "repeat_failure": 1, "...": 0 }, "by_severity": { "high": 3, "medium": 0, "low": 0 } },
  "signatures": [ { "signature": "npm|error: ...", "tool": "npm", "count": 3, "lines": [3,5,7], "acknowledged": false } ],
  "findings": [ { "id": "F001", "mode": "guardrail_drift", "severity": "high", "line": 6,
                  "message": "...", "evidence": "...", "recommendation": "..." } ],
  "warnings": []
}
```

Findings are sorted by line, then mode. `ok` is true when there is no escalation and no high finding.

## Limits and honest caveats

- This is a pattern-based linter, not a judge. It can miss failures phrased in unusual ways and can flag harmless text. Treat findings as review prompts.
- Pattern lists cover English plus a small set of Japanese phrases. Other languages are not detected.
- `unverified_claim` looks 8 events back for a passing tool result. Evidence that appears further back, or only in prose, is not seen. Put proof in the same line, e.g. `(verified: npm test exit 0)`.
- `guardrail_drift` and `scope_creep` skip user and system lines and ignore matches directly preceded by "never", "do not", "avoid" and similar. Negation handling is shallow.
- Markdown role detection is line based; a transcript without role markers is treated as one unknown speaker.
- Expensive pattern matches use up to the first 4,096 characters of each line.
- Signature clustering is lossy by design: two different errors that differ only in numbers or paths count as one.
- The escalation rule reports the violation after the fact; it cannot stop a live agent.

## Part of the family

- Tier 1 (free, MIT): this package, `micro-03-cognitive-wiki-and-u-gate`, `micro-04-shortlink-deliverable-portal`, and the Free Pack `progressive-context-slicer`.
- Tier 2: paid micro-packs.
- Tier 3: Master Edition "Autonomous HQ OS".
- Public companion repo: `agy-jev-harness`.

## License

MIT, see `LICENSE`.
