#!/usr/bin/env node
// bloat_guard.mjs — keep the always-on prompt lean. Zero model calls: 0 tokens.
//
// Everything in AGENTS.md, GEMINI.md and rules/*.md is paid for on EVERY turn of EVERY desk. This measures it:
//   always-on characters vs a budget ceiling (default 6,500)   GREEN_LEAN <= 85% | YELLOW_WATCH <= 100% | RED_BLOAT > 100%
//   skill count vs a cap (default 40)                          over the cap = RED_BLOAT
//   hooks health                                               invalid JSON = RED_BLOAT; a hook that points at a missing
//                                                              script, or has no timeout = YELLOW_WATCH
// Exit 0 for GREEN / YELLOW, 1 for RED (1 for YELLOW too with --strict).
//
//   node bloat_guard.mjs [--root <dir>] [--budget 6500] [--skill-cap 40] [--strict] [--brief]

import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseArgs } from './jev_client.mjs';

export const DEFAULT_BUDGET_CHARS = 6500;
export const DEFAULT_SKILL_CAP = 40;
export const GREEN_RATIO = 0.85;
const RANK = { GREEN_LEAN: 0, YELLOW_WATCH: 1, RED_BLOAT: 2 };
const worst = (...s) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'GREEN_LEAN');

/** AGENTS.md, GEMINI.md and every rules/**.md that exists under root. */
export function alwaysOnFiles(root) {
  const out = [];
  for (const f of ['AGENTS.md', 'GEMINI.md']) {
    const p = path.join(root, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p);
  }
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, n.name);
      if (n.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (n.isFile() && /\.md$/i.test(n.name)) out.push(p);
    }
  };
  walk(path.join(root, 'rules'), 0);
  return out;
}

export function countSkills(root) {
  const dirs = [path.join(root, 'skills'), path.join(root, '.agents', 'skills')];
  const found = [];
  for (const d of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const n of names) if (n.isDirectory() && fs.existsSync(path.join(d, n.name, 'SKILL.md'))) found.push(path.relative(root, path.join(d, n.name)).replace(/\\/g, '/'));
  }
  return found;
}

/** Hook files at <root>/hooks.json or <root>/.agents/hooks.json. Checks JSON, script paths and timeouts. */
export function hooksHealth(root) {
  const files = [path.join(root, 'hooks.json'), path.join(root, '.agents', 'hooks.json')].filter((f) => fs.existsSync(f));
  if (!files.length) return { present: false, status: 'GREEN_LEAN', problems: [] };
  const problems = [];
  let status = 'GREEN_LEAN';
  let commands = 0;
  for (const file of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      problems.push({ file: path.relative(root, file), kind: 'invalid_json' });
      status = 'RED_BLOAT';
      continue;
    }
    const visit = (v) => {
      if (Array.isArray(v)) return v.forEach(visit);
      if (!v || typeof v !== 'object') return;
      if (v.type === 'command' && typeof v.command === 'string') {
        commands++;
        if (!(Number(v.timeout) > 0)) {
          problems.push({ file: path.relative(root, file), kind: 'no_timeout', command: v.command.slice(0, 60) });
          status = worst(status, 'YELLOW_WATCH');
        }
        const m = v.command.match(/\b(?:node|python3?|bash|sh)\s+("[^"]+"|'[^']+'|\S+)/);
        const target = m ? m[1].replace(/^["']|["']$/g, '') : '';
        if (target && !/[$%]/.test(target) && !fs.existsSync(path.resolve(path.dirname(file), target))) {
          problems.push({ file: path.relative(root, file), kind: 'missing_script', script: target });
          status = worst(status, 'YELLOW_WATCH');
        }
      }
      Object.values(v).forEach(visit);
    };
    visit(j);
  }
  return { present: true, commands, status, problems };
}

export function measure(root, { budget = DEFAULT_BUDGET_CHARS, skillCap = DEFAULT_SKILL_CAP } = {}) {
  const files = alwaysOnFiles(root).map((f) => {
    const chars = fs.readFileSync(f, 'utf8').length;
    return { file: path.relative(root, f).replace(/\\/g, '/'), chars };
  });
  const totalChars = files.reduce((n, f) => n + f.chars, 0);
  const promptStatus = totalChars > budget ? 'RED_BLOAT' : totalChars > budget * GREEN_RATIO ? 'YELLOW_WATCH' : 'GREEN_LEAN';
  const skills = countSkills(root);
  const skillStatus = skills.length > skillCap ? 'RED_BLOAT' : 'GREEN_LEAN';
  const hooks = hooksHealth(root);
  const status = worst(promptStatus, skillStatus, hooks.status);
  const reasons = [];
  if (promptStatus !== 'GREEN_LEAN') reasons.push(`always-on prompt ${totalChars} chars (${Math.round((totalChars / budget) * 100)}% of ${budget}): move detail into on-demand skills, retire one rule per rule added`);
  if (skillStatus !== 'GREEN_LEAN') reasons.push(`${skills.length} skills > cap ${skillCap}: merge or retire the ones nobody invoked`);
  for (const p of hooks.problems) reasons.push(`hooks: ${p.kind}${p.script ? ` (${p.script})` : ''} in ${p.file}`);
  const largest = [...files].sort((a, b) => b.chars - a.chars)[0];
  return {
    status,
    prompt: { status: promptStatus, totalChars, budget, ratio: budget ? Math.round((totalChars / budget) * 1000) / 1000 : 0, files, largest: largest?.file || null },
    skills: { status: skillStatus, count: skills.length, cap: skillCap },
    hooks,
    reasons,
  };
}

function main() {
  const args = parseArgs();
  const root = path.resolve(String(args.root || process.cwd()));
  const r = measure(root, { budget: Number(args.budget || DEFAULT_BUDGET_CHARS), skillCap: Number(args['skill-cap'] || DEFAULT_SKILL_CAP) });
  if (args.brief) console.log(`${r.status} ${r.prompt.totalChars}/${r.prompt.budget} chars, ${r.skills.count}/${r.skills.cap} skills, hooks ${r.hooks.present ? r.hooks.status : 'none'}`);
  else console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.status === 'RED_BLOAT' || (args.strict && r.status === 'YELLOW_WATCH') ? 1 : 0;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${String(err?.message || err).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
