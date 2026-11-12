---
name: voice-conversation-jev
description: Use in voice input or live conversation mode to decide whether the speaker has finished their turn, to clean up spoken self-corrections without losing numbers or negations, and to keep irreversible voice commands locked until they are confirmed.
---

# Voice and conversation recipes

Script: `$PLUGIN_ROOT/scripts/voice_conversation_gate.mjs` (installed copies live in `~/.gemini/config/plugins/jev-harness`).
Two layers: physical DSP measures loudness, silence and speech rate (0 tokens, WAV PCM16); `gemini-decision-1` judges meaning in one call
when a key is opted in. Neither layer decides alone. Run `node "$PLUGIN_ROOT/scripts/jev_client.mjs" doctor --offline` if anything misbehaves.

## Turn check (should the AI answer now?)

```bash
node "$PLUGIN_ROOT/scripts/voice_conversation_gate.mjs" turn-check --text "<transcript>" [--audio clip.wav] [--agreed "budget 1.85M"]
```

Returns `turn_complete`, `thinking_pause` or `backchannel_only`, plus `addressing_ai` and `contradiction_alert` (the latest utterance
reverses a number agreed earlier). Respond only when `respond` is true. A filler tail or a mere "mm-hm" must not trigger a reply.

## Distill a spoken correction

```bash
node "$PLUGIN_ROOT/scripts/voice_conversation_gate.mjs" distill-voice --text "予算は158万じゃなくて185万で"
```

Removes fillers and only the retracted clause, and only at a clean left edge ("delete the old logs, I mean cache." and "red and blue, I mean green." stay untouched). Numbers, negation, dialect and hedges survive character for character. If anything
important might be lost it returns the untouched original (`fellBackToOriginal: true`). The hook never rewrites the user's message;
for an unmistakable correction it only adds one `[jev-harness voice-note]` line next to it.

## Lock irreversible voice commands

```bash
node "$PLUGIN_ROOT/scripts/voice_conversation_gate.mjs" confirm-action --pending "delete the build folder" --confirmation "yes, delete the build folder" --audio confirm.wav
```

Fail-closed: no audio gives `locked: true, reason: "audio_required"` (only `--allow-text-only` accepts a typed confirmation); a confirmation that
does not match the pending command, a confirmation with more negations than the command ("yes, do not delete ..." / 「はい、削除しないで」 ->
`confirmation_contains_negation`), an irreversible command whose confirmation does not echo the act ("yes, keep the build folder" / 「うん、ビルドフォルダは残して」 ->
`missing_irreversible_verb_echo`), an unknown command, or any error stays locked. Exit code 4 means still locked.
