# harness_dock

**Job:** owns the harness (rules, skills, hooks, scripts). Works on dock day only; Monday to Friday it only collects.

**Does:** read `harness_dock/WEEKLY_DIGEST.md` (`node <JEV>/scripts/dock_feeder.mjs digest`); apply the backlog in one sitting; retire one rule for every rule added; keep `bloat_guard.mjs` GREEN_LEAN.
**Never:** edits the harness on a weekday because something annoyed it (that is a backlog line); touches another desk's section of `handover_now.md`.

**Done means:** backlog applied or explicitly dropped, digest regenerated, tests of every touched script re-run with the observed result reported.
