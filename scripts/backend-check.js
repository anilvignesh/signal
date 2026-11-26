#!/usr/bin/env node
// scripts/backend-check.js
// Mechanical pre-check of the added diff lines against ~/.claude/backend-checklist.md.
// Only runs for the repo `acme_backend` (remote URL or folder name). Other repos: skipped, exit 0.
//
// HONEST SCOPE: these are regex heuristics on added lines. They give false positives and false negatives.
// They only catch what a pattern can see. The judgement items (layering, field type choice, naming,
// silent no-ops, external API status handling, test justification) are covered by the backend-review agent.
//
// Usage: node scripts/backend-check.js --repo <path> --base <ref>
// Exit: 0 clean or skipped, 1 findings, 2 bad input.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { addedLines } from './no-claude-scan.js';

export const TARGET_REPO = 'acme_backend';

// Edit the checks here. Fields:
//   id       short name shown in the output
//   section  checklist section the check comes from
//   files    regex on the file path (the check only looks at matching files)
//   skip     regex on the file path to leave out (optional)
//   line     regex on the added line (after joining continuation lines for `joined` checks)
//   unless   regex on the same line that clears the finding (optional)
//   needs    (optional) a regex that must appear in the 8 lines above in the file, or the line is a finding
//   joined   true: join the following added lines until brackets balance before matching
//   msg      what to fix
export const CHECKS = [
  {
    id: 'raw-validation-error', section: 'Error raising & handling',
    files: /\.py$/, skip: /(^|\/)(validators?|tests?)(\/|_|\.)|test_|_test\.py|conftest\.py/,
    line: /\braise\s+(serializers\.)?ValidationError\b/,
    msg: 'explicit raise of a raw ValidationError; use AppValidationError(CONSTANT) from errors.py',
  },
  {
    id: 'task-without-acks-late', section: 'Celery / async tasks',
    files: /\.py$/, skip: /test_|_test\.py|conftest\.py/,
    line: /@shared_task\b/, joined: true, unless: /acks_late\s*=\s*True/,
    msg: '@shared_task without acks_late=True; baseline is @shared_task(ignore_result=True, soft_time_limit=30, acks_late=True)',
  },
  {
    id: 'orm-write-in-serializer-or-utils', section: 'Layering — keep logic in services',
    files: /(serializers?|utils?)[^/]*\.py$|\/(serializers?|utils?)\/.*\.py$/, skip: /test_|_test\.py|conftest\.py/,
    line: /\.save\(|\.objects\.create\(|\.delete\(|(objects|filter\(|queryset|\.all\(\)).*\.update\(|\.objects\.update\(/,
    msg: 'ORM write in a serializer or utils module; move persistence into a service (svc). Dict.update calls are ignored',
  },
  {
    id: 'email-not-via-celery', section: 'Celery / async tasks',
    files: /\.py$/, skip: /task|test_|_test\.py|conftest\.py/,
    line: /\b(send_mail|send_mass_mail|EmailMessage|EmailMultiAlternatives)\(|\bmsg\.send\(/, unless: /\.(delay|apply_async)\(/,
    msg: 'email sent outside a Celery task; send all emails through a task',
  },
  {
    id: 'has-permission-without-admin-guard', section: 'Views & permissions',
    files: /\.py$/, skip: /test_|_test\.py|conftest\.py/,
    line: /\.has_permission\(/, unless: /isinstance\(\s*request\.user\s*,\s*AdminUser\s*\)/,
    needs: /isinstance\(\s*request\.user\s*,\s*AdminUser\s*\)/,
    msg: 'has_permission called without an isinstance(request.user, AdminUser) guard above it',
  },
  {
    id: 'inline-permission-check', section: 'Views & permissions',
    files: /(views?|viewsets?|api)[^/]*\.py$|\/(views?|viewsets?|api)\/.*\.py$/, skip: /test_|_test\.py|conftest\.py/,
    line: /\.has_permission\(|\.has_perm\(|raise\s+PermissionDenied\b/,
    msg: 'inline permission check in a view body; use permission_classes or @check_permission like the other actions',
  },
  {
    id: 'inline-fixture', section: 'Tests',
    files: /(^|\/)(test_[^/]*|[^/]*_test)\.py$/, skip: /conftest\.py$/,
    line: /@pytest\.fixture\b/,
    msg: 'fixture defined in a test file; put fixtures in conftest.py',
  },
];

const realGit = (repo) => (args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function isTargetRepo(repo, git = realGit(repo)) {
  let remote = '';
  try { remote = git(['remote', 'get-url', 'origin']).trim(); } catch { /* no remote */ }
  const name = (s) => path.basename(s.replace(/\/+$/, '')).replace(/\.git$/, '');
  return (remote && name(remote) === TARGET_REPO) || name(path.resolve(repo)) === TARGET_REPO;
}

const balance = (s) => (s.match(/[([{]/g) || []).length - (s.match(/[)\]}]/g) || []).length;

export function check({ repo, base, git = realGit(repo), read }) {
  const mergeBase = git(['merge-base', base, 'HEAD']).trim() || base;
  const added = addedLines(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', `${mergeBase}..HEAD`]));
  const fileText = (f) => (read ? read(f) : git(['show', `HEAD:${f}`])).split('\n');
  const cache = new Map();
  const lines = (f) => { if (!cache.has(f)) cache.set(f, fileText(f)); return cache.get(f); };
  const findings = [];
  added.forEach((a, i) => {
    for (const c of CHECKS) {
      if (!c.files.test(a.file) || (c.skip && c.skip.test(a.file))) continue;
      let text = a.text;
      if (c.joined) {
        let j = i;
        while (balance(text) > 0 && added[j + 1] && added[j + 1].file === a.file && added[j + 1].line === added[j].line + 1 && j - i < 6) {
          j++; text += added[j].text;
        }
      }
      if (!c.line.test(text) || (c.unless && c.unless.test(text))) continue;
      if (c.needs) {
        const above = lines(a.file).slice(Math.max(0, a.line - 9), a.line - 1).join('\n');
        if (c.needs.test(above)) continue;
      }
      findings.push({ file: a.file, line: a.line, id: c.id, section: c.section, msg: c.msg });
    }
  });
  return findings;
}

const flag = (a, n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };

export function run(argv) {
  const repo = flag(argv, 'repo');
  const base = flag(argv, 'base');
  if (!repo || !base) { console.error('usage: backend-check.js --repo <path> --base <ref>'); return 2; }
  const abs = path.resolve(repo);
  if (!isTargetRepo(abs)) { console.log(`skipped: not ${TARGET_REPO}`); return 0; }
  const findings = check({ repo: abs, base });
  if (!findings.length) { console.log('ok: no mechanical findings (judgement items go to backend-review)'); return 0; }
  console.log(`FAIL: ${findings.length} finding(s)`);
  for (const f of findings) console.log(`${f.file}:${f.line} [${f.id}] ${f.msg} (checklist: ${f.section})`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 2;
  }
}
