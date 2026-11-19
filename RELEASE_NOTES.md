# Release notes

## v0.3.0

### Highlights

- **Zero-token prose slop gate (`scripts/prose_slop_gate.mjs`)**: Deterministic offline checks for AI vendor citation residue (`oaicite`, `[cite: ...]`, `grok_card`, `ppl-ai-file-upload`, `:::writing`, `<think>`, placeholders), EN/JA AI boilerplate phrasing, and short-post SNS hygiene (excess hashtags, reply-link prompts, filler closings, weighted length bounds when `--kind sns|x_post` or on `x_post*`/`tweet*`/`sns/` paths). Matches inside Markdown code fences, inline backticks, and `<code>`/`<pre>` spans are ignored so documentation and technical references do not trigger false positives. Issues and verifies SHA-256 pass receipts (`check` / `verify`) normalized across CRLF/LF without storing raw home paths.
- **Slash-command-free 4-way utterance intent routing (`scripts/smart_router.mjs`)**: Classifies turns into `directive`, `ruling`, `musing`, or `question` using both an offline deterministic heuristic (`classifyIntentHeuristic`) and `gemini-decision-1` `choice` scoring (`INTENT_QUESTION`). Works with or without leading slash commands, surfaces advisory hints for `ruling` and `musing` (at confidence >= 0.6), and keeps ordinary turns silent.
- **AGY 1.5.12 lifecycle hooks (`hooks.json` & `scripts/hook_entry.mjs`)**:
  - `PostToolUse` hook on file write/edit tools rolls back pending draft-gate state reservations when a write tool fails (`error` / `isError` / `status === "error"`).
  - `PreToolUse` draft-prose guard checks `.md`/`.txt` draft-style paths (`drafts/`, `posts/`, `outreach/`, `x_post*`, etc.) when full text is known and `JEV_GUARD_MODE != off`, blocking unmasked vendor residue and reserving a post-write check otherwise.
  - `Stop` hook honors `continuationActive` (and `continuation_active`) by taking a fast lightweight skip path without mutating state or appending stop telemetry.

### Changed

- `package.json` and `plugin.json` bumped from `0.2.0` to `0.3.0`.
- `scripts/telemetry.mjs` adds `stop` (`stop_events.jsonl`) for non-continuation stop summaries (`terminationReason`, `hasError`, and `continuationActive` flags only, zero user text).
- `README.md`, `README.ja.md`, `skills/jev-harness/SKILL.md`, and `tests/plugin.test.mjs` updated for v0.3.0.

### Integrity

`SHA256SUMS-v0.3.0.txt` records the SHA-256 checksum of the clean distribution archive `agy-jev-harness-v0.3.0.zip`.

## v0.2.0

### Highlights

- **Three modular free CLI tools under `packages/`**, each MIT-licensed, dependency-free (Node 20 or newer) and usable on its own:
  - `micro-02-retro-failure-linter` (`retro-lint`): lints agent session logs for repeated failures, unverified claims, bypassed guardrails, scope creep and tool misuse.
  - `micro-03-cognitive-wiki-and-u-gate` (`wiki-ugate`): lints a Markdown wiki and gates unresolved `[U]` markers and unsourced statistics.
  - `micro-04-shortlink-deliverable-portal` (`shortlink-portal`): builds and verifies a static, ASCII-only shortlink portal from a folder of deliverables.
- **Bilingual documentation.** Each package ships `README.md` and `README.ja.md`; the top-level README files gain a matching `v0.2.0` section in English and Japanese.
- **Offline verification.** Every package has its own test suite (`node --test` inside the package folder). No network access or API key is needed.
- **Pre-release security review.** The standalone ZIP builds of these three packages went through a four-round independent adversarial review. Round 4 returned PASS with 0 critical, 0 high, 0 medium and 2 low observations, neither blocking. Deterministic secret / path / ZIP scans and the repository history scan report 0 findings.

### Changed

- `package.json` and `plugin.json` version bumped from `0.1.0` to `0.2.0`.
- Existing harness scripts, hooks, rules and the AGY plugin behaviour are unchanged.

### Integrity

`SHA256SUMS-FREE-v0.2.0.txt` lists the SHA-256 of the three standalone free ZIPs (`free-02`, `free-03`, `free-04`, each built as `v1.0.0` packages). Verify a download with:

```bash
sha256sum -c SHA256SUMS-FREE-v0.2.0.txt
```

### Notes

- The tools in `packages/` are versioned `1.0.0` internally; the repository release is `0.2.0`.
- Separate paid micro-packs and a Master bundle exist outside this repository.
