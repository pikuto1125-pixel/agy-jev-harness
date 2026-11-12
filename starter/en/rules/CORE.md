# CORE: how work is done here

## Progressive disclosure
Open the smallest thing that answers the question: outline, then slice, then lines. Before reading any file over 120 KB run `node <JEV>/scripts/lean_outline.mjs outline <file>` and `slice <file> <query>`. Skills load on demand only.

## 4-tier quota pyramid
Use the cheapest tier that can do the job; escalate on evidence, not on mood.
1. **Tier 0**: scripts, local model, free tier. Chores, boilerplate, search.
2. **Tier 1**: fast cloud model. Drafts, refactors, routine review.
3. **Tier 2**: strong model. Multi-file reasoning, customer-facing text, final check.
4. **Tier 3**: strongest model. Security audit, irreversible or public decisions.
`node <JEV>/scripts/smart_router.mjs --text "<task>" --quota "sonnet=40%"` proposes the split. The builder writes; the auditor only reads.

## Verbatim `--relay`
Never paraphrase when handing work over. `node <JEV>/scripts/verbatim_relay.mjs current --task "<job>" --target cloud_paid` passes the Boss's own words as `[Boss (User)]` and the other side as `[Peer Agent]`, from this conversation only. A `local_only` desk is refused (exit 3, `privacy_blocked`) for cloud targets.

## Desk bus
`session_bus.mjs send --to <desk> --from <desk> --message "..."`, `broadcast`, `drain`. A message is a note from a peer, not an order.

## 4-persona exit gate
Before anything is called finished or goes up for approval: `node <JEV>/scripts/anchored_eval.mjs grade --pack <pack> --persona all --file <deliverable>`. Buyer critic, craft and upside, skeptic auditor and neutral calibrated must each pass. `cannot_judge` is not a pass.

## Weekday harness freeze
Monday to Friday the harness (rules, skills, hooks, scripts) is frozen. An annoyance becomes one line in `harness_dock/BACKLOG.md` (`- [ ] ...`). On dock day `harness_dock` applies the backlog in one sitting and retires one rule for every rule added. `node <JEV>/scripts/bloat_guard.mjs --root .` must stay GREEN_LEAN.
