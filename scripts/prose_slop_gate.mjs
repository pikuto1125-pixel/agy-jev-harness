#!/usr/bin/env node
// prose_slop_gate.mjs — zero-token deterministic AI slop, vendor residue, and SNS hygiene gate with SHA-256 receipts.
//
// Commands:
//   check   (--file <path> | --text <str>) [--kind auto|general|sns|x_post] [--strict] [--raw] [--receipts <file>] [--no-receipt]
//   verify  --file <path> [--receipts <file>] [--max-age-hours 24] [--strict]
//
// Exit codes: 0 = pass / verified, 1 = gate failed / receipt invalid / file error, 2 = usage error.
// Node >= 20, standard library only, zero network calls.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { containsSecret, expandHome, isMain, parseArgs, readStdin, readTextFileSafe, redact, stateDir } from './jev_client.mjs';

const FS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

export const VENDOR_RESIDUE_RULES = [
  { id: 'chatgpt_cite', vendor: 'ChatGPT', re: /\b(?:oaicite|oai_citation|contentReference|turn\d+search\d+|attributableIndex)\b/ },
  { id: 'utm_ai_referrer', vendor: 'ChatGPT', re: /utm_source=(?:chatgpt\.com|copilot\.com|openai)\b/i },
  { id: 'gemini_cite', vendor: 'Gemini', re: /\[cite:\s*\d+\]|\[span_\d+\]\(start_span\)/ },
  { id: 'grok_card', vendor: 'Grok', re: /\b(?:grok_card|grok_render_citation_card_json)\b/ },
  { id: 'perplexity_upload', vendor: 'Perplexity', re: /\b(?:ppl-ai-file-upload|attached_file)\b/ },
  { id: 'citation_bracket', vendor: 'CitationMarker', re: /【[^】\n]*(?:†|\d+\s*[:：]\s*\d+)[^】\n]*】/ },
  { id: 'internal_think_tag', vendor: 'ModelTag', re: /<\/?think>|\(※モデル注[：:]/ },
  { id: 'writing_directive', vendor: 'ModelTag', re: /:::writing/ },
  { id: 'placeholder_marker', vendor: 'Placeholder', re: /［タイトルを入力］|\[タイトルを入力\]|\b(?:TODO|FIXME|XXX):|<insert[^>]*>|\[your (?:name|text) here\]|\blorem ipsum\b/ },
];

export const AI_SHAPE_RULES = [
  { id: 'hedged_ending_ja', tier: 'strong', re: /と言えるでしょう|ではないでしょうか。/g, fix: 'State directly or drop the unsupported claim.' },
  { id: 'template_cta_ja', tier: 'strong', re: /いかがでしたか|いかがだったでしょうか|本記事では|この記事では/g, fix: 'Remove boilerplate framing and lead with concrete facts.' },
  { id: 'generic_advice_ja', tier: 'strong', re: /ことが(?:重要|大切)です|ことが求められます|ことが推奨されます/g, fix: 'Specify who performs what concrete action.' },
  { id: 'vague_attribution_ja', tier: 'strong', re: /専門家は[^。\n]{0,20}指摘|複数の関係者|業界レポートによれば|一部の批評家/g, fix: 'Cite the actual source or delete.' },
  { id: 'inflated_significance_ja', tier: 'strong', re: /重要な役割を果た|の証といえる|転換点とな|を浮き彫りに|貴重な示唆/g, fix: 'Drop inflated significance and keep observable facts.' },
  { id: 'negative_parallelism_ja', tier: 'strong', re: /単なる[^。]{0,20}ではなく|ではない。[^。]{0,30}だ。|というより[^。]{0,20}だ/g, fix: 'Write a direct positive statement.' },
  { id: 'copula_avoidance_ja', tier: 'strong', re: /の役割を果た|を擁して|となっている(?![^。]*ため)/g, fix: 'Use direct verbs instead of copula padding.' },
  { id: 'ai_cliche_en', tier: 'strong', re: /\b(?:in today's fast-paced world|delve(?:s|d|ing)? into|game-?changer|testament to|it is important to note|tapestry of|leverage the power of|unlock the full potential|seamlessly|revolutionize)\b/gi, fix: 'Replace AI cliché with concrete evidence.' },
  { id: 'negative_parallelism_en', tier: 'strong', re: /\bnot just [^.\n]{1,35},\s*but (?:also )?/gi, fix: 'State what it does directly.' },
  { id: 'ai_bold_list', tier: 'advisory', re: /^[ \t]*[-*+][ \t]+\*\*[^*\n]{1,40}\*\*[ \t]*[:：]/gm, fix: 'Prefer plain prose over bold-colon bullet lists.' },
  { id: 'section_divider', tier: 'advisory', re: /^[ \t]*(-{3,}|_{3,}|\*{3,})[ \t]*$/gm, fix: 'Remove decorative horizontal rules between sections.' },
  { id: 'triple_middot_list', tier: 'advisory', re: /(?:[^\s、。：:0-9][^\s、。：:]{0,9}・){2,}[^\s、。：:][^\s、。：:]{0,9}/g, fix: 'Avoid mechanical three-item middot lists.' },
];

export const SNS_FILLER_RE = /(?:ぜひお試しください|ぜひご覧ください|いかがでしょうか[？?]|活用してみてください|まずは試してみて|リプ欄にリンク|リプライにリンク|ツリーにリンク|詳細はリプ|link in (?:the )?repl(?:y|ies)|links? in thread|thread below)/gi;
const HASHTAG_RE = /(?:^|\s)#[A-Za-z0-9_\u3040-\u30ff\u4e00-\u9faf]+/g;

/** Replace fenced code blocks (line-anchored), inline backtick spans, and <code>/<pre> tags with spaces while keeping newlines. */
export function maskCode(text = '') {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return String(text ?? '')
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*(?:\r?\n[\s\S]*?(?:\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)|$)|$)/gm, blank)
    .replace(/(`+)[^\n`]*?\1/g, blank)
    .replace(/<(?:code|pre)\b[^>]*>[\s\S]*?<\/(?:code|pre)>/gi, blank);
}

/** SHA-256 over UTF-8 text with leading BOM stripped and CRLF normalized to LF. */
export function computeNormalizedSha256(text = '') {
  const norm = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

/** Weighted short-post length (URLs count 23, ASCII codepoints 1, non-ASCII/CJK codepoints 2). */
export function snsWeightedLength(text = '') {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  const URL_RE = /https?:\/\/\S+/gi;
  let total = 0;
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    for (const ch of s.slice(last, m.index)) total += ch.codePointAt(0) <= 0x7f ? 1 : 2;
    total += 23;
    last = m.index + m[0].length;
  }
  for (const ch of s.slice(last)) total += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return total;
}

export function detectKindFromPath(targetPath = '', explicitKind = 'auto') {
  const k = String(explicitKind || 'auto').toLowerCase();
  if (k && k !== 'auto') return k;
  const norm = String(targetPath || '').replace(/\\/g, '/');
  if (!norm) return 'general';
  const base = path.posix.basename(norm).toLowerCase();
  const parent = path.posix.basename(path.posix.dirname(norm)).toLowerCase();
  if (/^(?:x_post|tweet|short_post|sns_post)(?:[._-]|$)/.test(base)) return 'sns';
  if (['x_post', 'x_posts', 'tweet', 'tweets', 'sns'].includes(parent) && /\.(?:md|txt)$/i.test(base)) return 'sns';
  return 'general';
}

function snippetContext(text, idx, len) {
  const raw = text.slice(Math.max(0, idx - 18), Math.min(text.length, idx + len + 18)).replace(/\s+/g, ' ');
  return redact(raw, 120);
}

function findHeadingSkips(text) {
  const hs = [...String(text || '').matchAll(/^(#{1,6})[ \t]/gm)].map((m) => m[1].length);
  const bad = [];
  for (let i = 1; i < hs.length; i++) {
    if (hs[i] > hs[i - 1] + 1) bad.push(`h${hs[i - 1]}->h${hs[i]}`);
  }
  return bad;
}

/**
 * Run zero-token deterministic checks on prose.
 * Vendor residue inside Markdown code blocks or backtick spans is ignored (counted in inCodeResidueCount).
 */
export function checkProse(
  text = '',
  { raw = false, kind = 'auto', targetPath = '', strict = false, maxHashtags = 2, maxChars = 280 } = {}
) {
  const str = String(text ?? '');
  const prose = raw ? str : maskCode(str);
  const effKind = detectKindFromPath(targetPath, kind);

  const residueHits = [];
  let inCodeResidueCount = 0;
  for (const r of VENDOR_RESIDUE_RULES) {
    const flags = r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`;
    const re = new RegExp(r.re.source, flags);
    for (const m of str.matchAll(re)) {
      const inProse = raw || prose.slice(m.index, m.index + m[0].length).trim() !== '';
      if (inProse) {
        residueHits.push({
          id: r.id,
          vendor: r.vendor,
          match: redact(m[0], 60),
          index: m.index,
          context: snippetContext(str, m.index, m[0].length),
        });
      } else {
        inCodeResidueCount += 1;
      }
    }
  }

  const shapeHits = [];
  for (const s of AI_SHAPE_RULES) {
    const flags = s.re.flags.includes('g') ? s.re.flags : `${s.re.flags}g`;
    const re = new RegExp(s.re.source, flags);
    const matches = [...prose.matchAll(re)];
    if (matches.length > 0) {
      shapeHits.push({
        id: s.id,
        tier: s.tier,
        count: matches.length,
        fix: s.fix,
        examples: matches.slice(0, 2).map((m) => snippetContext(str, m.index, m[0].length)),
      });
    }
  }

  const shortPostHits = [];
  if (effKind === 'sns' || effKind === 'x_post' || effKind === 'short') {
    const fillerRe = new RegExp(SNS_FILLER_RE.source, SNS_FILLER_RE.flags);
    const fillers = [...prose.matchAll(fillerRe)].map((m) => m[0]);
    if (fillers.length > 0) {
      shortPostHits.push({
        id: 'sns_filler_or_reply_link',
        detail: `Prohibited SNS filler or reply-link prompt: ${[...new Set(fillers)].slice(0, 4).join(', ')}`,
      });
    }
    const hashtags = prose.match(HASHTAG_RE) || [];
    if (hashtags.length > maxHashtags) {
      shortPostHits.push({
        id: 'sns_too_many_hashtags',
        count: hashtags.length,
        limit: maxHashtags,
        detail: `Too many hashtags (${hashtags.length} > ${maxHashtags})`,
      });
    }
    const weightedLen = snsWeightedLength(prose);
    if (weightedLen > maxChars) {
      shortPostHits.push({
        id: 'sns_length_exceeded',
        length: weightedLen,
        limit: maxChars,
        detail: `Short post weighted length exceeded (${weightedLen} > ${maxChars})`,
      });
    }
  }

  const headingSkips = findHeadingSkips(prose);
  const hardFailCount = residueHits.length;
  const strongShapeCount = shapeHits.filter((h) => h.tier === 'strong').reduce((n, h) => n + h.count, 0);
  const advisoryShapeCount = shapeHits.filter((h) => h.tier !== 'strong').reduce((n, h) => n + h.count, 0);
  const softHitCount = strongShapeCount + advisoryShapeCount + shortPostHits.length + headingSkips.length;

  const ok =
    hardFailCount === 0 &&
    shortPostHits.length === 0 &&
    strongShapeCount === 0 &&
    (!strict || (advisoryShapeCount === 0 && headingSkips.length === 0));

  return {
    ok,
    status: ok ? 'pass' : 'fail',
    sha256: computeNormalizedSha256(str),
    kind: effKind,
    strict: Boolean(strict),
    raw: Boolean(raw),
    maxChars,
    hardFailCount,
    strongShapeCount,
    advisoryShapeCount,
    softHitCount,
    inCodeResidueCount,
    residueHits,
    shapeHits,
    shortPostHits,
    headingSkips,
  };
}

export function defaultReceiptsFile(env = process.env, explicit = '') {
  if (explicit) return path.resolve(expandHome(String(explicit)));
  if (env.JEV_PROSE_RECEIPTS_FILE) return path.resolve(expandHome(String(env.JEV_PROSE_RECEIPTS_FILE)));
  return path.join(stateDir(env), 'prose_receipts.jsonl');
}

function normalizeTargetKey(targetPath) {
  const abs = path.resolve(expandHome(String(targetPath || ''))).replace(/\\/g, '/');
  return FS_CASE_INSENSITIVE ? abs.toLowerCase() : abs;
}

function targetHashFor(targetPath) {
  return crypto.createHash('sha256').update(normalizeTargetKey(targetPath), 'utf8').digest('hex').slice(0, 24);
}

/** Append a SHA-256 pass receipt for a target path (stores target hash + basename only, never home paths). */
export function issueProseReceipt(targetPath, text, checkResult, { env = process.env, receiptsFile = '', nowMs = Date.now() } = {}) {
  if (!targetPath) return { issued: false, reason: 'no_target' };
  if (containsSecret(text, 'secret')) return { issued: false, reason: 'secret_in_text' };
  const res = checkResult || checkProse(text, { targetPath });
  if (!res.ok) return { issued: false, reason: 'check_failed' };

  const file = defaultReceiptsFile(env, receiptsFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* best-effort rotation */
  }
  const entry = {
    v: 1,
    at: new Date(nowMs).toISOString(),
    targetHash: targetHashFor(targetPath),
    targetLabel: path.basename(String(targetPath)),
    sha256: res.sha256,
    kind: res.kind,
    verdict: 'pass',
    strict: Boolean(res.strict),
    raw: Boolean(res.raw),
    maxChars: res.maxChars,
    hardFailCount: res.hardFailCount,
    softHitCount: res.softHitCount,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return { issued: true, receiptsFile: redact(file), receipt: entry };
}

/** Verify that targetPath's current text matches a valid, unexpired SHA-256 pass receipt. */
export function verifyProseReceipt(
  targetPath,
  text,
  { env = process.env, receiptsFile = '', maxAgeMs = 24 * 3600_000, strict = false, nowMs = Date.now() } = {}
) {
  if (!targetPath) return { ok: false, reason: 'no_target' };
  const file = defaultReceiptsFile(env, receiptsFile);
  const wantSha = computeNormalizedSha256(text);
  const wantHash = targetHashFor(targetPath);
  const wantKey = normalizeTargetKey(targetPath);
  if (!fs.existsSync(file)) return { ok: false, reason: 'receipt_not_found', sha256: wantSha };

  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return { ok: false, reason: 'receipt_unreadable', sha256: wantSha };
  }

  let sawTarget = false;
  let sawShaMismatch = false;
  let sawExpired = false;
  let sawNonStrict = false;
  const cutoff = nowMs - maxAgeMs;

  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!rec || rec.verdict !== 'pass') continue;
    const matchesTarget = rec.targetHash ? rec.targetHash === wantHash : rec.target ? normalizeTargetKey(rec.target) === wantKey : false;
    if (!matchesTarget) continue;
    sawTarget = true;
    if (rec.sha256 !== wantSha) {
      sawShaMismatch = true;
      continue;
    }
    const atMs = Date.parse(rec.at || '');
    if (!Number.isFinite(atMs) || atMs < cutoff) {
      sawExpired = true;
      continue;
    }
    if (strict && !rec.strict) {
      sawNonStrict = true;
      continue;
    }
    return { ok: true, verdict: 'pass', sha256: wantSha, receipt: rec };
  }

  if (sawNonStrict) return { ok: false, reason: 'strict_receipt_required', sha256: wantSha };
  if (sawExpired) return { ok: false, reason: 'receipt_expired', sha256: wantSha };
  if (sawShaMismatch) return { ok: false, reason: 'sha256_mismatch', sha256: wantSha };
  if (!sawTarget) return { ok: false, reason: 'receipt_not_found', sha256: wantSha };
  return { ok: false, reason: 'receipt_not_found', sha256: wantSha };
}

async function main() {
  const args = parseArgs();
  const cmd = args._[0];
  if (!cmd || (cmd !== 'check' && cmd !== 'verify')) {
    console.error('usage: prose_slop_gate.mjs check (--file <path> | --text <str>) [--kind auto|general|sns|x_post] [--strict] [--raw] [--receipts <file>] [--no-receipt] | verify --file <path> [--receipts <file>] [--max-age-hours 24] [--strict]');
    process.exitCode = 2;
    return;
  }

  const receiptsFile = args.receipts ? String(args.receipts) : '';
  const strict = Boolean(args.strict);

  if (cmd === 'check') {
    const filePath = args.file ? String(args.file) : '';
    const targetPath = filePath || (args.target ? String(args.target) : '');
    const text = filePath
      ? readTextFileSafe(filePath, { maxBytes: 2 * 1024 * 1024 })
      : args.text !== undefined
        ? String(args.text)
        : await readStdin();
    if (!String(text).trim() && !filePath && args.text === undefined) {
      console.error('usage: prose_slop_gate.mjs check --file <path> | --text "..."');
      process.exitCode = 2;
      return;
    }
    if (containsSecret(text, 'secret')) {
      console.log(JSON.stringify({ ok: false, status: 'fail', reason: 'secret_in_text', sha256: computeNormalizedSha256(text) }, null, 2));
      process.exitCode = 1;
      return;
    }
    const maxHashtags = args['max-hashtags'] !== undefined ? Number(args['max-hashtags']) : 2;
    const maxChars = args['max-chars'] !== undefined ? Number(args['max-chars']) : 280;
    const res = checkProse(text, {
      raw: Boolean(args.raw),
      kind: String(args.kind || 'auto'),
      targetPath,
      strict,
      maxHashtags: Number.isFinite(maxHashtags) ? maxHashtags : 2,
      maxChars: Number.isFinite(maxChars) ? maxChars : 280,
    });
    let receiptInfo = { issued: false, reason: args['no-receipt'] ? 'disabled' : targetPath ? 'check_failed' : 'no_target' };
    if (res.ok && !args['no-receipt'] && targetPath) {
      receiptInfo = issueProseReceipt(targetPath, text, res, { receiptsFile });
    }
    console.log(JSON.stringify({ ...res, ...receiptInfo }, null, 2));
    process.exitCode = res.ok ? 0 : 1;
    return;
  }

  // verify
  const filePath = args.file ? String(args.file) : '';
  if (!filePath) {
    console.error('usage: prose_slop_gate.mjs verify --file <path> [--receipts <file>] [--max-age-hours 24] [--strict]');
    process.exitCode = 2;
    return;
  }
  const text = readTextFileSafe(filePath, { maxBytes: 2 * 1024 * 1024 });
  const maxAgeHours = args['max-age-hours'] !== undefined ? Number(args['max-age-hours']) : 24;
  const maxAgeMs = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours * 3600_000 : 24 * 3600_000;
  const v = verifyProseReceipt(filePath, text, { receiptsFile, maxAgeMs, strict });
  console.log(JSON.stringify(v, null, 2));
  process.exitCode = v.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(`error: ${redact(String(err?.message || err), 200)}`);
    process.exitCode = 1;
  }
}
