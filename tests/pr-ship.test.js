// tests/pr-ship.test.js — PR stage with stubbed git and gh. Offline.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, EXIT } from '../scripts/pr-ship.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/pr-routing.json'), 'utf8'));
const mkdir = (name) => { const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-pr-')), name); fs.mkdirSync(d); return d; };

// A runner stub. `rules` maps a command prefix ("merge --no-edit") to a string, or to an Error to throw.
function stub(rules = {}) {
  const calls = [];
  const fn = (args) => {
    const line = args.join(' ');
    calls.push(line);
    for (const [prefix, val] of Object.entries(rules)) {
      if (line.startsWith(prefix)) { if (val instanceof Error) throw val; return val; }
    }
    return '';
  };
  fn.calls = calls;
  fn.has = (prefix) => calls.some(c => c.startsWith(prefix));
  return fn;
}
const GIT = { 'remote get-url': '', 'rev-parse --abbrev-ref': 'feat/x\n', 'log --reverse --format=%s': 'Add thing\nMore\n' };
const CONFIRMED = { SIGNAL_PR_CONFIRMED: '1' };

async function ship(cmd, { repoName = 'acme_backend', git = {}, gh = {}, env = CONFIRMED, extra = [], sleep } = {}) {
  const repo = mkdir(repoName);
  const g = stub({ ...GIT, ...git });
  const h = stub(gh);
  const lines = [];
  const code = await run([cmd, '--repo', repo, ...extra], { git: g, gh: h, env, out: (s) => lines.push(s), sleep: sleep || (async () => {}) });
  return { code, g, h, text: lines.join('\n') };
}
const behind = { 'merge-base --is-ancestor': new Error('not ancestor') };
const PASS = JSON.stringify([{ name: 'ci', bucket: 'pass' }, { name: 'lint', bucket: 'pass' }]);

test('config: backend routes to three reviewers, frontends to two, every login set', () => {
  const r = CONFIG.repos;
  assert.deepEqual(r.acme_backend.reviewers.map(x => x.name), ['Alex', 'Sam', 'Jordan']);
  assert.equal(r.acme_backend.reviewers[1].login, 'sam-dev');
  assert.deepEqual(r.acme_web.reviewers.map(x => x.name), ['Riya', 'Sid']);
  assert.deepEqual(r.acme_admin.reviewers, r.acme_web.reviewers);
  for (const repo of Object.values(r)) for (const p of repo.reviewers) assert.ok(p.login === null || typeof p.login === 'string');
});

test('plan: prints branch, base, title, label, reviewers and needs no confirmation or write', async () => {
  const { code, text, g, h } = await ship('plan', { env: {} });
  assert.equal(code, 0);
  for (const s of ['feat/x', 'main', 'Add thing', 'ready for merge', 'alex-dev', 'sam-dev', 'jordan-dev']) assert.ok(text.includes(s), s);
  assert.equal(h.calls.length, 0);
  assert.ok(!g.has('push') && !g.has('merge'));
});

test('plan: a repo with no label says so', async () => {
  const { text } = await ship('plan', { repoName: 'acme_admin', env: {} });
  assert.match(text, /no ready-to-merge label/);
});

test('plan: unknown repo is refused', async () => {
  const { code, text } = await ship('plan', { repoName: 'other_repo', env: {} });
  assert.equal(code, 1);
  assert.match(text, /no routing/);
});

test('every remote subcommand refuses without SIGNAL_PR_CONFIRMED=1 and does nothing', async () => {
  for (const cmd of ['sync', 'open', 'label', 'checks', 'reviewers', 'notify']) {
    const { code, text, g, h } = await ship(cmd, { env: {} });
    assert.equal(code, 1, cmd);
    assert.match(text, /SIGNAL_PR_CONFIRMED/);
    assert.ok(!g.has('push') && !g.has('fetch') && !g.has('merge'), cmd);
    assert.equal(h.calls.length, 0, cmd);
  }
});

test('sync: up to date merges nothing', async () => {
  const { code, g } = await ship('sync');
  assert.equal(code, 0);
  assert.ok(!g.has('merge --no-edit'));
});

test('sync: behind merges origin/main', async () => {
  const { code, g } = await ship('sync', { git: behind });
  assert.equal(code, 0);
  assert.ok(g.has('merge --no-edit origin/main'));
});

test('sync: conflict aborts the merge and reports files', async () => {
  const { code, g, text } = await ship('sync', { git: { ...behind, 'merge --no-edit': new Error('conflict'), 'diff --name-only --diff-filter=U': 'a.py\nb.py\n' } });
  assert.equal(code, 1);
  assert.ok(g.has('merge --abort'));
  assert.match(text, /conflict: a\.py/);
  assert.match(text, /conflict: b\.py/);
});

test('sync: dirty tree is refused', async () => {
  const { code, g } = await ship('sync', { git: { status: ' M a.py\n' } });
  assert.equal(code, 1);
  assert.ok(!g.has('merge'));
});

test('open: a scan hit in the title refuses before any push', async () => {
  const { code, g, h, text } = await ship('open', { extra: ['--title', 'Fix by Claude'] });
  assert.equal(code, 1);
  assert.match(text, /pr-title/);
  assert.ok(!g.has('push'));
  assert.equal(h.calls.length, 0);
});

test('open: a scan hit in a commit message refuses', async () => {
  const log = '\x1fDev <d@e.com>\x1fDev <d@e.com>\x1fAdd thing\n\nCo-Authored-By: Helper AI <x@y.z>\n\x1e';
  const { code, g } = await ship('open', { git: { 'log --format=%H': 'abc1234567' + log } });
  assert.equal(code, 1);
  assert.ok(!g.has('push'));
});

test('open: clean PR is pushed and created with no reviewers', async () => {
  const { code, g, h } = await ship('open', { gh: { 'pr create': 'https://github.com/Acme/x/pull/1\n' } });
  assert.equal(code, 0);
  assert.ok(g.has('push -u origin feat/x'));
  const create = h.calls.find(c => c.startsWith('pr create'));
  assert.ok(create.includes('--title Add thing'));
  assert.ok(!/reviewer/.test(create));
});

test('label: behind main is refused', async () => {
  const { code, h } = await ship('label', { git: behind });
  assert.equal(code, 1);
  assert.ok(!h.has('pr edit'));
});

test('label: a repo with no label configured is refused', async () => {
  const { code, text } = await ship('label', { repoName: 'acme_admin' });
  assert.equal(code, 1);
  assert.match(text, /no ready-to-merge label/);
});

test('label: a label missing in the repo is never created', async () => {
  const { code, h } = await ship('label', { gh: { 'label list': '[{"name":"bug"}]' } });
  assert.equal(code, 1);
  assert.ok(!h.has('pr edit') && !h.has('label create'));
});

test('label: current branch gets the exact label', async () => {
  const { code, h } = await ship('label', { repoName: 'acme_web', gh: { 'label list': '[{"name":"ready-to-merge"}]' } });
  assert.equal(code, 0);
  assert.ok(h.has('pr edit feat/x --add-label ready-to-merge'));
});

test('checks: exit 0 pass, 1 fail, 2 pending', async () => {
  assert.equal((await ship('checks', { gh: { 'pr checks': PASS } })).code, 0);
  assert.equal((await ship('checks', { gh: { 'pr checks': JSON.stringify([{ name: 'ci', bucket: 'fail' }]) } })).code, 1);
  assert.equal((await ship('checks', { gh: { 'pr checks': JSON.stringify([{ name: 'ci', bucket: 'pending' }]) } })).code, 2);
  assert.equal((await ship('checks', { gh: { 'pr checks': '[]' } })).code, 2);
});

test('checks: --wait polls until the checks settle', async () => {
  const repo = mkdir('acme_web');
  let n = 0;
  const gh = () => (++n < 3 ? JSON.stringify([{ name: 'ci', bucket: 'pending' }]) : PASS);
  let slept = 0;
  const code = await run(['checks', '--repo', repo, '--wait', '300', '--interval', '10'], { git: stub(GIT), gh, env: CONFIRMED, out: () => {}, sleep: async () => { slept++; } });
  assert.equal(code, 0);
  assert.equal(slept, 2);
});

test('reviewers: refused while checks are pending or failing', async () => {
  const { code, h, text } = await ship('reviewers', { gh: { 'pr checks': JSON.stringify([{ name: 'ci', bucket: 'pending' }]) } });
  assert.equal(code, 1);
  assert.match(text, /checks are pending/);
  assert.ok(!h.has('pr edit'));
});

test('reviewers: refused when the branch is behind main', async () => {
  const { code, h } = await ship('reviewers', { git: behind, gh: { 'pr checks': PASS } });
  assert.equal(code, 1);
  assert.ok(!h.has('pr edit'));
});

test('reviewers: green and current requests all three backend reviewers', async () => {
  const { code, h } = await ship('reviewers', { gh: { 'pr checks': PASS } });
  assert.equal(code, 0);
  assert.ok(h.has('pr edit feat/x --add-reviewer alex-dev,sam-dev,jordan-dev'));
});

function cfgWith(mutate) {
  const cfg = path.join(mkdir('cfg'), 'routing.json');
  const c = JSON.parse(JSON.stringify(CONFIG));
  mutate(c.repos.acme_backend.reviewers);
  fs.writeFileSync(cfg, JSON.stringify(c));
  return cfg;
}

test('reviewers: a null login with no chat id refuses instead of guessing', async () => {
  const cfg = cfgWith(r => { r[0].login = null; delete r[0].chat; });
  const { code, text, h } = await ship('reviewers', { extra: ['--config', cfg], gh: { 'pr checks': PASS } });
  assert.equal(code, 1);
  assert.match(text, /no GitHub login and no chat id for Alex/);
  assert.ok(!h.has('pr edit'));
});

test('reviewers: a null login with a chat id requests the others on GitHub and flags chat', async () => {
  const cfg = cfgWith(r => { r[0].login = null; });
  const { code, text, h } = await ship('reviewers', { extra: ['--config', cfg], gh: { 'pr checks': PASS } });
  assert.equal(code, 0);
  assert.ok(h.has('pr edit feat/x --add-reviewer sam-dev,jordan-dev'));
  assert.match(text, /chat-needed: Alex \(U0AAAAAAAA1\)/);
});

test('notify: prints a draft for the reviewer with no login and sends nothing', async () => {
  const cfg = cfgWith(r => { r[0].login = null; });
  const gh = { 'pr view feat/x --json url': 'https://example.test/pr/1\n', 'pr view feat/x --json title': 'Add thing\n' };
  const { code, text, h } = await ship('notify', { extra: ['--config', cfg], gh });
  assert.equal(code, 0);
  assert.match(text, /to: Alex \(U0AAAAAAAA1\)/);
  assert.ok(text.includes('https://example.test/pr/1'));
  assert.ok(!text.includes('Sam'));
  assert.ok(!h.has('pr edit'));
});

test('notify: with every login set there is nothing to send', async () => {
  const { code, text } = await ship('notify');
  assert.equal(code, 0);
  assert.match(text, /no reviewer needs a chat message/);
});

test('config: every reviewer has a chat id', () => {
  for (const repo of Object.values(CONFIG.repos)) for (const p of repo.reviewers) assert.match(p.chat || '', /^U[0-9A-Z]+$/, p.name);
});

test('usage: unknown subcommand exits 64', async () => {
  assert.equal(await run(['nope'], { out: () => {} }), EXIT.USAGE);
});

const DIFF_OK = { 'diff --numstat': '5\t1\tapp/a.py\n10\t0\ttests/test_a.py\n', 'diff --name-only': 'app/a.py\ntests/test_a.py\n' };

test('open: a PR over the line limit refuses before any push', async () => {
  const { code, g, text } = await ship('open', { git: { 'diff --numstat': '500\t200\tapp/a.py\n', 'diff --name-only': 'app/a.py\n' } });
  assert.equal(code, EXIT.FAIL);
  assert.match(text, /700 lines changed/);
  assert.ok(!g.has('push'));
});

test('open: lockfiles count toward neither limit', async () => {
  const { code } = await ship('open', { git: { ...DIFF_OK, 'diff --numstat': '5\t1\tapp/a.py\n9000\t9000\tpackage-lock.json\n10\t0\ttests/test_a.py\n' }, gh: { 'pr create': 'https://github.com/Acme/x/pull/1\n' } });
  assert.equal(code, EXIT.OK);
});

test('open: source with no test file refuses', async () => {
  const { code, g, text } = await ship('open', { git: { 'diff --numstat': '5\t1\tapp/a.py\n', 'diff --name-only': 'app/a.py\n' } });
  assert.equal(code, EXIT.FAIL);
  assert.match(text, /no test file/);
  assert.ok(!g.has('push'));
});

test('open: docs-only change needs no test file', async () => {
  const { code } = await ship('open', { git: { 'diff --numstat': '5\t1\tREADME.md\n', 'diff --name-only': 'README.md\n' }, gh: { 'pr create': 'https://github.com/Acme/x/pull/1\n' } });
  assert.equal(code, EXIT.OK);
});

test('open: a stacked part names its order in the body; a later part needs --after', async () => {
  const ok = await ship('open', { git: DIFF_OK, extra: ['--part', '2/3', '--after', 'https://github.com/Acme/x/pull/1'], gh: { 'pr create': 'https://github.com/Acme/x/pull/2\n' } });
  assert.equal(ok.code, EXIT.OK);
  const create = ok.h.calls.find(c => c.startsWith('pr create'));
  assert.match(create, /Part 2\/3\. Merge after https:\/\/github.com\/Acme\/x\/pull\/1\./);
  const bad = await ship('open', { git: DIFF_OK, extra: ['--part', '2/3'] });
  assert.equal(bad.code, EXIT.FAIL);
  assert.match(bad.text, /needs --after/);
});
