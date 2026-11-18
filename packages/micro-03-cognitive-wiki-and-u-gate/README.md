# cognitive-wiki-and-u-gate

Two small checks for a Markdown knowledge base that AI agents and people both write into:

1. **Wiki linter** (`wiki-ugate lint <dir>`): one role per file, short entrypoints, no broken links, no orphan pages.
2. **[U] Unverified-Claim Gate** (`wiki-ugate ugate <file|dir>`): blocks CI or a release while unresolved `[U]` markers, bare estimates or unsourced statistics remain.

Zero dependencies, Node 20 or newer, MIT licensed, offline, deterministic. Part of the Jev Harness family (see the end).

## What it checks

### Wiki linter

| Rule | Flags |
| --- | --- |
| `multi_role` | A file declaring more than one distinct role: `role:` / `roles:` in front matter (scalar, comma list, `[a, b]` or a YAML list) and `## Role: x` headings. The same role repeated is fine. |
| `entrypoint_too_long` | An entrypoint file (`index.md`, `README.md`, `root.md`, at any depth, case-insensitive) with more than 200 lines (`--max-lines`). |
| `broken_link` | A relative Markdown link, image, reference definition (`[x]: path`) or `[[wikilink]]` whose target does not exist. External URLs (`https:`, `mailto:` ...) and `#anchors` are not checked. Links inside code spans and fenced code are ignored. |
| `orphan` | A Markdown page not reachable from the root entrypoint by following links. |
| `missing_entrypoint` | No `index.md`, `README.md` or `root.md` in the wiki root (override with `--entry`). The orphan check is skipped in that case. |

Link rules: targets are resolved relative to the linking file; `/x.md` means relative to the wiki root; `%XX` escapes are decoded; a missing `.md` extension is tried; a link to a directory resolves to its index/README/root page. Matching is case-sensitive so results do not change between Windows and Linux. `[[Name|alias#heading]]` matches a page by file name (without extension) or by path suffix, case-insensitively.

### [U] gate

| Rule | Flags |
| --- | --- |
| `unresolved_u` | A `[U]` marker (also `[U?]`, `[U: note]`) that is still open. |
| `bad_resolution` | `[U→verified: ]` with an empty source, or an arrow form without `verified:`. |
| `bare_estimate` | A hedged number presented as fact: "about 40% faster", "roughly $200", "約40%" with no evidence nearby. |
| `unsourced_stat` | A percentage, a dollar/euro/pound/yen figure, or "N users/customers/downloads/..." (also 万人, 3000人, 円) with no evidence nearby. |

A resolved claim is written `[U→verified: <source>]` (the ASCII form `[U->verified: <source>]` also works). It is allowed and counted in `resolved`.

"Evidence nearby" means, on the same line or within `--window` lines (default 1) above or below: a URL, a Markdown link, `[source: ...]`, `[src: ...]`, `[cite: ...]`, a footnote `[^1]`, `Source:`, `(source ...)` or 出典. The tags `[est]` and `[U]` only cover their own line.

Fenced code blocks and inline code are skipped unless `--include-code` is given, so documentation can mention `[U]` without failing.

## 30-second quickstart

```bash
cd micro-03-cognitive-wiki-and-u-gate
mkdir -p demo/ops
printf '# Home\n- [Runbook](ops/runbook.md)\n- [Missing](ops/gone.md)\n' > demo/index.md
printf -- '---\nrole: runbook\n---\n# Runbook\nRestarts are about 40%% faster.\nWe serve 5,000 users [U].\n' > demo/ops/runbook.md
printf '# Stray\n' > demo/stray.md

node bin/wiki-ugate.mjs lint demo
node bin/wiki-ugate.mjs ugate demo
```

Output (abridged; exit code 1 both times):

```text
wiki lint: demo (3 pages, entry index.md)
index.md:3  broken_link  broken link "ops/gone.md": target does not exist
stray.md:1  orphan  not reachable from index.md; link it from an index or remove it
FAIL: 2 finding(s) {"broken_link":1,"orphan":1}

u-gate: demo (3 file(s))
ops/runbook.md:5:14  bare_estimate  estimate "about 40%" is stated as fact; add a source link, [source: ...], or tag it [est] or [U]
ops/runbook.md:6:22  unresolved_u  unresolved [U] marker; verify it and replace with [U→verified: <source>] or remove the claim
FAIL: 2 finding(s) {"bare_estimate":1,"unresolved_u":1}
```

In CI, run `node bin/wiki-ugate.mjs ugate docs/ && node bin/wiki-ugate.mjs lint docs/`; either non-zero exit fails the job.

## CLI reference

```text
wiki-ugate lint <dir>        [--json] [--entry file] [--max-lines N] [--ignore prefix]
wiki-ugate ugate <file|dir>  [--json] [--window N] [--include-code] [--ignore prefix]
```

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--json` | both | JSON output instead of text. |
| `--entry file` | lint | Root entrypoint, relative to `<dir>` (default: `index.md`, then `README.md`, then `root.md`). |
| `--max-lines N` | lint | Entrypoint line limit (default 200). |
| `--window N` | ugate | Lines above and below searched for evidence (default 1). |
| `--include-code` | ugate | Also scan fenced code blocks. |
| `--ignore prefix` | both | Skip a path prefix (repeatable), for example `--ignore archive`. |
| `-h`, `--help`, `--version` | | Usage; prints `1.0.0`. |

`ugate` on a directory scans `.md`, `.markdown`, `.txt`, `.html` and `.htm` files. Dot-directories are always skipped.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Pass. |
| 1 | Findings (gate failure). |
| 2 | Bad argument, unknown subcommand, missing path, or `lint` given a file. |

## JavaScript API

```js
import { lintWiki, scanUnverifiedClaims, scanPath } from 'cognitive-wiki-and-u-gate';

const wiki = lintWiki('./docs', { maxEntryLines: 200, ignore: ['archive'] });
const claims = scanUnverifiedClaims('Latency is about 40% lower.');
if (!claims.ok) for (const f of claims.findings) console.log(`${f.line}:${f.column} ${f.rule}`);
```

| Export | Purpose |
| --- | --- |
| `lintWiki(dir, {maxEntryLines, entry, ignore})` | Wiki lint result. |
| `scanUnverifiedClaims(textOrPath, {fromFile, window, includeCode, file})` | Scan one document. Input is literal text by default. Pass `{ fromFile: true }` to read a file. Use `scanPath` to scan a file or directory. |
| `scanPath(fileOrDir, {window, includeCode, ignore})` | Gate on a file or directory. |

The scanner checks the first 8,192 characters of each line.
| `renderLintText(result)` / `renderGateText(result)` | Human-readable reports. |
| `VERSION`, `DEFAULTS` | Constants. |

### Result schemas

```json
{ "ok": false, "dir": "docs", "entry": "index.md", "files": 3,
  "findings": [ { "rule": "broken_link", "severity": "error", "file": "index.md", "line": 3, "message": "..." } ],
  "counts": { "broken_link": 1 } }
```

```json
{ "ok": false, "input": "docs", "files": 3,
  "findings": [ { "rule": "unresolved_u", "severity": "error", "file": "ops/runbook.md", "line": 6, "column": 22, "text": "[U]", "message": "..." } ],
  "resolved": [ { "file": "a.md", "line": 2, "source": "vendor docs" } ],
  "counts": { "unresolved_u": 1 } }
```

Findings are sorted by file, then line. `file` uses forward slashes. Every finding is an error; `ok` is true only when there are none.

## Limits and honest caveats

- The statistic and estimate rules are heuristics. They see numbers next to units, not meaning. Expect some false positives (a "100%" in a spec, a price in a pricing table that is the source itself) and some misses (a number written in words). Silence a line by adding a source link or `[est]`.
- Evidence is detected by shape (a link, a `[source:` tag), not by checking that the source supports the claim and not by fetching it. The tool never touches the network.
- Wiki links are checked against files on disk only. Anchors (`#heading`) and external URLs are not validated.
- Roles are read from the literal `role:` / `roles:` keys and `Role:` headings; other conventions are invisible to the linter.
- Only `.md` and `.markdown` files are pages for the wiki linter. Symlinked directories are not followed.
- Japanese is supported for the estimate and count patterns (約, およそ, ほぼ, 倍, 割, 万, 人, 社, 件, 円) and file names, but not for general claim detection.

## Part of the family

- Tier 1 (free, MIT): this package, `micro-02-retro-failure-linter`, `micro-04-shortlink-deliverable-portal`, and the Free Pack `progressive-context-slicer`.
- Tier 2: paid micro-packs.
- Tier 3: Master Edition "Autonomous HQ OS".
- Public companion repo: `agy-jev-harness`.

## License

MIT, see `LICENSE`.
