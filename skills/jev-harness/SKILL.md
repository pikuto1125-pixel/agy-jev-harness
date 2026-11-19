---
name: jev-harness
description: Use when the user wants to run the jev-harness doctor, route a task to a model lane or role split, relay a conversation to a sub-agent without losing their wording, rescue nuance after context compaction, grade a deliverable with the three-layer rubric gate, review harness bloat, or scan before a public release.
---

# Jev Harness

All commands are plain Node (>= 20) scripts in this plugin's `scripts/` directory, with no npm packages. `$PLUGIN_ROOT` is the
plugin folder (installed copies live in `~/.gemini/config/plugins/jev-harness`); use these absolute forms from any workspace.
Without an opted-in Gemini key every command runs a deterministic zero-token heuristic and says so in `source`.

## 0. Doctor (run this first)

```bash
node "$PLUGIN_ROOT/scripts/jev_client.mjs" doctor --offline
```

Checks node, manifest, state dir, key opt-in, hooks.json, and the real hook entry (ordinary turn stays silent, a force-push gets
`ask`). Drop `--offline` to add one live ping when a key is opted in. Exit code 1 means a check failed; read `checks` and `nextSteps`.

## 1. Router and role split (0 output tokens)

```bash
node "$PLUGIN_ROOT/scripts/smart_router.mjs" --text "<the user's request>" [--quota "sonnet=40%,claude=0"] [--models "flash,carbon,argon,local"]
```

- Lane `lite` / `standard` / `deep` / `guarded` from 8 axes; 4-way `intent` (`directive` / `ruling` / `musing` / `question`, works without leading slash commands); `roles` from `allocateModelRoles()` using 4 more axes.
- Only enabled slots with quota take part. `--models` / `JEV_MODELS` lists the slots you have (no Claude plan? leave Claude out).
  `claude=0` zeroes a whole family. Add or retune slots in `<config dir>/model_profiles.json` (start from `config/model_profiles.example.json`).
  Slots of one `pool` share an allowance: `--quota carbon=5%` also limits `argon` and `flash` (lookup: slot id, pool, family, lowest explicit sibling).
- Note `no_independent_auditor:audit_skipped` means a required audit had nobody but the builder; `no_independent_final_reviewer:final_check_skipped` says the same for a required final check. Say so, do not pretend it was done.
  Quota precedence: slot id > pool > family > sibling propagation (`gemini=50%,carbon=5%` gives carbon 0.05, argon / flash 0.50).
- The auditor in a `ROLES:` line reads and reports; it never edits.

## 1b. Prose slop gate and SHA-256 receipts (0 tokens)

```bash
node "$PLUGIN_ROOT/scripts/prose_slop_gate.mjs" check --file <draft.md> [--kind auto|general|sns|x_post] [--strict]
node "$PLUGIN_ROOT/scripts/prose_slop_gate.mjs" verify --file <draft.md> [--max-age-hours 24]
```

Checks EN/JA drafts for AI vendor citation residue outside code/backtick spans, AI boilerplate phrasing, and SNS post limits (max hashtags, reply-link prompts). Issues a SHA-256 pass receipt on pass and verifies file integrity before publishing.

## 2. Verbatim relay and nuance rescue

```bash
node "$PLUGIN_ROOT/scripts/verbatim_relay.mjs" relay --transcript <file.jsonl> --task "<what the sub-agent must do>"
node "$PLUGIN_ROOT/scripts/nuance_rescue.mjs" --transcript <file.jsonl>
```

The relay keeps the human's turns verbatim under `[User (Verbatim)]` (set `JEV_USER_LABEL` to change it). If the judge cannot answer
it keeps everything (score 1.0). The rescue capsule re-surfaces constraints, hedges, both-must-hold conditions and numbers that a
`<CONTEXT_SUMMARY>` would flatten. The hook does this automatically after a real compaction.

## 3. Rubric gate (three layers, four personas)

```bash
node "$PLUGIN_ROOT/scripts/anchored_gate.mjs" grade --pack code_change --persona skeptical_maintainer --file <diff-or-file> [--user <user-words.txt>]
```

Layer 1 physical floor (hard fail) -> layer 2 prohibition warnings -> layer 3 quality scores. Personas: `neutral_calibrated`,
`demanding_buyer_critic`, `skeptical_maintainer`, `first_time_user`. Add `--anchor-good f --anchor-bad f` to prove the rubric can tell
good from bad. Input over 24,000 characters is never cut and graded: the result is `cannot_judge`. Exit codes: 0 pass, 1 fail, 3 cannot_judge.

## 4. Harness dock

```bash
node "$PLUGIN_ROOT/scripts/harness_dock.mjs" bloat-check
node "$PLUGIN_ROOT/scripts/harness_dock.mjs" dock add "idea"
node "$PLUGIN_ROOT/scripts/harness_dock.mjs" dock review
```

## 5. Before publishing anything

```bash
node "$PLUGIN_ROOT/scripts/security_scan.mjs" --history
```

Zero findings is required before a public push. Words you never want published are supplied at scan time through
`JEV_SCAN_EXTRA_B64` or a local `denylist.txt`, never stored in the repository.

## Hooks

`PreInvocation` injects a router hint, a nuance capsule after compaction, or a one-line voice note for a spoken correction.
`PreToolUse` on `run_command` asks (or denies with `JEV_GUARD_MODE=deny`) before destructive commands such as `rm -rf /`
or `git push --force`; ordinary commands are untouched. Shell wrappers (`bash -c`, `pwsh -Command`, `cmd /c`, ...) are opened up to
3 levels deep and judged like the bare command; `sudo` / `doas` / `env` layers (with `-u user`, `-E`, `-n`, `--`, `KEY=VAL`, `-i`) and abbreviated PowerShell options
(`-exec`, `-nop`, `-noni`, `-w`, `-sta`, `-mta`, `-e` / `-ec` / `-enc`, also with a `/` prefix) are peeled off first. `JEV_HARNESS_MODE=off` disables both.
In a workspace (see the `jev-workspace` skill) a whole-file read of a file over 120 KB also gets an `ask`; use `lean_outline.mjs` instead.
