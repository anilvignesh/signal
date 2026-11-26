#!/usr/bin/env node
// scripts/pr-ship.js
// The PR stage, one explicit step per subcommand.
//   plan       --repo <path> [--title <t>]   print branch, base, title, label, reviewers. Changes nothing.
//   sync       --repo <path>                 merge the latest origin/main into the branch. Aborts on conflict.
//   open       --repo <path> [--title <t>] [--body-file <f>] [--part n/m] [--after <earlier PR link>]
//                                            scan title, body, diff and commits, push, create the PR with no reviewers.
//   label      --repo <path>                 add the ready-to-merge label, only when the branch is current.
//   checks     --repo <path> [--wait <seconds>] [--interval <seconds>]
//                                            exit 0 all pass, 1 any fail, 2 pending.
//   reviewers  --repo <path>                 request reviewers per config, only when checks pass and the branch is current.
// Every subcommand except `plan` needs env SIGNAL_PR_CONFIRMED=1. The Director sets it only after the user said yes to `plan`.
// Never creates labels. Never runs tests (the Director does). Config: config/pr-routing.json (or --config).
// Exit: 0 ok, 1 refused or failed, 2 checks pending, 64 bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scan } from './no-claude-scan.js';
import { prSize, maxFiles, maxLines } from './pr-size.js';
import { testCheck } from './check-tests.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, '..', 'config', 'pr-routing.json');
export const EXIT = { OK: 0, FAIL: 1, PENDING: 2, USAGE: 64 };

// Runners take an args array and return stdout. They throw on a non-zero exit.
export const makeRunner = (cmd, cwd) => (args) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

const flag = (a, n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };

export function repoName(repo, git) {
  let remote = '';
  try { remote = git(['remote', 'get-url', 'origin']).trim(); } catch { /* none */ }
  const base = (s) => path.basename(s.replace(/\/+$/, '')).replace(/\.git$/, '');
  const names = [remote && base(remote), base(path.resolve(repo))].filter(Boolean);
  return names;
}

export function routeFor(config, names) {
  for (const n of names) if (config.repos[n]) return { name: n, ...config.repos[n] };
  return refuse(`no routing for repo (${names.join(', ')}); add it to config/pr-routing.json`);
}

const requireConfirmed = (env) => {
  if (env.SIGNAL_PR_CONFIRMED !== '1') refuse('refused: SIGNAL_PR_CONFIRMED=1 is not set. Run `plan`, get the user\'s yes, then set it.');
};

const branchOf = (git) => {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (!b || b === 'HEAD') refuse('refused: detached HEAD');
  return b;
};

const isClean = (git) => git(['status', '--porcelain']).trim() === '';

// Fetches main, then reports whether origin/main is already in the branch.
export function isCurrent(git, base) {
  git(['fetch', 'origin', base]);
  try { git(['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD']); return true; } catch { return false; }
}

const defaultTitle = (git, base) => {
  const subjects = git(['log', '--reverse', '--format=%s', `origin/${base}..HEAD`]).split('\n').filter(Boolean);
  return subjects[0] || '';
};

export function plan({ git, route, config, argv, out }) {
  const base = config.base || 'main';
  const title = flag(argv, 'title') || defaultTitle(git, base);
  const missing = route.reviewers.filter(r => !r.login).map(r => r.name);
  out(`repo:      ${route.name} (${route.kind})`);
  out(`branch:    ${branchOf(git)}`);
  out(`base:      ${base}`);
  const size = prSize(git, `origin/${base}`, config.maxFiles || maxFiles(), config.maxLines || maxLines());
  out(`size:      ${size.files.length} files, ${size.lines} lines (limits ${size.max} files, ${size.maxLines} lines)${size.ok ? '' : ' - TOO BIG, open will refuse'}`);
  const tc = testCheck(git, `origin/${base}`);
  out(`tests:     ${tc.ok ? `ok (${tc.tests.length} test files, ${tc.source.length} source files)` : 'MISSING - source changed with no test file, open will refuse'}`);
  out(`title:     ${title || '(none: pass --title)'}`);
  out(`label:     ${route.readyLabel || '(none: this repo has no ready-to-merge label; label step is skipped)'}`);
  out(`reviewers: ${route.reviewers.map(r => `${r.name} (${r.login || 'login unknown'})`).join(', ')}`);
  if (missing.length) out(`warning:   no GitHub login for ${missing.join(', ')}; they get a chat message instead`);
  return EXIT.OK;
}

export function sync({ git, config, out }) {
  const base = config.base || 'main';
  branchOf(git);
  if (!isClean(git)) refuse('refused: working tree has uncommitted changes');
  git(['fetch', 'origin', base]);
  if (isCurrent(git, base)) { out('already up to date with origin/' + base); return EXIT.OK; }
  try {
    git(['merge', '--no-edit', `origin/${base}`]);
  } catch {
    let files = '';
    try { files = git(['diff', '--name-only', '--diff-filter=U']).trim(); } catch { /* ignore */ }
    try { git(['merge', '--abort']); } catch { /* ignore */ }
    out(`conflict merging origin/${base}; merge aborted, branch unchanged`);
    for (const f of files.split('\n').filter(Boolean)) out(`  conflict: ${f}`);
    return EXIT.FAIL;
  }
  out(`merged origin/${base}. Re-run the local tests before pushing.`);
  return EXIT.OK;
}

export function open({ git, gh, config, argv, out, repo }) {
  const base = config.base || 'main';
  const branch = branchOf(git);
  git(['fetch', 'origin', base]);
  const title = flag(argv, 'title') || defaultTitle(git, base);
  if (!title) refuse('refused: no title; pass --title');
  const bodyFile = flag(argv, 'body-file');
  const part = flag(argv, 'part'), after = flag(argv, 'after');
  if (part && !/^\d+\/\d+$/.test(part)) refuse('refused: --part must look like 2/3');
  if (part && !after && !part.startsWith('1/')) refuse('refused: a later part needs --after <earlier PR link>');
  const stack = part ? `## Stack\nPart ${part}.${after ? ` Merge after ${after}.` : ' Merge this first.'}\n\n` : '';
  const body = stack + (bodyFile
    ? fs.readFileSync(bodyFile, 'utf8')
    : '## Changes\n' + git(['log', '--reverse', '--format=- %s', `origin/${base}..HEAD`]));
  const size = prSize(git, `origin/${base}`, config.maxFiles || maxFiles(), config.maxLines || maxLines());
  if (!size.ok) {
    out(`refused: ${size.why.join('; ')}. Split the work into smaller PRs.`);
    return EXIT.FAIL;
  }
  const tc = testCheck(git, `origin/${base}`);
  if (!tc.ok) {
    out(`refused: ${tc.source.length} source file(s) changed and no test file. Tests ship in the same PR as the code.`);
    return EXIT.FAIL;
  }
  const { hits } = scan({ repo, base: `origin/${base}`, prTitle: title, prBody: body, git });
  if (hits.length) {
    out(`refused: no-claude scan found ${hits.length} hit(s)`);
    for (const h of hits) out(`  ${h.where} [${h.rule}] ${h.text}`);
    return EXIT.FAIL;
  }
  git(['push', '-u', 'origin', branch]);
  const url = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]).trim();
  out(`opened ${url} (no reviewers requested)`);
  return EXIT.OK;
}

export function label({ git, gh, route, config, out }) {
  const base = config.base || 'main';
  const branch = branchOf(git);
  if (!route.readyLabel) refuse(`refused: ${route.name} has no ready-to-merge label configured`);
  if (!isCurrent(git, base)) refuse(`refused: branch is behind origin/${base}; run sync first`);
  const labels = JSON.parse(gh(['label', 'list', '--json', 'name', '--limit', '200'])).map(l => l.name);
  if (!labels.includes(route.readyLabel)) refuse(`refused: label "${route.readyLabel}" does not exist in the repo; this tool never creates labels`);
  gh(['pr', 'edit', branch, '--add-label', route.readyLabel]);
  out(`added label "${route.readyLabel}"`);
  return EXIT.OK;
}

// Returns { state: 'pass'|'fail'|'pending', checks }.
export function readChecks(gh, branch) {
  let raw;
  try { raw = gh(['pr', 'checks', branch, '--json', 'name,bucket']); } catch (e) {
    raw = e.stdout || '';
    if (!raw.trim().startsWith('[')) return { state: 'pending', checks: [] };
  }
  const checks = JSON.parse(raw);
  if (!checks.length) return { state: 'pending', checks };
  if (checks.some(c => c.bucket === 'fail' || c.bucket === 'cancel')) return { state: 'fail', checks };
  if (checks.some(c => c.bucket === 'pending')) return { state: 'pending', checks };
  return { state: 'pass', checks };
}

export async function checks({ git, gh, argv, out, sleep }) {
  const branch = branchOf(git);
  const waitMs = Number(flag(argv, 'wait') || 0) * 1000;
  const interval = Number(flag(argv, 'interval') || 30) * 1000;
  let waited = 0;
  let r = readChecks(gh, branch);
  while (r.state === 'pending' && waited < waitMs) {
    await sleep(interval);
    waited += interval;
    r = readChecks(gh, branch);
  }
  for (const c of r.checks) out(`${c.bucket}\t${c.name}`);
  out(r.state);
  return r.state === 'pass' ? EXIT.OK : r.state === 'fail' ? EXIT.FAIL : EXIT.PENDING;
}

export function reviewers({ git, gh, route, config, out }) {
  const base = config.base || 'main';
  const branch = branchOf(git);
  const noLogin = route.reviewers.filter(r => !r.login);
  const noWay = noLogin.filter(r => !r.chat).map(r => r.name);
  if (noWay.length) refuse(`refused: no GitHub login and no chat id for ${noWay.join(', ')}`);
  if (!isCurrent(git, base)) refuse(`refused: branch is behind origin/${base}; run sync first`);
  const r = readChecks(gh, branch);
  if (r.state !== 'pass') refuse(`refused: checks are ${r.state}`);
  const viaGithub = route.reviewers.filter(x => x.login);
  if (viaGithub.length) {
    gh(['pr', 'edit', branch, '--add-reviewer', viaGithub.map(x => x.login).join(',')]);
    out(`requested reviewers: ${viaGithub.map(x => x.login).join(', ')}`);
  }
  for (const x of noLogin) out(`chat-needed: ${x.name} (${x.chat}); run notify and send the draft`);
  return EXIT.OK;
}

// Prints chat drafts. Sends nothing: the Director shows them to the user and sends only after a yes.
// Default: reviewers with no GitHub login. With --all: every reviewer.
export function notify({ git, gh, route, argv, out }) {
  const who = route.reviewers.filter(x => argv.includes('--all') || !x.login);
  if (!who.length) { out('no reviewer needs a chat message'); return EXIT.OK; }
  const branch = branchOf(git);
  const url = String(gh(['pr', 'view', branch, '--json', 'url', '--jq', '.url'])).trim();
  const title = String(gh(['pr', 'view', branch, '--json', 'title', '--jq', '.title'])).trim();
  for (const x of who) {
    if (!x.chat) refuse(`refused: no chat id for ${x.name}`);
    out(`to: ${x.name} (${x.chat})`);
    out(`Hi ${x.name}, please review this PR: ${title}\n${url}\nAll checks are green and the branch is up to date with ${route.base || 'main'}.`);
    out('---');
  }
  return EXIT.OK;
}

const COMMANDS = { plan, sync, open, label, checks, reviewers, notify };

// deps: { git, gh, env, out, sleep } are injectable for tests.
export async function run(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const out = deps.out || ((s) => console.log(s));
  const repoArg = flag(rest, 'repo');
  if (!COMMANDS[cmd] || !repoArg) { out('usage: pr-ship.js plan|sync|open|label|checks|reviewers|notify --repo <path>'); return EXIT.USAGE; }
  const repo = path.resolve(repoArg);
  const git = deps.git || makeRunner('git', repo);
  const gh = deps.gh || makeRunner('gh', repo);
  const env = deps.env || process.env;
  const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  try {
    const config = JSON.parse(fs.readFileSync(flag(rest, 'config') || DEFAULT_CONFIG, 'utf8'));
    const route = routeFor(config, repoName(repo, git));
    if (cmd !== 'plan') requireConfirmed(env);
    return await COMMANDS[cmd]({ git, gh, route, config, argv: rest, out, sleep, repo });
  } catch (err) {
    out(err instanceof Refuse ? err.message : `error: ${err.message}`);
    return EXIT.FAIL;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2)).then(c => { process.exitCode = c; });
}
