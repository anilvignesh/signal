// tests/mistakes.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addMistake, readMistakes, rulesFor } from '../scripts/mistakes.js';

const CLI = path.resolve('scripts/mistakes.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mistakes-'));
const run = (args, home) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SIGNAL_HOME: home } });

test('add creates the file with the fixed header and entry format', () => {
  const d = tmp(); const f = path.join(d, 'm.md');
  fs.writeFileSync(path.join(d, 'identity.json'), JSON.stringify({ name: 'Sam', role: 'designer' }));
  const r = run(['add', 'Used a new component', '--rule', 'Reuse the library', '--agent', 'prd', '--path', f], d);
  assert.equal(r.status, 0, r.stderr);
  const t = fs.readFileSync(f, 'utf8');
  assert.match(t, /^# Mistakes\nRules learned from corrections and failures\. The Director passes the newest relevant rules to each agent\.\n/);
  assert.match(t, /\n## \d{4}-\d\d-\d\d · prd · Sam \(designer\) · user\n- \*\*What went wrong:\*\* Used a new component\n- \*\*Rule:\*\* Reuse the library\n/);
});

test('who is unknown without identity.json; default agent is general', () => {
  const d = tmp(); const f = path.join(d, 'm.md');
  run(['add', 'x', '--rule', 'y', '--path', f], d);
  assert.match(fs.readFileSync(f, 'utf8'), /· general · unknown · user/);
});

test('add is append-only', () => {
  const d = tmp(); const f = path.join(d, 'm.md');
  addMistake({ text: 'a', rule: 'ra', file: f });
  const before = fs.readFileSync(f, 'utf8');
  addMistake({ text: 'b', rule: 'rb', file: f });
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(before));
  assert.equal(readMistakes(f).length, 2);
});

test('empty text or rule is rejected with a named reason, exit 1, no file', () => {
  const d = tmp(); const f = path.join(d, 'm.md');
  let r = run(['add', '  ', '--rule', 'y', '--path', f], d);
  assert.equal(r.status, 1); assert.match(r.stderr, /Empty text/);
  r = run(['add', 'x', '--path', f], d);
  assert.equal(r.status, 1); assert.match(r.stderr, /Empty rule/);
  r = run(['add', 'x', '--rule', ' ', '--path', f], d);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(f), false);
});

test('--global writes $SIGNAL_HOME/mistakes.md with the header', () => {
  const d = tmp();
  const r = run(['add', 'x', '--rule', 'y', '--global'], d);
  assert.equal(r.status, 0, r.stderr);
  const t = fs.readFileSync(path.join(d, 'mistakes.md'), 'utf8');
  assert.match(t, /^# Mistakes\n/); assert.match(t, /\*\*Rule:\*\* y/);
});

test('list prints newest first, honours n and --agent', () => {
  const d = tmp(); const f = path.join(d, 'm.md');
  addMistake({ text: 'one', rule: 'r1', agent: 'prd', file: f });
  addMistake({ text: 'two', rule: 'r2', agent: 'research', file: f });
  addMistake({ text: 'three', rule: 'r3', agent: 'prd', file: f });
  let out = run(['list', '2', '--path', f], d).stdout;
  assert.ok(out.indexOf('three') < out.indexOf('two')); assert.ok(!out.includes('one'));
  out = run(['list', '--agent', 'prd', '--path', f], d).stdout;
  assert.ok(out.includes('one') && out.includes('three') && !out.includes('two'));
  assert.match(run(['list', '--path', path.join(d, 'none.md')], d).stdout, /No mistakes/);
});

test('readMistakes round-trips; rulesFor filters by agent or general and caps 5/3', () => {
  const d = tmp(); const p = path.join(d, 'p.md'); const g = path.join(d, 'g.md');
  for (let i = 1; i <= 7; i++) addMistake({ text: `t${i}`, rule: `P${i}`, agent: 'prd', file: p });
  addMistake({ text: 'o', rule: 'OTHER', agent: 'research', file: p });
  addMistake({ text: 'g', rule: 'GEN', agent: 'general', file: p });
  for (let i = 1; i <= 4; i++) addMistake({ text: `t${i}`, rule: `G${i}`, agent: 'general', file: g });
  const r = rulesFor('prd', { project: p, global: g });
  assert.deepEqual(r.project, ['GEN', 'P7', 'P6', 'P5', 'P4']);
  assert.deepEqual(r.global, ['G4', 'G3', 'G2']);
  assert.deepEqual(rulesFor('prd', { project: path.join(d, 'x.md') }), { project: [], global: [] });
});
