#!/usr/bin/env node
// init_workspace.mjs — scaffold the full multi-desk workspace harness from starter/. Zero model calls.
//
//   node init_workspace.mjs --target <dir> [--lang ja|en] [--force] [--dry-run]
//
// Creates AGENTS.md, GEMINI.md, rules/CORE.md, rules/HARNESS_SPEC.md, Tasks/sessions_keep.json, Tasks/handover_now.md,
// Tasks/decisions_open.md, Tasks/session_roles/{coordinator,venture_lab,quant_lab,creative_studio,harness_dock}.md,
// harness_dock/BACKLOG.md, _backups/.gitkeep and a small .gitignore.
//
// Idempotent and non-destructive: an existing file is SKIPPED unless --force; with --force the original is first copied to
// <target>/_backups/<timestamp>/<same relative path>. A symlink is never written through. Output is JSON.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, atomicWriteFileSync, expandHome, isMain, parseArgs } from './jev_client.mjs';

export const STARTER_DIR = path.join(PLUGIN_ROOT, 'starter');
export const LANGS = ['en', 'ja'];

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

/** Relative path -> absolute source file. The language folder wins over starter/common. */
export function starterFiles(lang = 'en', starterDir = STARTER_DIR) {
  const map = new Map();
  for (const sub of ['common', lang]) {
    const dir = path.join(starterDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const rel of listFiles(dir)) map.set(rel, path.join(dir, rel));
  }
  return map;
}

export function initWorkspace({ target, lang = 'en', force = false, dryRun = false, now = new Date(), starterDir = STARTER_DIR } = {}) {
  if (!target) return { ok: false, reason: 'no_target', hint: '--target <dir>' };
  if (!LANGS.includes(lang)) return { ok: false, reason: 'bad_lang', langs: LANGS };
  const root = path.resolve(expandHome(String(target)));
  if (root === path.parse(root).root || root === os.homedir()) return { ok: false, reason: 'refusing_root_or_home', target: root };
  const src = starterFiles(lang, starterDir);
  if (!src.size) return { ok: false, reason: 'starter_missing' };

  const created = [];
  const skipped = [];
  const overwritten = [];
  const backedUp = [];
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (const [rel, from] of src) {
    const to = path.join(root, rel);
    let st = null;
    try {
      st = fs.lstatSync(to);
    } catch {
      /* does not exist */
    }
    if (st?.isSymbolicLink()) {
      skipped.push({ file: rel, why: 'symlink' });
      continue;
    }
    if (st && !force) {
      skipped.push({ file: rel, why: 'exists' });
      continue;
    }
    if (st && fs.readFileSync(to).equals(fs.readFileSync(from))) {
      skipped.push({ file: rel, why: 'identical' });
      continue;
    }
    if (dryRun) {
      (st ? overwritten : created).push(rel);
      continue;
    }
    if (st) {
      const bak = path.join(root, '_backups', stamp, rel);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(to, bak);
      backedUp.push(path.relative(root, bak).replace(/\\/g, '/'));
      overwritten.push(rel);
    } else created.push(rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    atomicWriteFileSync(to, fs.readFileSync(from, 'utf8'));
  }
  return { ok: true, target: root, lang, dryRun, created, overwritten, backedUp, skipped, next: [`set JEV_WORKSPACE_DIR=${root}  (so hooks find the bus)`, 'node scripts/session_bus.mjs bind --desk coordinator --conv-id <conversation id>', 'node scripts/bloat_guard.mjs --root <target> --brief'] };
}

function main() {
  const args = parseArgs();
  const r = initWorkspace({ target: args.target ? String(args.target) : '', lang: String(args.lang || 'en'), force: Boolean(args.force), dryRun: Boolean(args['dry-run']) });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) {
    console.error('usage: init_workspace.mjs --target <dir> [--lang ja|en] [--force] [--dry-run]');
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${String(err?.message || err).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
