#!/usr/bin/env node
// scripts/no-claude-scan.js
// Release gate: no AI tool text may reach a shared repo.
// Usage: node scripts/no-claude-scan.js --repo <path> --base <ref> [--pr-title <t>] [--pr-body-file <f>]
// Scans: added diff lines, new file paths, every commit message, trailer, author and committer,
// the branch name, and the PR title and body.
// Allow-list: `.signal-scan-allow` in the repo root, one regex per line ('#' starts a comment).
// A hit is allowed when a regex matches `<where>\t<text>`. <where> is `file:line`, `path:file`, `commit:sha`,
// `branch`, `pr-title` or `pr-body:n`. Allowed hits are printed as notes.
// Read-only. No network.
// Exit: 0 clean, 1 hits, 2 bad input.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Edit the rules here. Each is checked on every scanned line.
export const RULES = [
  { id: 'name', re: /claude/i, why: 'tool name' },
  { id: 'vendor', re: /anthropic/i, why: 'vendor name' },
  { id: 'coauthor', re: /co-authored-by:.*\b(claude|anthropic|ai|copilot|gpt|openai|cursor|codex|bot)\b/i, why: 'AI co-author trailer' },
  { id: 'session-link', re: /claude\.ai\/code/i, why: 'session link' },
  { id: 'session-id', re: /session_[0-9A-Za-z]{6,}/, why: 'session id' },
  { id: 'generated', re: /🤖\s*Generated with/i, why: 'generated-with footer' },
];

export const ALLOW_FILE = '.signal-scan-allow';

const realGit = (repo) => (args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function loadAllow(repo) {
  const f = path.join(repo, ALLOW_FILE);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(s => new RegExp(s));
}

// Check one line of text. Returns hits as { where, text, rule }.
function checkLine(where, text, out) {
  for (const r of RULES) if (r.re.test(text)) out.push({ where, text: text.trim().slice(0, 200), rule: r.id });
}

// Parse a unified=0 diff into added lines with file and line number.
export function addedLines(diff) {
  const out = [];
  let file = null;
  let n = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); if (file === '/dev/null') file = null; continue; }
    const h = line.match(/^@@ -\S+ \+(\d+)/);
    if (h) { n = Number(h[1]); continue; }
    if (!file) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) { out.push({ file, line: n, text: line.slice(1) }); n++; }
  }
  return out;
}

export function scan({ repo, base, prTitle = '', prBody = '', git = realGit(repo) }) {
  const hits = [];
  const mergeBase = git(['merge-base', base, 'HEAD']).trim() || base;

  for (const a of addedLines(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', `${mergeBase}..HEAD`]))) {
    if (a.file === ALLOW_FILE) continue;
    checkLine(`${a.file}:${a.line}`, a.text, hits);
  }
  for (const p of git(['diff', '--name-only', '--diff-filter=AR', `${mergeBase}..HEAD`]).split('\n').filter(Boolean)) {
    checkLine(`path:${p}`, p, hits);
  }
  const log = git(['log', '--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e', `${base}..HEAD`]);
  for (const rec of log.split('\x1e').map(s => s.replace(/^\n/, '')).filter(s => s.trim())) {
    const [sha, author, committer, ...msg] = rec.split('\x1f');
    const short = sha.slice(0, 10);
    checkLine(`commit:${short}`, `author ${author}`, hits);
    checkLine(`commit:${short}`, `committer ${committer}`, hits);
    for (const l of msg.join('\x1f').split('\n')) checkLine(`commit:${short}`, l, hits);
  }
  checkLine('branch', git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), hits);
  prTitle.split('\n').forEach(l => checkLine('pr-title', l, hits));
  prBody.split('\n').forEach((l, i) => checkLine(`pr-body:${i + 1}`, l, hits));

  const allow = loadAllow(repo);
  const bad = [];
  const notes = [];
  for (const h of hits) (allow.some(re => re.test(`${h.where}\t${h.text}`)) ? notes : bad).push(h);
  return { hits: bad, notes };
}

const flag = (a, n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };

export function run(argv) {
  const repo = flag(argv, 'repo');
  const base = flag(argv, 'base');
  if (!repo || !base) { console.error('usage: no-claude-scan.js --repo <path> --base <ref> [--pr-title <t>] [--pr-body-file <f>]'); return 2; }
  const bodyFile = flag(argv, 'pr-body-file');
  if (bodyFile && !fs.existsSync(bodyFile)) { console.error(`error: ${bodyFile} not found`); return 2; }
  const { hits, notes } = scan({
    repo: path.resolve(repo), base,
    prTitle: flag(argv, 'pr-title') || '',
    prBody: bodyFile ? fs.readFileSync(bodyFile, 'utf8') : '',
  });
  for (const n of notes) console.log(`note (allowed) ${n.where} [${n.rule}] ${n.text}`);
  if (hits.length) {
    console.log(`FAIL: ${hits.length} hit(s)`);
    for (const h of hits) console.log(`${h.where} [${h.rule}] ${h.text}`);
    return 1;
  }
  console.log(`ok: no hits${notes.length ? ` (${notes.length} allowed)` : ''}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 2;
  }
}
