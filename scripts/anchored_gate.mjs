#!/usr/bin/env node
// anchored_gate.mjs — calibrated, three-layer rubric gate with four persona critics and anchor controls.
//
// Why three layers? A single "rate this 1-10" prompt lets a model grade its own homework generously.
//   Layer 1  PHYSICAL FLOOR   deterministic, 0 tokens: empty / too short / too long / leaked secrets / placeholders /
//                             merge markers. A violation is a hard FAIL and Jev is never called.
//   Layer 2  PROHIBITIONS     "does it contain X?" probabilities (+ deterministic cliché / private-data pre-pass).
//                             Warnings only — they never flip pass/fail by themselves.
//   Layer 3  ACTIVE QUALITY   raw 0-3 scores on rubric dimensions, read through a persona
//                             (neutral_calibrated, demanding_buyer_critic, skeptical_maintainer, first_time_user).
//                             The persona sets thresholds and adds its own questions.
//
// Honest limits:
//   * ANCHORS: optionally grade a known-good and a known-bad exemplar with the same rubric. If good is not clearly
//     above bad, the gate reports `cannot_judge` instead of a trustworthy-looking number.
//   * TRUNCATION: input longer than GATE_LIMITS.maxJudgeChars (or a drift check that reports `truncated: true`) is
//     never cut and graded. The result is `cannot_judge`; a verdict on the first part says nothing about the rest.
//   * OFFLINE: without Jev, layers 1-2 still run, layer 3 returns `cannot_judge` (it never fabricates a pass).
//   * INTENT DRIFT: with `--user <file>` (the human's own words) the deliverable is also checked for dropped
//     constraints, reversed/softened intent and unrequested scope.

import { containsSecret, decide, isMain, noul, parseArgs, readStdin, readTextFileSafe, redact, round3, score } from './jev_client.mjs';
import { checkDrift } from './verbatim_relay.mjs';

/** Longest text (per piece) the judge sees. Longer input is never cut and graded: the gate says cannot_judge. */
export const GATE_LIMITS = { maxJudgeChars: 24000 };

const Q4 = (a, b, c, d) => [a, b, c, d];
const dim = (instructions, criteria) => ({ type: 'score', instructions, criteria });

export const PACKS = {
  general: {
    label: 'General deliverable',
    floor: { minChars: 20, maxChars: 200000 },
    prohibitions: ['unverifiable_absolute_claims', 'empty_hype'],
    quality: {
      specificity: dim('Does it give concrete facts, steps, numbers or examples instead of generalities?', Q4('Generic filler', 'Partly specific', 'Specific and usable', 'Precisely specific, nothing to guess')),
      fitness_for_purpose: dim('Does it accomplish what the request evidently needed?', Q4('Misses the point', 'Partly on target', 'Does the job', 'Does the job and anticipates edge cases')),
    },
  },
  code_change: {
    label: 'Code change / diff',
    floor: { minChars: 20, maxChars: 200000, forbidPatterns: [/^(<<<<<<<|>>>>>>>)\s?/m, /\bTODO:? implement\b/i] },
    prohibitions: ['unverifiable_absolute_claims', 'unrelated_changes'],
    quality: {
      correctness: dim('Is the change logically correct for the stated goal, including edge cases?', Q4('Likely broken', 'Works on the happy path only', 'Correct for the stated cases', 'Correct and edge cases handled')),
      test_evidence: dim('Is there test or run evidence proportional to the risk?', Q4('None', 'Token gesture', 'Adequate', 'Strong, failing-first or regression-proof')),
      minimal_blast_radius: dim('Is the diff no larger than needed?', Q4('Sprawling unrelated edits', 'Some extras', 'Focused', 'Surgical')),
    },
  },
  public_copy: {
    label: 'Public-facing copy',
    floor: { minChars: 40, maxChars: 20000 },
    prohibitions: ['unverifiable_absolute_claims', 'empty_hype', 'ai_cliche_tone'],
    quality: {
      specificity: dim('Does it give the reader concrete reasons, numbers or steps?', Q4('Generic', 'Partly specific', 'Specific', 'Concrete and verifiable')),
      natural_voice: dim('Does it read like a person wrote it, free of template tone?', Q4('Heavy template tone', 'Some stiffness', 'Natural', 'Distinct, human voice')),
      honest_claims: dim('Are claims limited to what is actually established?', Q4('Overclaims', 'Some stretch', 'Mostly grounded', 'Fully grounded and hedged where needed')),
    },
  },
};

export const PERSONAS = {
  neutral_calibrated: {
    label: 'Neutral calibrated reviewer',
    passMean: 2.0,
    passMin: 1.5,
    warnBelow: 1.5,
    extra: {},
  },
  demanding_buyer_critic: {
    label: 'Demanding buyer (would I pay / sign off on this?)',
    passMean: 2.3,
    passMin: 1.8,
    warnBelow: 2.0,
    extra: {
      would_pay: dim('As a demanding buyer who has seen many mediocre deliverables: would you confidently pay for / accept this as-is?', Q4('No, embarrassing', 'Only with major fixes', 'Yes with small fixes', 'Yes, immediately')),
      seller_convenience_leak: dim("Does the deliverable serve the seller's convenience over the buyer's needs (hidden assumptions, jargon, missing next step)?", Q4('Clearly seller-centric', 'Some seller bias', 'Buyer-centric', 'Entirely buyer-centric')),
    },
  },
  skeptical_maintainer: {
    label: 'Skeptical maintainer (would I merge this?)',
    passMean: 2.2,
    passMin: 1.7,
    warnBelow: 1.9,
    extra: {
      would_merge: dim('As a maintainer who will own this code for years: would you merge it?', Q4('Reject', 'Request major changes', 'Merge after nits', 'Merge now')),
      surprise_factor: dim('How surprising is the diff given its description (hidden behaviour changes)?', Q4('Very surprising', 'Somewhat surprising', 'Matches description', 'Exactly as described')),
    },
  },
  first_time_user: {
    label: 'First-time user (can I follow this cold?)',
    passMean: 2.0,
    passMin: 1.5,
    warnBelow: 1.7,
    extra: {
      cold_start_clarity: dim('Could someone with no prior context follow and succeed with this on the first try?', Q4('Lost immediately', 'Gets stuck', 'Succeeds with minor guessing', 'Succeeds without guessing')),
    },
  },
};

export const PROHIBITION_QUESTIONS = {
  unverifiable_absolute_claims: 'Does it contain absolute or guaranteed claims ("always", "100%", "never fails", "guaranteed") that cannot be verified from the material?',
  empty_hype: 'Does it contain empty hype or superlatives with no supporting fact?',
  ai_cliche_tone: 'Does it use template AI phrasing ("in today\'s fast-paced world", "delve", "game-changer", "いかがでしたか", "〜と言えるでしょう")?',
  unrelated_changes: 'Does the change include edits unrelated to its stated purpose?',
};

// ───────────────────────── Layer 1: physical floor ─────────────────────────

export const PLACEHOLDER_RE = /(lorem ipsum|<insert[^>]*>|\[your (name|text) here\]|as an ai language model)/i;

export function physicalFloor(text, packId = 'general') {
  const pack = PACKS[packId] || PACKS.general;
  const t = String(text ?? '');
  const v = [];
  if (!t.trim()) v.push({ kind: 'empty' });
  if (t.length < (pack.floor.minChars ?? 0)) v.push({ kind: 'too_short', min: pack.floor.minChars });
  if (t.length > (pack.floor.maxChars ?? Infinity)) v.push({ kind: 'too_long', max: pack.floor.maxChars });
  if (containsSecret(t)) v.push({ kind: 'secret_leak' });
  if (PLACEHOLDER_RE.test(t)) v.push({ kind: 'placeholder_text' });
  for (const re of pack.floor.forbidPatterns || []) if (re.test(t)) v.push({ kind: 'forbidden_pattern', pattern: String(re) });
  return { pass: v.length === 0, violations: v };
}

// ───────────────────────── Layer 2: prohibitions ─────────────────────────

export const CLICHE_RE = /(in today'?s fast-?paced world|it'?s important to note|delve into|game-?changer|unlock the power|seamless(ly)?|いかがでしたか|と言えるでしょう|寄り添|最適解|シームレス)/i;
export const ABSOLUTE_RE = /(100%|guarantee[ds]?|never fails?|always works|絶対に?(?:大丈夫|成功|安全)|必ず(?:成功|治る|儲か)|完全に(?:安全|無料))/i;

function prohibitionHeuristic(text) {
  return (_i, questions) => {
    const out = {};
    for (const k of Object.keys(questions)) {
      const re = k === 'prohibit_ai_cliche_tone' ? CLICHE_RE : k === 'prohibit_unverifiable_absolute_claims' ? ABSOLUTE_RE : null;
      out[k] = { noul: re ? (re.test(text) ? 0.85 : 0.1) : 0.2 };
    }
    return out;
  };
}

// ───────────────────────── Layer 3 helpers ─────────────────────────

function rubricFor(packId, personaId) {
  const pack = PACKS[packId] || PACKS.general;
  const persona = PERSONAS[personaId] || PERSONAS.neutral_calibrated;
  return { pack, persona, questions: { ...pack.quality, ...persona.extra } };
}

async function gradeQuality(text, questions, opts) {
  const r = await decide({
    input: `CANDIDATE:\n${redact(text)}`,
    questions,
    heuristic: null, // never fabricate quality scores offline
    timeoutMs: 12000,
    ...opts,
  });
  if (!r.ok || r.source !== 'jev') return { ok: false, reason: r.reason || r.degraded || 'NO_JEV', source: r.source };
  const scores = {};
  for (const k of Object.keys(questions)) scores[k] = score(r.answers, k, 0); // fail-closed: missing -> 0
  const vals = Object.values(scores);
  return { ok: true, scores, mean: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals), source: r.source };
}

const over = (s) => String(s ?? '').length > GATE_LIMITS.maxJudgeChars;

/**
 * Grade `text`. opts: pack, persona, userWords (the human's verbatim words, enables the drift check),
 * anchorGood / anchorBad (exemplars), plus decide() options (env, fetchImpl, apiKey ...).
 * status: 'pass' | 'fail' | 'cannot_judge'. gatePass is null when nothing can be said.
 */
export async function runGate(text, { pack = 'general', persona = 'neutral_calibrated', userWords = '', anchorGood = '', anchorBad = '', ...opts } = {}) {
  const packId = PACKS[pack] ? pack : 'general';
  const { pack: P, persona: PR, questions } = rubricFor(packId, persona);
  const personaId = PERSONAS[persona] ? persona : 'neutral_calibrated';
  const t = String(text ?? '');

  // Layer 1
  const floor = physicalFloor(t, packId);
  if (!floor.pass) {
    return { status: 'fail', gatePass: false, pack: packId, persona: personaId, source: 'floor', layers: { floor }, warnings: [], apiCalls: 0 };
  }

  // Never grade a cut-off input.
  const tooLong = over(t) || over(anchorGood) || over(anchorBad);
  if (tooLong) {
    return {
      status: 'cannot_judge',
      gatePass: null,
      truncated: true,
      pack: packId,
      persona: personaId,
      source: 'none',
      layers: { floor },
      limits: GATE_LIMITS,
      warnings: [],
      note: `input exceeds ${GATE_LIMITS.maxJudgeChars} characters; the gate does not grade the first part and call it a verdict. Split the deliverable and grade the parts.`,
    };
  }

  // Intent drift against the human's own words (optional)
  let drift = null;
  if (String(userWords ?? '').trim()) {
    drift = await checkDrift(userWords, t, opts);
    if (drift.status === 'cannot_judge' || drift.truncated) {
      return {
        status: 'cannot_judge',
        gatePass: null,
        truncated: true,
        pack: packId,
        persona: personaId,
        source: drift.source,
        layers: { floor, drift },
        warnings: [],
        note: 'The drift check could not see the whole input, so no verdict is given.',
      };
    }
  }

  // Layer 2
  const pq = {};
  for (const id of P.prohibitions) pq[`prohibit_${id}`] = { type: 'noul', instructions: PROHIBITION_QUESTIONS[id] };
  const pr = await decide({
    input: `CANDIDATE:\n${redact(t)}`,
    questions: pq,
    heuristic: prohibitionHeuristic(t),
    timeoutMs: 8000,
    ...opts,
  });
  const warnings = [];
  for (const id of P.prohibitions) {
    const p = noul(pr.answers, `prohibit_${id}`, 0);
    if (p >= 0.6) warnings.push({ id, kind: 'prohibition', probability: round3(p) });
  }
  if (containsSecret(t, 'private')) warnings.push({ id: 'private_path_or_email', kind: 'prohibition', probability: 1 });
  if (drift?.drift) for (const f of drift.flags) warnings.push({ id: f, kind: 'intent_drift' });

  // Layer 3
  const q = await gradeQuality(t, questions, opts);
  const layers = { floor, prohibitions: { source: pr.source, flagged: warnings.filter((w) => w.kind === 'prohibition').map((w) => w.id) }, ...(drift ? { drift } : {}) };
  if (!q.ok) {
    return {
      status: 'cannot_judge',
      gatePass: null,
      pack: packId,
      persona: personaId,
      source: pr.source,
      layers: { ...layers, quality: { ok: false, reason: q.reason } },
      warnings,
      note: 'Layer 3 needs gemini-decision-1 (opt in with a key); layers 1-2 ran deterministically.',
    };
  }
  for (const [k, v] of Object.entries(q.scores)) {
    if (v < PR.warnBelow) warnings.push({ id: k, kind: 'weak_dimension', score: round3(v), persona: personaId });
  }

  // Anchors (assay controls)
  let anchor = null;
  if (anchorGood && anchorBad) {
    const [g, b] = [await gradeQuality(anchorGood, questions, opts), await gradeQuality(anchorBad, questions, opts)];
    if (!g.ok || !b.ok) anchor = { valid: false, reason: 'ANCHOR_UNGRADABLE' };
    else anchor = { valid: g.mean - b.mean >= 0.75, goodMean: round3(g.mean), badMean: round3(b.mean) };
    if (!anchor.valid) {
      return {
        status: 'cannot_judge',
        gatePass: null,
        pack: packId,
        persona: personaId,
        source: q.source,
        layers: { ...layers, quality: { scores: q.scores, mean: round3(q.mean), min: round3(q.min) } },
        anchor,
        warnings,
        note: 'Anchor check failed: the rubric did not separate the known-good from the known-bad exemplar, so the score is not trustworthy.',
      };
    }
  }

  const gatePass = q.mean >= PR.passMean && q.min >= PR.passMin && !drift?.drift;
  return {
    status: gatePass ? 'pass' : 'fail',
    gatePass,
    pack: packId,
    persona: personaId,
    source: q.source,
    layers: { ...layers, quality: { scores: q.scores, mean: round3(q.mean), min: round3(q.min), passMean: PR.passMean, passMin: PR.passMin } },
    anchor,
    warnings,
    fixes: warnings.filter((w) => w.kind === 'weak_dimension').map((w) => `raise "${w.id}" (score ${w.score} < ${PR.warnBelow})`),
  };
}

// ───────────────────────── CLI ─────────────────────────

async function main() {
  const args = parseArgs();
  const cmd = args._[0] || 'grade';
  if (cmd === 'list') {
    console.log(JSON.stringify({ packs: Object.keys(PACKS), personas: Object.keys(PERSONAS), maxJudgeChars: GATE_LIMITS.maxJudgeChars }, null, 2));
    return;
  }
  const readArg = (name) => (args[name] ? readTextFileSafe(String(args[name])) : '');
  const fileArg = args.file || args.deliverable;
  const text = fileArg ? readTextFileSafe(String(fileArg)) : await readStdin();
  const r = await runGate(text, {
    pack: String(args.pack || 'general'),
    persona: String(args.persona || 'neutral_calibrated'),
    userWords: readArg('user'),
    anchorGood: readArg('anchor-good'),
    anchorBad: readArg('anchor-bad'),
  });
  console.log(JSON.stringify(r, null, 2));
  if (r.status === 'fail') process.exitCode = 1;
  else if (r.status === 'cannot_judge') process.exitCode = 3;
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(`error: ${String(err?.message || err).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
