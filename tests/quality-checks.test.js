// tests/quality-checks.test.js — check-tests.js and plain-english.js.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { testCheck } from '../scripts/check-tests.js';
import { check, main } from '../scripts/plain-english.js';
import { prSize } from '../scripts/pr-size.js';

const gitWith = (names) => () => names.join('\n') + '\n';

test('check-tests: source plus a test file passes; source alone fails; non-code passes', () => {
  assert.equal(testCheck(gitWith(['app/a.py', 'tests/test_a.py']), 'main').ok, true);
  assert.equal(testCheck(gitWith(['src/a.ts', 'src/a.test.ts']), 'main').ok, true);
  assert.equal(testCheck(gitWith(['app/a.py']), 'main').ok, false);
  assert.equal(testCheck(gitWith(['README.md', 'config/x.json']), 'main').ok, true);
});

test('check-tests: migrations and lockfiles are not source needing tests', () => {
  assert.equal(testCheck(gitWith(['app/migrations/0001_x.py', 'package-lock.json']), 'main').ok, true);
});

test('pr-size: counts lines, skips generated files', () => {
  const git = () => '300\t100\tapp/a.py\n50000\t0\tyarn.lock\n';
  const r = prSize(git, 'main', 20, 600);
  assert.equal(r.lines, 400);
  assert.equal(r.ok, true);
  assert.equal(prSize(git, 'main', 20, 300).ok, false);
});

test('plain-english: flags long sentences and fancy words, ignores code', () => {
  const long = 'We should make sure that the team is able to look at every single one of the many different items in the list before we decide what to do next.';
  assert.equal(check(long).some(f => f.kind === 'long sentence'), true);
  assert.equal(check('We utilize the tool.')[0].note, 'say "use"');
  assert.deepEqual(check('Run it.\n```\nutilize leverage ' + 'x '.repeat(40) + '\n```\nDone.'), []);
});

test('plain-english: main exits 0 clean, 1 with findings', () => {
  const lines = [];
  assert.equal(main([], (s) => lines.push(s), () => 'Short and clear.'), 0);
  assert.equal(main([], (s) => lines.push(s), () => 'Leverage it.'), 1);
});

// ---- blast-radius and conventions, against real temporary git repos ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main as blastMain, optionalParamOnly } from '../scripts/blast-radius.js';
import { main as convMain, checkAdded } from '../scripts/conventions.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'd@x.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'd@x.com' };
const sh = (repo, ...a) => { const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); };
const put = (repo, rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const save = (repo, msg) => { sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', msg); };

function orderRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-blast-'));
  sh(repo, 'init', '-q', '-b', 'main');
  put(repo, 'orders.py', 'def create_order(amount):\n    total = amount\n    return total\n');
  for (let i = 0; i < 6; i++) put(repo, `caller${i}.py`, `from orders import create_order\n\ndef run${i}():\n    return create_order(${i})\n`);
  save(repo, 'init');
  sh(repo, 'checkout', '-q', '-b', 'feat');
  return repo;
}
const run = (fn, args) => { const out = []; const code = fn(args, (s) => out.push(s)); return { code, text: out.join('\n') }; };

test('blast-radius: rewriting a widely used function stops the release; a reason clears it', () => {
  const repo = orderRepo();
  put(repo, 'orders.py', 'def create_order(amount):\n    validate_pan(amount)\n    total = amount * 2\n    return total\n');
  save(repo, 'heavy');
  const r = run(blastMain, ['--repo', repo, '--base', 'main']);
  assert.equal(r.code, 1);
  assert.match(r.text, /create_order in orders\.py is used in 6 files/);
  assert.equal(run(blastMain, ['--repo', repo, '--base', 'main', '--justified', 'the total rule changed']).code, 0);
});

test('blast-radius: an optional new input is allowed (the light PAN way)', () => {
  const repo = orderRepo();
  put(repo, 'orders.py', 'def create_order(amount, pan_ref=None):\n    total = amount\n    return total\n');
  save(repo, 'light');
  const r = run(blastMain, ['--repo', repo, '--base', 'main']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /note: create_order/);
});

test('blast-radius: a new separate function is fine', () => {
  const repo = orderRepo();
  put(repo, 'pan.py', 'def verify_pan(pan):\n    return pan\n');
  put(repo, 'orders.py', 'def create_order(amount):\n    total = amount\n    return total\n\n\ndef verify_pan_ref(ref):\n    return ref\n');
  save(repo, 'separate');
  assert.equal(run(blastMain, ['--repo', repo, '--base', 'main']).code, 0);
});

test('optionalParamOnly: only an added defaulted input counts', () => {
  assert.equal(optionalParamOnly('def f(a):', 'def f(a, ref=None):'), true);
  assert.equal(optionalParamOnly('def f(a):', 'def f(a, ref):'), false);
  assert.equal(optionalParamOnly('def f(a):', 'def f(b):'), false);
});

test('conventions: init writes the files once, brief prints them, check runs rules.json', () => {
  const repo = orderRepo();
  assert.equal(run(convMain, ['init', '--repo', repo]).code, 0);
  assert.ok(fs.existsSync(path.join(repo, '.signal/conventions.md')));
  put(repo, '.signal/conventions.md', '# mine\n');
  run(convMain, ['init', '--repo', repo]);
  assert.equal(fs.readFileSync(path.join(repo, '.signal/conventions.md'), 'utf8'), '# mine\n', 'never overwritten');
  assert.match(run(convMain, ['brief', '--repo', repo]).text, /# mine/);
  put(repo, '.signal/rules.json', JSON.stringify([{ id: 'no-print', section: 'Logging', files: '\\.py$', line: '^\\s*print\\(', msg: 'use the logger, not print' }]));
  save(repo, 'rules');
  sh(repo, 'checkout', '-q', '-b', 'f2');
  put(repo, 'x.py', 'print("hi")\n');
  save(repo, 'adds print');
  const r = run(convMain, ['check', '--repo', repo, '--base', 'feat']);
  assert.equal(r.code, 1);
  assert.match(r.text, /x\.py:1 \[Logging\] use the logger/);
});

test('conventions: a repo with no .signal folder is skipped, not failed', () => {
  const repo = orderRepo();
  const r = run(convMain, ['check', '--repo', repo, '--base', 'main']);
  assert.equal(r.code, 0);
  assert.match(r.text, /conventions\.js init/);
});

test('conventions: checkAdded honours skip and unless', () => {
  const rules = [{ id: 'a', files: /\.py$/, skip: /test_/, line: /print\(/, unless: /# ok/, msg: 'm' }];
  const added = [{ file: 'a.py', line: 1, text: 'print(1)' }, { file: 'a.py', line: 2, text: 'print(2) # ok' }, { file: 'test_a.py', line: 1, text: 'print(3)' }];
  assert.equal(checkAdded(added, rules).length, 1);
});
