// tests/release-gate.test.js — no-claude-scan and backend-check against temporary git repos.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = path.join(ROOT, 'scripts/no-claude-scan.js');
const BACKEND_CHECK = path.join(ROOT, 'scripts/backend-check.js');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const write = (repo, rel, text) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const commit = (repo, msg) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); };

// A repo with one commit on `main` and a feature branch checked out.
function mkRepo(name = 'proj') {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-gate-')), name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'README.md', 'hello\n');
  commit(repo, 'Initial');
  git(repo, 'checkout', '-q', '-b', 'feature/thing');
  return repo;
}
const scan = (repo, ...extra) => spawnSync('node', [SCAN, '--repo', repo, '--base', 'main', ...extra], { encoding: 'utf8', env: GIT_ENV });
const backendCheck = (repo) => spawnSync('node', [BACKEND_CHECK, '--repo', repo, '--base', 'main'], { encoding: 'utf8', env: GIT_ENV });

test('scan: clean branch passes', () => {
  const repo = mkRepo();
  write(repo, 'app.py', 'print("hi")\n');
  commit(repo, 'Add app');
  const r = scan(repo);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ok: no hits/);
});

test('scan: added line with the tool name fails with file:line', () => {
  const repo = mkRepo();
  write(repo, 'app.py', 'a = 1\n# written by Claude\n');
  commit(repo, 'Add app');
  const r = scan(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /app\.py:2 \[name\]/);
});

test('scan: vendor, session link, session id and generated footer are caught', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'Anthropic\nhttps://claude.ai/code/x\nsession_01AbCdEfGh\n🤖 Generated with a tool\n');
  commit(repo, 'Add notes');
  const out = scan(repo).stdout;
  for (const rule of ['vendor', 'session-link', 'session-id', 'generated']) assert.match(out, new RegExp(`\\[${rule}\\]`), rule);
});

test('scan: new file path is checked', () => {
  const repo = mkRepo();
  write(repo, 'docs/claude-notes.md', 'plain text\n');
  commit(repo, 'Add notes');
  const r = scan(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /path:docs\/claude-notes\.md/);
});

test('scan: a commit trailer naming an AI fails and reports the sha', () => {
  const repo = mkRepo();
  write(repo, 'app.py', 'a = 1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Add app', '-m', 'Co-Authored-By: Helper AI <noreply@example.com>');
  const sha = git(repo, 'rev-parse', 'HEAD').trim().slice(0, 10);
  const r = scan(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`commit:${sha} \\[coauthor\\]`));
});

test('scan: a human co-author trailer passes', () => {
  const repo = mkRepo();
  write(repo, 'app.py', 'a = 1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Add app', '-m', 'Co-Authored-By: Priya Rao <priya@example.com>');
  assert.equal(scan(repo).status, 0);
});

test('scan: author string is checked', () => {
  const repo = mkRepo();
  write(repo, 'app.py', 'a = 1\n');
  git(repo, 'add', '-A');
  const r0 = spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'Add app'], { env: { ...GIT_ENV, GIT_AUTHOR_NAME: 'Claude' } });
  assert.equal(r0.status, 0);
  const r = scan(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /author Claude/);
});

test('scan: branch name is checked', () => {
  const repo = mkRepo();
  git(repo, 'checkout', '-q', '-b', 'claude/fix-thing');
  write(repo, 'app.py', 'a = 1\n');
  commit(repo, 'Add app');
  const r = scan(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^branch \[name\]/m);
});

test('scan: PR title and body file are checked', () => {
  const repo = mkRepo();
  write(repo, 'app.py', 'a = 1\n');
  commit(repo, 'Add app');
  const body = path.join(os.tmpdir(), `body-${Date.now()}.md`);
  fs.writeFileSync(body, 'Fine line\nmade with claude.ai/code\n');
  const r = scan(repo, '--pr-title', 'Add app', '--pr-body-file', body);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /pr-body:2/);
  assert.equal(scan(repo, '--pr-title', 'Anthropic fix').status, 1);
});

test('scan: allow-list turns a hit into a note; unmatched hits still fail', () => {
  const repo = mkRepo();
  write(repo, '.signal-scan-allow', '# this repo is about the tool\n^docs/api\\.md:\\d+\\t\n');
  write(repo, 'docs/api.md', 'The Claude API client\n');
  commit(repo, 'Add docs');
  let r = scan(repo);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /note \(allowed\) docs\/api\.md:1/);
  write(repo, 'other.md', 'Claude again\n');
  commit(repo, 'More docs');
  r = scan(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /other\.md:1/);
});

test('scan: missing args exit 2', () => {
  assert.equal(spawnSync('node', [SCAN], { encoding: 'utf8' }).status, 2);
});

test('backend-check: skipped for another repo', () => {
  const repo = mkRepo('some_other_repo');
  write(repo, 'a/serializer/x.py', 'raise serializers.ValidationError("x")\n');
  commit(repo, 'Add');
  const r = backendCheck(repo);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skipped: not acme_backend/);
});

test('backend-check: runs when the folder is acme_backend and flags each mechanical pattern', () => {
  const repo = mkRepo('acme_backend');
  write(repo, 'app/serializer/pay.py', [
    'def validate_x(self, v):',
    '    raise serializers.ValidationError("bad")',
    'def create(self):',
    '    obj.save()',
    '',
  ].join('\n'));
  write(repo, 'app/tasks/mail.py', '@shared_task(ignore_result=True)\ndef go():\n    pass\n');
  write(repo, 'app/api/views.py', [
    'class V:',
    '    def get(self, request):',
    '        if not request.user.has_permission("x"):',
    '            return 1',
    '',
  ].join('\n'));
  write(repo, 'app/svc/notify.py', 'def n():\n    send_mail("s", "b", "f", ["t"])\n');
  write(repo, 'tests/test_pay.py', 'import pytest\n\n@pytest.fixture\ndef thing():\n    return 1\n');
  commit(repo, 'Add feature');
  const r = backendCheck(repo);
  assert.equal(r.status, 1, r.stdout);
  for (const [id, loc] of [
    ['raw-validation-error', 'app/serializer/pay.py:2'],
    ['orm-write-in-serializer-or-utils', 'app/serializer/pay.py:4'],
    ['task-without-acks-late', 'app/tasks/mail.py:1'],
    ['has-permission-without-admin-guard', 'app/api/views.py:3'],
    ['inline-permission-check', 'app/api/views.py:3'],
    ['email-not-via-celery', 'app/svc/notify.py:2'],
    ['inline-fixture', 'tests/test_pay.py:3'],
  ]) assert.match(r.stdout, new RegExp(`${loc.replace(/[./]/g, '\\$&')} \\[${id}\\].*\\(checklist: `), `${id}\n${r.stdout}`);
});

test('backend-check: compliant code passes', () => {
  const repo = mkRepo('acme_backend');
  write(repo, 'app/serializer/pay.py', 'def validate_x(self, v):\n    raise AppValidationError(PAY_BAD)\n');
  write(repo, 'app/tasks/mail.py', '@shared_task(\n    ignore_result=True,\n    acks_late=True,\n)\ndef go():\n    pass\n');
  write(repo, 'app/api/views.py', '@check_permission("x")\ndef get(self, request):\n    return 1\n');
  write(repo, 'app/svc/access.py', [
    'def can_read(request):',
    '    if isinstance(request.user, AdminUser):',
    '        ok = request.user.has_permission("x")',
    '',
  ].join('\n'));
  write(repo, 'tests/conftest.py', 'import pytest\n\n@pytest.fixture\ndef thing():\n    return 1\n');
  commit(repo, 'Add feature');
  const r = backendCheck(repo);
  assert.equal(r.status, 0, r.stdout);
});

test('backend-check: runs when the remote is acme_backend', () => {
  const repo = mkRepo('renamed_clone');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/Acme/acme_backend.git');
  write(repo, 'app/tasks/t.py', '@shared_task\ndef go():\n    pass\n');
  commit(repo, 'Add');
  assert.equal(backendCheck(repo).status, 1);
});

test('pr-size: passes at 20 files, fails at 21', () => {
  const PRSIZE = path.join(ROOT, 'scripts/pr-size.js');
  const repo = mkRepo();
  for (let i = 0; i < 20; i++) write(repo, `f${i}.txt`, 'x\n');
  commit(repo, 'twenty');
  let r = spawnSync('node', [PRSIZE, '--repo', repo, '--base', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
  write(repo, 'f20.txt', 'x\n');
  commit(repo, 'twenty one');
  r = spawnSync('node', [PRSIZE, '--repo', repo, '--base', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /too big: 21 files/);
});
