# Release notes

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
