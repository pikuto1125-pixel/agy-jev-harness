#!/usr/bin/env node
// tool_guard.mjs — real enforcement for the PreToolUse hook (matcher: run_command).
//
// It looks ONLY at the command line the agent is about to run, never at what the user typed, so an ordinary
// request such as "delete unused imports" can never trip it. For a clearly destructive command it answers
//   {"decision":"ask","reason":"..."}      (or "deny" / "force_ask", see JEV_GUARD_MODE)
// and for everything else it answers {} (no opinion): the user's own permission settings stay in charge.
// It never answers "allow", because that would silently auto-approve commands.
//
// Pure and deterministic: 0 tokens, no network, no file access.
//   JEV_GUARD_MODE=ask (default) | deny | force_ask | off

import fs from 'node:fs';
import path from 'node:path';
import { expandHome, isMain, parseArgs, readStdin } from './jev_client.mjs';

const RECURSIVE_CMDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri']);
const SPLIT_RE = /\s*(?:&&|\|\||;|\||\r?\n|&(?!&))\s*/;
const DB_CLIENT_RE = /\b(?:psql|mysql|mariadb|sqlite3?|sqlcmd|mongosh?|redis-cli|clickhouse(?:-client)?|cockroach|duckdb|snowsql|sqlplus|isql|bq|dropdb|mysqladmin)\b/i;

const stripQuotes = (s) => s.replace(/^['"`]+|['"`]+$/g, '');

/** Targets whose recursive deletion is never a routine cleanup: filesystem / home / drive roots, "everything here". */
export function isBroadTarget(raw) {
  const t = stripQuotes(String(raw)).replace(/[\\/]+$/, (m) => (m ? '/' : ''));
  const n = t.replace(/\\/g, '/');
  if (['/', '/*', '~', '~/', '~/*', '*', '.', './', './*', '..', '../', '.git', '$home', '${home}', '$home/*', '$env:userprofile', '%userprofile%', '$home/'].includes(n.toLowerCase())) return true;
  if (/^[A-Za-z]:\/?\*?$/.test(n)) return true; // drive root
  if (/^[A-Za-z]:\/Users\/?\*?$/i.test(n)) return true;
  if (/^\/(?:etc|usr|var|bin|sbin|boot|lib|home|root|Users|System|Library)\/?\*?$/.test(n)) return true;
  return false;
}

// ───────────────────────── sudo / env / nohup layers ─────────────────────────
// \`sudo -u root rm -rf /\`, \`sudo -E -- rm -rf ~\`, \`env -i FOO=1 -u BAR rm -rf /\` are the bare command with a prefix. The prefix (and its options and
// their values) is peeled off so the real command is judged; \`-u <user>\`, \`-E\`, \`-n\`, \`--\`, \`KEY=VAL\`, \`-i\` never hide it.

const WRAP_NAME_RE = /^\s*(?:[^\s"';&|()]*[\\/])?(?<n>sudo|doas|env|nohup|time|command|exec|builtin)(?:\.exe)?(?=\s|$)/i;
const SUDO_OPT_RE = /^\s+(?:--(?:user|group|host|prompt|chdir|role|type|other-user|close-from|command-timeout|chroot)(?:=\S+|\s+\S+)|--[a-z-]*|-[a-zA-Z]*[ugphCDRTrtU]\s+\S+|-[a-zA-Z]+)(?=\s|$)/;
const ENV_OPT_RE = /^\s+(?:-[iv0]+|--ignore-environment|--null|--debug|-u\s+\S+|--unset(?:=|\s+)\S+|-C\s+\S+|--chdir(?:=|\s+)\S+|-S\s+(?:"[^"]*"|'[^']*'|\S+)|--split-string(?:=|\s+)\S+|--|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))(?=\s|$)/;

/** Peel leading sudo / doas / env / nohup / time / command / exec layers (with their options) off the front of a command. */
export function stripLeadingWrappers(text) {
  let rest = String(text ?? '');
  for (let guard = 0; guard < 12; guard++) {
    const m = rest.match(WRAP_NAME_RE);
    if (!m) break;
    const name = m.groups.n.toLowerCase();
    rest = rest.slice(m[0].length);
    const optRe = name === 'env' ? ENV_OPT_RE : name === 'sudo' || name === 'doas' ? SUDO_OPT_RE : /^\s+-[a-zA-Z-]+(?=\s)/;
    for (let i = 0; i < 24; i++) {
      const o = rest.match(optRe);
      if (!o) break;
      rest = rest.slice(o[0].length);
    }
    rest = rest.replace(/^\s+/, '');
  }
  return rest;
}

/** The same peeling for every command position inside a longer line (after ; && || | and newlines), quotes left untouched. */
function stripWrappersEverywhere(line) {
  const re = /(?:^|[;&|(\n])[ \t]*(?=(?:[^\s"';&|()]*[\\/])?(?:sudo|doas|env|nohup|time|command|exec|builtin)(?:\.exe)?(?:\s|$))/gi;
  let out = '';
  let pos = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const start = m.index + m[0].length;
    if (start < pos) continue;
    const stripped = stripLeadingWrappers(line.slice(start));
    out += line.slice(pos, start);
    pos = line.length - stripped.length;
    re.lastIndex = pos;
  }
  return out + line.slice(pos);
}

function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(stripQuotes);
}

function checkSegment(seg) {
  const toks = tokens(stripLeadingWrappers(seg));
  if (!toks.length) return null;
  const cmd = toks[0].toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop();
  const rest = toks.slice(1);
  const lower = rest.map((t) => t.toLowerCase());

  // recursive delete of something broad
  if (RECURSIVE_CMDS.has(cmd)) {
    const shortRecursive = (t) => /^-[a-z]{1,4}$/.test(t) && t.includes('r'); // -r -rf -fr -Rf
    const recursive = lower.some(shortRecursive) || lower.includes('--recursive') || lower.includes('-recurse') || lower.includes('/s');
    if (recursive && rest.some((t) => !/^(-|\/[a-z]$)/i.test(t) && isBroadTarget(t))) return ['recursive_delete_broad_target', 'Recursive delete of a root, home, drive or whole-directory target.'];
  }

  if (cmd === 'git') {
    // skip global options that take a value (git -C dir push ...)
    const args = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-C' || rest[i] === '-c') i++;
      else args.push(rest[i]);
    }
    const largs = args.map((t) => t.toLowerCase());
    const sub = largs.find((t) => !t.startsWith('-')) || '';
    const shortHas = (t, ch) => /^-[a-z]+$/i.test(t) && t.includes(ch);
    if (sub === 'push') {
      if (largs.some((t) => t === '--force' || t.startsWith('--force-with-lease') || t === '--mirror' || t === '--delete' || (!t.startsWith('--') && (shortHas(t, 'f') || t === '-d')) || /^\+\S+/.test(t)))
        return ['git_force_or_destructive_push', 'git push that rewrites or deletes remote history.'];
    }
    if (sub === 'reset' && largs.includes('--hard')) return ['git_reset_hard', 'git reset --hard discards uncommitted work.'];
    if (sub === 'clean' && largs.some((t) => t === '--force' || (!t.startsWith('--') && shortHas(t, 'f')))) return ['git_clean_force', 'git clean -f deletes untracked files.'];
    if (sub === 'branch' && args.includes('-D')) return ['git_branch_force_delete', 'git branch -D force-deletes a branch.'];
    if (sub === 'stash' && (largs.includes('clear') || largs.includes('drop'))) return ['git_stash_discard', 'Discards stashed work.'];
    if ((sub === 'checkout' || sub === 'restore') && largs.includes('.') && !largs.includes('--staged')) return ['git_discard_all_changes', 'Discards every working-tree change.'];
  }

  // disk / device level
  if (/^mkfs(\.|$)/.test(cmd) || cmd === 'diskpart' || cmd === 'fdisk' || cmd === 'parted' || cmd === 'wipefs' || cmd === 'shred') return ['disk_level_tool', 'Disk partition / format / wipe tool.'];
  if (cmd === 'format' && rest.some((t) => /^[A-Za-z]:$/.test(t))) return ['format_drive', 'Formats a drive.'];
  if (['format-volume', 'clear-disk', 'initialize-disk'].includes(cmd)) return ['format_drive', 'Formats or clears a disk.'];
  if (cmd === 'dd' && rest.some((t) => /^of=\/dev\//.test(t))) return ['dd_to_device', 'dd writes straight to a device.'];
  if ((cmd === 'chmod' || cmd === 'chown') && lower.some((t) => t === '-r' || t === '--recursive') && rest.some((t) => isBroadTarget(t))) return ['recursive_permission_change', 'Recursive permission change on a broad target.'];

  // infrastructure / publishing
  if (cmd === 'terraform' && (lower.includes('destroy') || (lower.includes('apply') && lower.includes('-destroy')))) return ['terraform_destroy', 'Destroys infrastructure.'];
  if (cmd === 'kubectl' && lower.includes('delete') && (lower.includes('--all') || lower.some((t) => /^(?:ns|namespaces?)$/.test(t)))) return ['kubectl_delete_broad', 'Deletes a namespace or every resource of a kind.'];
  if (cmd === 'aws' && lower[0] === 's3' && ((lower[1] === 'rm' && lower.includes('--recursive')) || lower[1] === 'rb')) return ['aws_s3_recursive_delete', 'Deletes a bucket or all objects under a prefix.'];
  if (cmd === 'gh' && lower[0] === 'repo' && lower[1] === 'delete') return ['gh_repo_delete', 'Deletes a GitHub repository.'];
  if (cmd === 'docker' && (lower[0] === 'system' || lower[0] === 'volume') && lower[1] === 'prune') return ['docker_prune', 'Prunes docker data.'];
  if (['npm', 'pnpm', 'yarn', 'cargo'].includes(cmd) && (lower.includes('publish') || lower.includes('unpublish'))) return ['package_publish', 'Publishes or unpublishes a package.'];
  if (cmd === 'twine' && lower.includes('upload')) return ['package_publish', 'Uploads a package to an index.'];

  // production database tooling
  if (['prisma', 'npx', 'rails', 'rake', 'bundle', 'sequelize', 'sequelize-cli', 'knex'].includes(cmd) && /(?:migrate\s+reset|db:drop|db:reset|db:schema:load|migrate:rollback\s+--all|db:migrate:reset)/i.test(seg)) return ['db_reset_task', 'Resets or drops a database.'];
  if (cmd === 'python' || cmd === 'python3' || cmd === 'py') if (/manage\.py\s+(?:flush|sqlflush|reset_db)/i.test(seg)) return ['db_reset_task', 'Flushes a database.'];

  // pipe-to-shell is handled at command level (needs the whole line)
  return null;
}

/** Whole-line checks that need to see across a pipe or the full SQL text. */
function checkWholeLine(cmdline) {
  if (/\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell|iex|invoke-expression)\b/i.test(cmdline))
    return ['pipe_download_to_shell', 'Downloads and runs a script in one step.'];
  const DOWNLOAD_RE = /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b/i;
  if (DOWNLOAD_RE.test(cmdline)) {
    const parts = cmdline.split(/(?<!\|)\|(?!\|)/); // single pipes only
    for (let i = 1; i < parts.length; i++) {
      const head = stripLeadingWrappers(parts[i]).trim();
      if (/^(?:[^\s]*[\\/])?(?:(?:ba|z|da|k|a)?sh|pwsh|powershell)(?:\.exe)?(?=\s|$)|^(?:iex|invoke-expression)\b/i.test(head) && DOWNLOAD_RE.test(parts.slice(0, i).join('|')))
        return ['pipe_download_to_shell', 'Downloads and runs a script in one step.'];
    }
  }
  if (DB_CLIENT_RE.test(cmdline)) {
    if (/\bdrop\s+(?:table|database|schema|index|view)\b/i.test(cmdline) || /\btruncate\s+(?:table\s+)?[\w."`[\]]+/i.test(cmdline))
      return ['sql_drop_or_truncate', 'SQL that drops or truncates data.'];
    if (/\bdelete\s+from\s+[\w."`[\]]+/i.test(cmdline) && !/\bwhere\b/i.test(cmdline)) return ['sql_delete_without_where', 'DELETE FROM without a WHERE clause.'];
    if (/\b(?:dropdb|mysqladmin\s+(?:-\S+\s+)*drop)\b/i.test(cmdline)) return ['sql_drop_or_truncate', 'Drops a database.'];
  }
  return null;
}

// ───────────────────────── shell wrappers ─────────────────────────
// `bash -c "rm -rf ~"`, `pwsh -NoProfile -Command "Remove-Item -Recurse -Force C:\"`, `cmd /c "rd /s /q C:\"` hide the real
// command inside one quoted argument. The inner script is pulled out and judged exactly like a bare command, up to
// MAX_WRAP_DEPTH layers; a deeper nest is itself reported (nobody needs four shells to tidy a folder).

const MAX_WRAP_DEPTH = 3;
const WRAPPER_RE = /(?:^|[;&|(\n])[ \t]*(?:(?:[^\s"';&|()]*[\\/])?(?:sudo|doas|env|nohup|time|command|exec|start)[ \t]+(?:-\S+[ \t]+)*)*(?:[^\s"';&|()]*[\\/])?(?<name>(?:ba|z|da|k|a)?sh|powershell|pwsh|cmd)(?:\.exe)?(?=[ \t])/gi;

// PowerShell accepts any unambiguous prefix of a parameter name (-exec, -nop, -noni, -w, -enc ...) behind "-" (and "/" on Windows).
const PS_PARAMS = ['command', 'file', 'encodedcommand', 'encodedarguments', 'executionpolicy', 'noprofile', 'noninteractive', 'nologo', 'noexit', 'windowstyle', 'sta', 'mta', 'inputformat', 'outputformat', 'workingdirectory', 'version', 'configurationname', 'settingsfile', 'custompipename', 'login', 'interactive', 'help'];
const PS_ALIASES = { c: 'command', f: 'file', e: 'encodedcommand', ec: 'encodedcommand', ea: 'encodedarguments', ep: 'executionpolicy', w: 'windowstyle', wd: 'workingdirectory', i: 'inputformat', if: 'inputformat', of: 'outputformat', nop: 'noprofile', noni: 'noninteractive', nol: 'nologo', noe: 'noexit', l: 'login', v: 'version' };
const PS_VALUE_PARAMS = new Set(['executionpolicy', 'windowstyle', 'workingdirectory', 'inputformat', 'outputformat', 'version', 'configurationname', 'settingsfile', 'custompipename', 'encodedarguments']);

/** "-exec" -> {name:'executionpolicy', takesValue:true}; null when the token is not a PowerShell option at all. */
export function psOption(tok) {
  const m = String(tok).match(/^[-/]([A-Za-z]+)(:.*)?$/);
  if (!m) return null;
  const w = m[1].toLowerCase();
  let name = PS_ALIASES[w] || (PS_PARAMS.includes(w) ? w : null);
  if (!name) {
    const c = PS_PARAMS.filter((n) => n.startsWith(w));
    if (c.length === 1) name = c[0];
    else if (c.length > 1) name = c.includes('command') && w.startsWith('com') ? 'command' : c[0]; // ambiguous prefixes are an error in PowerShell; judge them as the first match
  }
  if (!name) return { name: 'unknown', takesValue: false, attached: Boolean(m[2]) };
  return { name, takesValue: PS_VALUE_PARAMS.has(name) && !m[2], attached: Boolean(m[2]) };
}

/** First shell "word" of `s`: quote-aware ("..." with \" escapes, '...'); an unquoted rest of the line is taken whole. */
function firstArgument(s) {
  const t = s.replace(/^\s+/, '');
  const q = t[0];
  if (q !== '"' && q !== "'") return t;
  let out = '';
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if (q === '"' && c === '\\' && t[i + 1] === '"') {
      out += '"';
      i++;
    } else if (c === q) return out;
    else out += c;
  }
  return t.slice(1).replace(new RegExp(`${q}\\s*$`), ''); // unterminated (e.g. a trailing "C:\" ): take the rest literally
}

/** Inner scripts of every shell wrapper found in `line` (at command position). */
export function unwrapShell(rawLine) {
  const line = stripWrappersEverywhere(rawLine);
  const inner = [];
  for (const m of line.matchAll(WRAPPER_RE)) {
    const name = m.groups.name.toLowerCase();
    let rest = line.slice(m.index + m[0].length);
    for (let hops = 0; hops < 12; hops++) {
      const tok = rest.match(/^\s+(\S+)/);
      if (!tok) break;
      const t = tok[1];
      const after = rest.slice(tok[0].length);
      if (/^(?:ba|z|da|k|a)?sh$/.test(name)) {
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) {
          inner.push(firstArgument(after));
          break;
        }
        if (/^[-+]o$/.test(t)) {
          rest = after.replace(/^\s+\S+/, ''); // -o <option>
          continue;
        }
        if (!/^[-+]/.test(t)) break; // a script path, not an option
      } else if (name === 'cmd') {
        if (/^\/[ckr]$/i.test(t)) {
          inner.push(firstArgument(after));
          break;
        }
        if (!t.startsWith('/')) break;
      } else {
        // powershell / pwsh
        const o = psOption(t);
        if (o) {
          if (o.name === 'command') {
            inner.push(firstArgument(after));
            break;
          }
          if (o.name === 'encodedcommand') {
            const b64 = after.match(/^\s+(\S+)/);
            if (b64) inner.push(Buffer.from(stripQuotes(b64[1]), 'base64').toString('utf16le'));
            break;
          }
          if (o.name === 'file') break; // runs a script file we cannot see
          if (o.takesValue) {
            rest = after.replace(/^\s+\S+/, '');
            continue;
          }
        } else if (!/^[-/]/.test(t) || /^\/[^\s]*[\\/]/.test(t)) {
          inner.push(firstArgument(rest)); // `pwsh Remove-Item ...` is an implicit -Command (so is a unix-style path)
          break;
        }
      }
      rest = after;
    }
  }
  return inner.filter((s) => s.trim());
}

/** Returns { rule, reason } for a destructive command line, or null. Shell wrappers are opened up to MAX_WRAP_DEPTH deep. */
export function classifyCommand(cmdline, depth = 0) {
  const line = String(cmdline ?? '');
  if (!line.trim()) return null;
  const whole = checkWholeLine(line);
  if (whole) return { rule: whole[0], reason: whole[1] };
  for (const seg of line.split(SPLIT_RE)) {
    const hit = checkSegment(seg);
    if (hit) return { rule: hit[0], reason: hit[1] };
  }
  const wrapped = unwrapShell(line);
  if (wrapped.length && depth >= MAX_WRAP_DEPTH) return { rule: 'shell_wrapper_nested_too_deep', reason: `Shell wrappers nested more than ${MAX_WRAP_DEPTH} levels deep; the real command cannot be inspected.` };
  for (const inner of wrapped) {
    const hit = classifyCommand(inner, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ───────────────────────── large file reads (workspace mode) ─────────────────────────
// Reading a whole 300 KB file to find one function burns the context that compaction then has to rescue. In a workspace
// (JEV_WORKSPACE_MODE=1, or a sessions_keep.json is found) a read of a file over LARGE_READ_BYTES without StartLine /
// EndLine gets an "ask" that points at lean_outline.mjs (outline / slice, zero tokens). JEV_LARGE_READ_GUARD=off disables it.

export const LARGE_READ_BYTES = 120 * 1024;
const READ_TOOLS = new Set(['read_file', 'view_file']);
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const pickArg = (args, ...keys) => {
  for (const k of keys) if (args[k] !== undefined && args[k] !== null && String(args[k]) !== '') return args[k];
  return undefined;
};

function largeReadHit(args, env, opts) {
  if (String(env.JEV_LARGE_READ_GUARD || '').toLowerCase() === 'off') return null;
  if (pickArg(args, 'StartLine', 'startLine', 'start_line') !== undefined || pickArg(args, 'EndLine', 'endLine', 'end_line') !== undefined) return null;
  const file = pickArg(args, 'AbsolutePath', 'absolutePath', 'TargetFile', 'path', 'file_path', 'filePath');
  if (!file) return null;
  const workspace = truthy(env.JEV_WORKSPACE_MODE) || Boolean(typeof opts.findRoot === 'function' && opts.findRoot());
  if (!workspace) return null;
  let size = 0;
  try {
    size = fs.statSync(path.resolve(expandHome(String(file)))).size;
  } catch {
    return null;
  }
  if (size <= LARGE_READ_BYTES) return null;
  return {
    rule: 'large_read_without_range',
    reason: `Reading ${Math.round(size / 1024)} KB whole. Run "node scripts/lean_outline.mjs outline <file>" then "slice <file> <query>", or pass StartLine/EndLine.`,
  };
}

/** PreToolUse payload -> hook output. `{}` means "no opinion". Never throws. opts.findRoot(): workspace root or null. */
export function evaluateToolCall(payload, env = process.env, opts = {}) {
  try {
    const mode = String(env.JEV_GUARD_MODE || 'ask').toLowerCase();
    if (mode === 'off') return {};
    const call = payload?.toolCall;
    const name = String(call?.name || '').toLowerCase();
    if (!call) return {};
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    if (READ_TOOLS.has(name)) {
      const big = largeReadHit(args, env, opts);
      return big ? { decision: 'ask', reason: `[jev-harness guard:${big.rule}] ${big.reason}` } : {};
    }
    if (name !== 'run_command') return {};
    const cmdline = String(args.CommandLine ?? args.commandLine ?? args.command ?? '');
    const hit = classifyCommand(cmdline);
    if (!hit) return {};
    const decision = mode === 'deny' ? 'deny' : mode === 'force_ask' ? 'force_ask' : 'ask';
    return { decision, reason: `[jev-harness guard:${hit.rule}] ${hit.reason} Confirm this is intended.` };
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs();
  const cmdline = String(args.command || args._.join(' ') || (await readStdin()));
  const hit = classifyCommand(cmdline);
  console.log(JSON.stringify({ destructive: Boolean(hit), ...(hit || {}) }, null, 2));
}

if (isMain(import.meta.url)) await main();
