# HARNESS_SPEC (open only when changing the harness)

## Compaction-first desks
- One desk = one long-lived conversation with one job. It is never replaced by a fresh thread.
- Context fills up: the platform compacts. Right after, the desk re-reads `Tasks/handover_now.md` and its role file; the nuance rescue re-injects the Boss's constraints.
- Before a long stretch ends, the desk rewrites its section of `handover_now.md` (focus, open threads, the Boss's verbatim constraints, next 3 steps).

## Files
- `Tasks/sessions_keep.json`: desks, bound conversation ids, privacy (`cloud_ok` | `local_only`), `dockDay`.
- `Tasks/decisions_open.md`: questions only the Boss can answer. One line each; the coordinator asks, the Boss answers.
- `Tasks/_bus/`: desk messages (runtime state, git-ignored).
- `harness_dock/BACKLOG.md`, `harness_dock/WEEKLY_DIGEST.md`: the weekly loop (`dock_feeder.mjs digest`).
- `_backups/`: originals copied here before any overwrite or delete.

## Exit codes
`0` ok, `1` fail, `2` usage, `3` cannot judge / privacy blocked, `4` locked (voice confirmation).

## Changing the harness
Only on dock day. Add a rule only after retiring one. Re-run `bloat_guard.mjs` and the tests of any script you touched; report the observed result, not the intention.
