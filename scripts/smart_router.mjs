#!/usr/bin/env node
// smart_router.mjs — 0-output-token, 13-question probability router + multi-model role allocator.
//
// One gemini-decision-1 call (12 axis yes/no + 1 utterance_intent choice, ~0.4 s, 0 output tokens) per user turn decides
// which "lane" the turn should run in, so a weekly agent quota is not burned on chores a cheaper lane can do:
//
//   lite     routine / mechanical work   -> cheapest model, no subagent fan-out, plain scripts first
//   standard everything else             -> default model
//   deep     hard reasoning / broad ctx  -> strongest model, plan first
//   guarded  public or irreversible      -> strongest model + explicit confirmation before acting
//
// 8 axes: hard_reasoning, routine_mechanical, public_facing_risk, irreversible_action, needs_broad_context,
// underspecified, pivot, overreach.
// 4 role axes (same single call): boilerplate_or_volume_high, deep_multi_file_coupling,
// adversarial_security_or_public_release, multimodal_or_executive_signoff -> allocateModelRoles().
//
// Model names are NOT hard-wired. The default profile table knows generic slots (a local Ollama model, Gemini
// Flash / Argon / Carbon, Claude Sonnet / Opus / Fable); only the slots that are enabled AND have quota left
// take part. Override or extend the table with a `model_profiles.json` in the config dir or `opts.models`.
//
// With no API key (or any API failure) a deterministic keyword heuristic answers instead: the router stays
// silent unless something clearly actionable is detected.

import fs from 'node:fs';
import path from 'node:path';
import { choiceProbs, clamp01, configDir, decide, isMain, noul, parseArgs, readStdin, readTextFileSafe, round3 } from './jev_client.mjs';

export const AXES = {
  hard_reasoning: {
    type: 'noul',
    instructions: 'Does this request need deep multi-step reasoning, an architecture decision or tricky debugging (not mechanical editing)?',
  },
  routine_mechanical: {
    type: 'noul',
    instructions: 'Is this a routine, well-specified chore (rename, format, list, boilerplate, simple lookup, run a known command)?',
  },
  public_facing_risk: {
    type: 'noul',
    instructions: 'Will the output be published or sent to other people (post, email, pull request, release, customer or public message)?',
  },
  irreversible_action: {
    type: 'noul',
    instructions: 'Could carrying this out delete data, spend money, push or deploy, or otherwise be hard to undo?',
  },
  needs_broad_context: {
    type: 'noul',
    instructions: 'Does it require reading many files, a long history, or several sources to answer correctly?',
  },
  underspecified: {
    type: 'noul',
    instructions: 'Is the request ambiguous enough that one clarifying question would likely save a wasted attempt?',
  },
  pivot: {
    type: 'noul',
    instructions: 'Is the user changing direction: reversing an earlier decision, abandoning the current approach, or switching to a new topic?',
  },
  overreach: {
    type: 'noul',
    instructions: 'Is the user signalling that the assistant did more than was asked, changed things unrequested, or should stop widening scope?',
  },
};

/** Orthogonal axes that decide WHO does the work (see allocateModelRoles). */
export const ROLE_AXES = {
  boilerplate_or_volume_high: {
    type: 'noul',
    instructions: 'Is this mostly a large volume of routine or boilerplate implementation (many similar files, scaffolding, bulk edits, repetitive tests) rather than hard thinking?',
  },
  deep_multi_file_coupling: {
    type: 'noul',
    instructions: 'Does it involve non-obvious coupling across several files or modules, or a hard-to-reproduce bug whose cause is spread out?',
  },
  adversarial_security_or_public_release: {
    type: 'noul',
    instructions: 'Does it need an adversarial review: publishing to the public (open-source release), secret/PII boundaries, prompt-injection resistance, or permission/privilege escalation risks?',
  },
  multimodal_or_executive_signoff: {
    type: 'noul',
    instructions: 'Does it need checking against a real screen, image or audio recording, or a final integrated go/no-go judgement by the human owner?',
  },
};

export const ALL_AXES = { ...AXES, ...ROLE_AXES };

export const UTTERANCE_INTENTS = ['directive', 'ruling', 'musing', 'question'];

export const INTENT_QUESTION = {
  utterance_intent: {
    type: 'choice',
    instructions:
      'Classify the user message intent: directive (concrete task/edit/build/fix/investigate request), ruling (accept/reject/priority/GO sign-off), musing (thinking aloud, preference, tentative idea without asking for immediate execution), or question (asking how something works, current status, or comparison).',
    criteria: {
      directive: 'Clear request to build, edit, fix, run, investigate, or produce a deliverable.',
      ruling: 'Decision or sign-off choosing, approving, rejecting, or setting priority (e.g. "1 OK", "scrap it", "GO", "approved").',
      musing: 'Thinking aloud or expressing a wish/reflection without requesting immediate code or file changes.',
      question: 'Pure question asking for an explanation, status check, reason, or comparison.',
    },
  },
};

// ───────────────────────── deterministic heuristic ─────────────────────────

const LEADING_SLASH_RE = /^(?:\/(?:swarm|goal|plan|grill-me|boost|compact|learn)\b\s*)+/i;
const RULING_CASE_RE = /(?:^|[\s、。!！])(?:GO|ＧＯ)(?=$|[\s、。!！でを])/;
const RULING_JA_RE =
  /(?:(?:^|[\s、。!！])(?:[0-9０-９]+(?:[・,、][0-9０-９]+)*\s*(?:番|案)?(?:は|も)?\s*(?:OK|ＯＫ|採用|決定|承認)|案[0-9０-９]+(?:は|も)?\s*(?:OK|ＯＫ|採用|決定)|全推奨|それで(?:進めて|いこう|OK|決定)|これで(?:進めて|OK|決定)|(?:それで|これで|そのまま|全案?|案?[0-9０-９]+(?:は|で)?)\s*go(?=$|[\s、。!！で]))|(?:^|[\s、。!！「『(]|[0-9０-９]+(?:番|案)?[はもをがで]?|これ[はも]|それ[はも]|案[0-9０-９]+[はも]?)(?:没|ボツ|見送り|却下)(?=$|[\s、。!！でにはをだ」』)]))/i;
const RULING_EN_RE =
  /(?:^\s*(?:approved?|go ahead|ship it|let'?s go with (?:option )?\d+|option \d+ is (?:good|approved)|reject(?: option \d+)?|drop option \d+|scrap (?:that|it)|lgtm)\b|\b(?:approve|reject|go with) option \d+\b)/i;
const MUSING_RE =
  /(?:だよな+|[\u3040-\u309f]たいよな+|[ほ欲]しいよな+|べきだよな+|いいよな+|あるよな+|ないよな+|んだよな+|かなあ|かなぁ|かもしれないな|と思うんだよね|どうなんだろうな|\b(?:i wonder if|maybe we could|thinking aloud|just musing|would be nice if|not sure if we should)\b)/i;
const IMPERATIVE_RE =
  /(?:実装して|作って|作れ|直して|直せ|修正して|改修して|追加して|削除して|消して|書いて|書け|調べて|調査して|確認して|実行して|走らせて|回して|送って|出して|更新して|反映して|変更して|作成して|構築して|生成して|テストして|検証して|まとめて|整理して|変換して|同期して|教えて|ください|してくれ|頼む|お願い(?:します|したい)?|やって|試して|\b(?:implement|create|build|fix|refactor|update|edit|delete|remove|run|execute|test|verify|write|audit|deploy|investigate|check)\b)(?!\s*(?:[ほ欲]しい|みたい|いきたい|もらいたい|いただきたい)(?:ん?だ)?よな)/i;
const QUESTION_RE =
  /(?:[?？]\s*$|ですか(?:[。?？\s]|$)|でしょうか|どうなって|どうすれば|なぜ|どれが|何が|いつ(?:頃|まで|から|に|か)|(?:^|[\s、。])いつ(?=$|[\s、。?？はが])|どこに|^(?:how|what|why|when|where|which|who|is|are|do|does|can|could|should|would)\b)/i;

function extractCurrentMessage(input) {
  const s = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  const idx = s.indexOf('CURRENT USER MESSAGE:\n');
  return (idx >= 0 ? s.slice(idx + 'CURRENT USER MESSAGE:\n'.length) : s).trim();
}

/** Zero-token deterministic 4-way utterance intent classifier (works with or without leading slash commands). */
export function classifyIntentHeuristic(text) {
  const raw = extractCurrentMessage(text);
  const body = raw.replace(LEADING_SLASH_RE, '').trim();
  const make = (intent, confidence) => {
    const rest = (1 - confidence) / (UTTERANCE_INTENTS.length - 1);
    const probabilities = Object.fromEntries(UTTERANCE_INTENTS.map((k) => [k, round3(k === intent ? confidence : rest)]));
    return { intent, confidence, probabilities, source: 'heuristic' };
  };
  if (!body) return make('directive', 0.5);
  const isQuestionForm = QUESTION_RE.test(body);
  if (RULING_CASE_RE.test(body) || RULING_JA_RE.test(body) || (!isQuestionForm && RULING_EN_RE.test(body))) {
    return make('ruling', 0.88);
  }
  const hasImperative = IMPERATIVE_RE.test(body);
  if (MUSING_RE.test(body) && !hasImperative) return make('musing', 0.84);
  if (isQuestionForm && !/\b(?:fix|implement|create|build|refactor|edit|delete|deploy|audit)\b/i.test(body) && !/(?:作って|直して|修正して|実装して|削除して|書いて|実行して)/.test(body)) {
    return make('question', 0.82);
  }
  return make('directive', hasImperative ? 0.86 : 0.7);
}

const H = {
  hard_reasoning: /(設計|アーキテクチャ|原因(を|が)?(調べ|特定|究明)|なぜ.*(落ち|動かない|失敗)|デバッグ|リファクタ|最適化|トレードオフ|方針|architect|design|debug|root cause|race condition|refactor|optimi[sz]e|trade-?off|why (does|is|did)|investigate)/i,
  routine_mechanical: /(リネーム|名前を変|整形|フォーマット|一覧|並べ替|コピー|移動して|typo|誤字|rename|format|lint|list (all|the)|sort|copy|move|bump version|boilerplate|run (the )?tests?)/i,
  public_facing_risk: /(投稿|公開|送信|送って|メール|返信|ツイート|リリース|プルリク|PR を|出品|発信|publish|post (it|this)|send (it|this|an? )|email|reply to|tweet|release|open a pull request|ship it|announce)/i,
  // "delete unused imports" is routine editing; only broad / unrecoverable targets count as irreversible
  irreversible_action: /(全部消|全削除|全て削除|すべて削除|(?:本番|データベース|DB|リポジトリ|ブランチ|フォルダ|ディレクトリ|バックアップ)[^\s。、]{0,6}(?:削除|消去|消して)|初期化|force.?push|強制(?:プッシュ|上書き)|本番|デプロイ|送金|支払|購入|解約|drop (table|database)|rm -rf|delete\s+(?:the\s+|all\s+|every\s+|entire\s+|whole\s+)*(?:everything|production|prod|database|db|repo(?:sitory)?|branch(?:es)?|backups?|folders?|director(?:y|ies)|buckets?|accounts?|data)\b|wipe|reset --hard|\bdeploy\b|production|purchase|transfer funds)/i,
  needs_broad_context: /(全体|すべての|全ファイル|リポジトリ全|横断|履歴を|across the (repo|codebase)|entire (repo|codebase)|all files|every file|whole project|history of)/i,
  underspecified: /(いい感じ|適当に|よしなに|なんとか|something like|whatever|somehow|make it better|improve it)/i,
  pivot: /(やっぱり|やっぱ|方針(を)?変|ところで|話変わ|別の(話|件)|そうじゃなくて|違う、|一旦(止|やめ)|instead|actually,|scrap (that|this)|never ?mind|change of plan|new direction|forget (that|what)|switch to)/i,
  boilerplate_or_volume_high: /(ボイラープレート|定型|量産|大量|一括|全部(書|作)|テンプレ|雛形|スキャフォールド|CRUD|boilerplate|scaffold|bulk|generate (all|many)|tests? for (all|every)|translate all|rename all)/i,
  deep_multi_file_coupling: /(複数ファイル|ファイル間|結合|依存関係|難解|再現しない|レースコンディション|間欠|multi-?file|cross-?file|coupling|race condition|flaky|intermittent|circular dependenc|non-?obvious|across modules)/i,
  adversarial_security_or_public_release: /(セキュリティ|脆弱性|秘密値|シークレット|APIキー|インジェクション|権限逸脱|OSS|公開前|監査|security|vulnerab|secret|api key|injection|privilege|open[- ]?source|public release|pii|credential|audit)/i,
  multimodal_or_executive_signoff: /(スクショ|スクリーンショット|画面を|音声|録音|最終判断|最終確認|検品|実機|screenshot|audio|voice|final (check|sign-?off|decision)|visual check)/i,
  overreach: /(頼んでない|勝手に|余計な|やりすぎ|そこまで(しなくて|は)|範囲外|スコープ|I (didn'?t|did not) ask|don'?t touch|out of scope|too far|stop (changing|touching)|only what I asked|why did you (also|change))/i,
};

export function heuristicAnswers(input, questions = ALL_AXES) {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  const out = {};
  for (const [key, spec] of Object.entries(questions)) {
    if (key === 'utterance_intent' || spec?.type === 'choice') {
      const cls = classifyIntentHeuristic(text);
      out[key] = { choice: cls.intent, confidence: cls.confidence, probabilities: cls.probabilities };
      continue;
    }
    const re = H[key];
    out[key] = { noul: re && re.test(text) ? 0.85 : 0.08 };
  }
  return out;
}

export function parseIntentAnswer(answers, fallbackText = '') {
  const a = answers?.utterance_intent;
  if (a && typeof a.choice === 'string' && UTTERANCE_INTENTS.includes(a.choice)) {
    const probs = choiceProbs(answers, 'utterance_intent', UTTERANCE_INTENTS);
    const conf = clamp01(Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : probs[a.choice] || 0.6);
    return { intent: a.choice, confidence: round3(conf), probabilities: probs, source: 'jev' };
  }
  return classifyIntentHeuristic(fallbackText);
}

// ───────────────────────── lane selection (pure) ─────────────────────────

export const TRIVIAL_RE = /^\s*(?:ok(?:ay)?|yes|no|y|n|thanks?|thx|go|continue|next|done|はい|うん|了解|おけ|ありがとう|続けて|進めて|よし|お願い|ok です)[\s!！。.、]*$/i;

export function chooseLane(a) {
  const hard = a.hard_reasoning ?? 0;
  const routine = a.routine_mechanical ?? 0;
  if ((a.irreversible_action ?? 0) >= 0.6 || (a.public_facing_risk ?? 0) >= 0.6) return 'guarded';
  if (routine >= 0.65 && hard < 0.35) return 'lite';
  if (hard >= 0.65 || (a.needs_broad_context ?? 0) >= 0.7) return 'deep';
  return 'standard';
}

const LANE_HINT = {
  lite: 'LITE lane: routine chore. Use the cheapest/fastest model, prefer a plain script or direct edit, no subagent fan-out.',
  deep: 'DEEP lane: hard or broad task. Use the strongest model; write a short plan before editing.',
  guarded: 'GUARDED lane: public-facing or irreversible. Strongest model; show the exact artifact/command and wait for explicit user approval before executing.',
  standard: '',
};

export function buildHint(result, { verbose = false } = {}) {
  const { lane, axes, source, roles, intent, intentConfidence } = result;
  const lines = [];
  if (LANE_HINT[lane]) lines.push(LANE_HINT[lane]);
  if (intent === 'ruling' && (intentConfidence ?? 0) >= 0.6) {
    lines.push('INTENT[ruling]: Decision given. Record it and proceed without re-asking confirmation (subject to any active safety guard).');
  } else if (intent === 'musing' && (intentConfidence ?? 0) >= 0.6) {
    lines.push('INTENT[musing]: Thinking aloud. Avoid unrequested edits; outline grounded options and ask at most one clarifying question if needed.');
  }
  if ((axes.pivot ?? 0) >= 0.6) lines.push('PIVOT: the user may be changing direction. Re-read their last message literally; drop earlier plan assumptions that it contradicts.');
  if ((axes.overreach ?? 0) >= 0.6) lines.push('OVERREACH: the user is signalling scope creep. Do only what is asked; list (do not perform) anything extra.');
  if ((axes.underspecified ?? 0) >= 0.65 && lane !== 'lite') lines.push('UNDERSPECIFIED: ask exactly one clarifying question before large work.');
  const roleLoud = Object.keys(ROLE_AXES).some((k) => (axes[k] ?? 0) >= 0.6);
  if (roles && roles.pipeline.length && (roleLoud || verbose)) {
    const n = roles.notes.length ? ` [${roles.notes.join(', ')}]` : '';
    lines.push(`ROLES: ${roles.label}.${n} Follow this split; the auditor reads but never edits.`);
  }
  if (!lines.length && !verbose) return '';
  const compactAxes = Object.entries(axes)
    .map(([k, v]) => `${k}=${round3(v)}`)
    .join(' ');
  const compact = intent ? `${compactAxes}${compactAxes ? ' ' : ''}intent=${intent}(${round3(intentConfidence ?? 0)})` : compactAxes;
  return `[jev-router:${source}] ${lines.join(' ')}${verbose || lines.length ? `\n(${compact})` : ''}`.trim();
}

// ───────────────────────── multi-model role allocation ─────────────────────────

/**
 * Generic capability slots (0..1) and relative cost per unit of work. These are tunable priors, not measurements.
 *   build = volume implementation, deep = hard multi-file reasoning, sec = adversarial audit, final = sign-off.
 *   can   = which stages the slot may take (a strongest-auditor slot is never used as the builder by default).
 *   family: 'claude' lets one switch (JEV_MODELS / claude=0) turn all Claude slots off for non-subscribers.
 *   pool:   the quota bucket a slot draws from (agy_gemini: Flash / Argon / Carbon share one Antigravity allowance;
 *           claude_sub: one Claude subscription; free_daily; local). See parseQuota for how a pool shares a quota.
 */
export const MODEL_PROFILES = {
  local: { label: 'Local Ollama', family: 'local', pool: 'local', build: 0.4, deep: 0.15, sec: 0.1, final: 0.05, cost: 0, can: ['build'] },
  flash: { label: 'Gemini Flash', family: 'gemini', pool: 'agy_gemini', build: 0.6, deep: 0.3, sec: 0.25, final: 0.3, cost: 0.3, can: ['build'] },
  argon: { label: 'Gemini Argon', family: 'gemini', pool: 'agy_gemini', build: 0.8, deep: 0.8, sec: 0.7, final: 0.75, cost: 2.5, can: ['build', 'audit', 'final'] },
  carbon: { label: 'Gemini Carbon', family: 'gemini', pool: 'agy_gemini', build: 0.2, deep: 0.3, sec: 0.4, final: 0.95, cost: 1.5, can: ['audit', 'final'] },
  sonnet: { label: 'Claude Sonnet', family: 'claude', pool: 'claude_sub', build: 0.9, deep: 0.5, sec: 0.45, final: 0.4, cost: 1, can: ['build', 'audit'] },
  opus: { label: 'Claude Opus', family: 'claude', pool: 'claude_sub', build: 0.75, deep: 0.95, sec: 0.7, final: 0.6, cost: 3, can: ['build', 'audit', 'final'] },
  fable: { label: 'Claude Fable', family: 'claude', pool: 'claude_sub', build: 0.7, deep: 0.9, sec: 0.97, final: 0.7, cost: 5, can: ['audit', 'final'] },
};

const AXIS_ACTIVATE = 0.35; // below this a stage is optional-off; at/above MANDATORY a stage must exist
const AXIS_MANDATORY = 0.6;
const MIN_QUOTA = 0.02;
const LAMBDA = 0.15; // exchange rate between quality (0-10 scale) and scarcity-weighted cost

/** Profiles + optional user table (`<config dir>/model_profiles.json`) + explicit overrides. Never throws. */
export function loadProfiles(env = process.env, overrides = {}) {
  let user = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir(env), 'model_profiles.json'), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) user = raw;
  } catch {
    /* no user table */
  }
  const merged = {};
  for (const id of new Set([...Object.keys(MODEL_PROFILES), ...Object.keys(user), ...Object.keys(overrides || {})])) {
    const p = { ...(MODEL_PROFILES[id] || { label: id, family: id, build: 0.5, deep: 0.5, sec: 0.5, final: 0.5, cost: 1, can: ['build', 'audit', 'final'] }), ...(user[id] || {}), ...(overrides?.[id] || {}) };
    if (!Array.isArray(p.can)) p.can = ['build'];
    merged[id] = p;
  }
  return merged;
}

/** `"flash,carbon"` | `["flash"]` | undefined -> Set of enabled slot ids (undefined = everything is enabled). */
export function parseEnabled(input, env = process.env) {
  const raw = input ?? env.JEV_MODELS;
  if (raw === undefined || raw === null || raw === '') return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  const ids = list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/**
 * `{sonnet: 0.4}` | `"sonnet=40%,fable=0.2,claude=0"` | undefined -> remaining-weekly-quota fractions in [0,1].
 * Precedence per slot, strongest first (an explicit statement about the slot itself always beats an inherited one):
 *   1. its own id            (`carbon=5%`)
 *   2. its `pool` name       (`agy_gemini=30%`)
 *   3. its `family` name     (`gemini=50%`)
 *   4. sibling propagation: the LOWEST quota given by id to another slot of the same pool, applied ONLY to a slot that was
 *      named by neither id, pool nor family (slots of one pool draw from one allowance, so `carbon=5%` also limits an
 *      otherwise unmentioned argon / flash)
 *   5. 1 (full)
 * So `gemini=50%,carbon=5%` -> carbon 0.05, argon / flash 0.50.
 */
export function parseQuota(input, env = process.env, profiles = MODEL_PROFILES) {
  let raw = input ?? env.JEV_QUOTA ?? {};
  if (typeof raw === 'string') {
    const o = {};
    for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
      const m = part.match(/^([a-z0-9_-]+)\s*[=:]\s*([\d.]+)\s*(%?)$/i);
      if (m) o[m[1].toLowerCase()] = m[3] ? Number(m[2]) / 100 : Number(m[2]);
    }
    raw = o;
  }
  const norm = (v) => {
    let n = Number(v);
    if (!Number.isFinite(n)) return NaN;
    if (n > 1) n /= 100; // allow percentages
    return clamp01(n);
  };
  const poolMin = {}; // pool -> lowest quota explicitly given (by slot id) to any member of it
  for (const [id, p] of Object.entries(profiles)) {
    const v = norm(raw?.[id]);
    if (p.pool && Number.isFinite(v)) poolMin[p.pool] = Math.min(poolMin[p.pool] ?? 1, v);
  }
  const out = {};
  for (const [id, p] of Object.entries(profiles)) {
    const own = norm(raw?.[id]);
    const viaPool = p.pool ? norm(raw?.[p.pool]) : NaN;
    const viaFamily = p.family ? norm(raw?.[p.family]) : NaN;
    const explicit = [own, viaPool, viaFamily].find(Number.isFinite);
    const sibling = p.pool && poolMin[p.pool] !== undefined ? poolMin[p.pool] : NaN;
    out[id] = explicit ?? (Number.isFinite(sibling) ? sibling : 1);
  }
  return out;
}

const STAGE_NAME = { build: 'Builder', audit: 'Security Audit', final: 'Final Check' };

function pipelineLabel(stages, profiles) {
  if (!stages.length) return 'no model available';
  if (stages.length === 1) return `${profiles[stages[0].model].label} solo`;
  return stages.map((s) => `${STAGE_NAME[s.kind]}: ${profiles[s.model].label}${s.mode === 'read-only' ? ' (read-only)' : ''}`).join(' -> ');
}

/**
 * Decide the role-split pipeline from the four orthogonal role axes, the enabled slots and remaining quota.
 *
 *   utility = 10 * (w_build*fit_build + sec*fit_audit + signoff*fit_final)
 *             - LAMBDA * sum(cost_m * units_stage / max(quota_m, floor))
 *
 * Hard rules: an audit stage is mandatory when sec >= 0.6 and impossible below 0.35; same for the final check on
 * the sign-off axis. A slot that is disabled or has < 2 % quota left is never used. The builder never audits itself.
 * If a mandatory stage has no eligible slot the plan degrades (and says so in `notes`) instead of failing.
 * Pure and deterministic (ties resolve by table order: cheaper first).
 *
 * @param {object} axes  boilerplate_or_volume_high, deep_multi_file_coupling,
 *                       adversarial_security_or_public_release, multimodal_or_executive_signoff
 * @param {object|string} [quota]  remaining weekly quota per slot or family (fractions or percents)
 * @param {{models?: object, enabled?: string|string[], env?: object}} [opts]
 */
export function allocateModelRoles(axes = {}, quota = undefined, opts = {}) {
  const env = opts.env || process.env;
  const profiles = loadProfiles(env, opts.models);
  const enabled = parseEnabled(opts.enabled, env);
  const q = parseQuota(quota, env, profiles);
  const vol = clamp01(Number(axes.boilerplate_or_volume_high) || 0);
  const deep = clamp01(Number(axes.deep_multi_file_coupling) || 0);
  const sec = clamp01(Number(axes.adversarial_security_or_public_release) || 0);
  const sign = clamp01(Number(axes.multimodal_or_executive_signoff) || 0);

  const usable = (id) => (!enabled || enabled.has(id) || enabled.has(profiles[id].family)) && q[id] >= MIN_QUOTA;
  const pool = (stage) => Object.keys(profiles).filter((id) => usable(id) && profiles[id].can.includes(stage));
  const notes = [];

  const wBuild = Math.max(vol, deep, 0.35);
  const volShare = vol + deep > 0 ? vol / (vol + deep) : 0.5;
  const builderUnits = 0.5 + 0.5 * Math.max(vol, deep);

  const needAudit = sec >= AXIS_ACTIVATE;
  const mustAudit = sec >= AXIS_MANDATORY;
  const needFinal = sign >= AXIS_ACTIVATE;
  const mustFinal = sign >= AXIS_MANDATORY;

  const builders = pool('build');
  if (!builders.length) {
    // last resort: any usable slot may build, so the caller always gets a plan when something is enabled
    builders.push(...Object.keys(profiles).filter(usable));
    notes.push(builders.length ? 'no_dedicated_builder:fallback_to_any_enabled' : 'no_models_enabled_or_all_quotas_exhausted');
  }
  if (!builders.length) {
    return { pipeline: [], label: pipelineLabel([], profiles), utility: 0, quality: 0, cost: 0, inputs: { vol: round3(vol), deep: round3(deep), sec: round3(sec), sign: round3(sign), quota: q }, notes, alternatives: [] };
  }

  const auditors = pool('audit');
  const finals = pool('final');
  const auditOptions = needAudit ? (mustAudit ? [] : [null]).concat(auditors) : [null];
  const finalOptions = needFinal ? (mustFinal ? [] : [null]).concat(finals) : [null];

  const build = (aOpts, fOpts) => {
    const out = [];
    for (const b of builders)
      for (const a of aOpts)
        for (const f of fOpts) {
          if (a && a === b) continue; // self-audit is not an independent audit
          const stages = [{ kind: 'build', model: b, mode: 'write' }];
          if (a) stages.push({ kind: 'audit', model: a, mode: 'read-only' });
          if (f) stages.push({ kind: 'final', model: f, mode: 'minimal-turn' });
          out.push(stages);
        }
    return out;
  };

  let candidates = build(auditOptions, finalOptions);
  if (!candidates.length) {
    // a mandatory stage has no eligible slot: degrade rather than return nothing
    if (mustAudit && !auditors.length) notes.push('no_auditor_available:audit_skipped');
    if (mustFinal && !finals.length) notes.push('no_final_checker_available:final_skipped');
    candidates = build(mustAudit && !auditors.length ? [null] : auditOptions, mustFinal && !finals.length ? [null] : finalOptions);
  }
  if (!candidates.length) candidates = build([null], [null]);

  const scored = candidates.map((stages) => {
    const pb = profiles[stages[0].model];
    const audit = stages.find((s) => s.kind === 'audit');
    const fin = stages.find((s) => s.kind === 'final');
    const fitBuild = volShare * pb.build + (1 - volShare) * pb.deep;
    const fitAudit = audit ? profiles[audit.model].sec : pb.sec;
    const fitFinal = fin ? profiles[fin.model].final : pb.final * 0.6;
    const quality = 10 * (wBuild * fitBuild + sec * fitAudit + sign * fitFinal);
    const units = { build: builderUnits, audit: 0.5, final: 0.3 }; // an audit is one read-only pass; a final check is a minimal turn
    let cost = 0;
    for (const s of stages) cost += (profiles[s.model].cost * units[s.kind]) / Math.max(q[s.model], MIN_QUOTA);
    return { stages, utility: quality - LAMBDA * cost, quality, cost };
  });

  let best = scored[0];
  for (const c of scored) if (c.utility > best.utility + 1e-9) best = c;

  // an independent audit was mandatory but nobody except the builder can do it (e.g. --models opus): say so out loud
  if (mustAudit && !best.stages.some((s) => s.kind === 'audit') && !notes.includes('no_auditor_available:audit_skipped')) notes.push('no_independent_auditor:audit_skipped');
  // same for the sign-off: a mandatory final check that only the builder could run is a skipped check, not a passed one
  if (mustFinal && !best.stages.some((s) => s.kind === 'final') && !notes.includes('no_final_checker_available:final_skipped')) notes.push('no_independent_final_reviewer:final_check_skipped');
  for (const s of best.stages) if (q[s.model] < 0.15) notes.push(`${s.model}_quota_low`);
  if (best.stages.length === 1 && deep >= AXIS_MANDATORY && sec < AXIS_ACTIVATE) notes.push(`hard_but_low_exposure:${best.stages[0].model}_solo`);

  return {
    pipeline: best.stages,
    label: pipelineLabel(best.stages, profiles),
    utility: round3(best.utility),
    quality: round3(best.quality),
    cost: round3(best.cost),
    inputs: { vol: round3(vol), deep: round3(deep), sec: round3(sec), sign: round3(sign), quota: q },
    notes,
    alternatives: scored
      .filter((c) => c !== best)
      .sort((a, b) => b.utility - a.utility)
      .slice(0, 2)
      .map((c) => ({ label: pipelineLabel(c.stages, profiles), utility: round3(c.utility) })),
  };
}

// ───────────────────────── main entry ─────────────────────────

export async function routeTurn(userInput, { previousInput = '', timeoutMs = 3000, quota = undefined, enabled = undefined, models = undefined, verbose = false, ...opts } = {}) {
  const text = String(userInput ?? '').trim();
  if (!text || TRIVIAL_RE.test(text)) {
    return { lane: 'standard', axes: {}, intent: 'trivial', intentConfidence: 1, intentProbs: {}, intentSource: 'skip-trivial', source: 'skip-trivial', hint: '', apiCalls: 0 };
  }
  const input = previousInput
    ? `PREVIOUS USER MESSAGE:\n${String(previousInput).slice(0, 1500)}\n\nCURRENT USER MESSAGE:\n${text.slice(0, 4000)}`
    : `CURRENT USER MESSAGE:\n${text.slice(0, 4000)}`;
  const questions = { ...ALL_AXES, ...INTENT_QUESTION };
  const r = await decide({ input, questions, heuristic: heuristicAnswers, timeoutMs, ...opts });
  const axes = {};
  for (const k of Object.keys(ALL_AXES)) axes[k] = clamp01(noul(r.answers, k, 0));
  const parsedIntent = parseIntentAnswer(r.answers, text);
  const result = {
    lane: chooseLane(axes),
    axes,
    intent: parsedIntent.intent,
    intentConfidence: parsedIntent.confidence,
    intentProbs: parsedIntent.probabilities,
    intentSource: r.source === 'heuristic' ? 'heuristic' : parsedIntent.source,
    source: r.source,
    degraded: r.degraded,
    apiCalls: r.source === 'jev' || r.source === 'jev+heuristic' ? r.chunks : 0,
    latencyMs: r.latencyMs || 0,
  };
  result.roles = allocateModelRoles(axes, quota, { env: opts.env, enabled, models });
  result.hint = buildHint(result, { verbose });
  return result;
}

async function main() {
  const args = parseArgs();
  const text = String(args.file ? readTextFileSafe(String(args.file), { maxBytes: 1024 * 1024 }) : args.text || args._.join(' ') || (await readStdin()));
  const r = await routeTurn(text, {
    previousInput: args.previous || '',
    verbose: Boolean(args.verbose),
    quota: args.quota,
    enabled: args.models,
  });
  console.log(JSON.stringify(r, null, 2));
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(`error: ${String(err?.message || err).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
