// tests/eng.test.js — task state machine, next, gate, and the Engineering Director contract.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATUSES, TRANSITIONS, addTask, setStatus, readyTasks, gateProblems } from '../scripts/eng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/eng.js');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/registry.json'), 'utf8')).skills;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-eng-')), 'eng', 'tasks.json');
const cli = (file, ...args) => spawnSync('node', [CLI, ...args, '--path', file], { encoding: 'utf8' });

const walk = (data, id, to) => { for (const s of to) setStatus(data, id, s); };
const HAPPY = ['building', 'built', 'reviewing', 'reviewed', 'qa', 'done'];

test('every status has a transition entry and the happy path is legal', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATUSES].sort());
  const d = addTask({ tasks: [] }, { id: 'T1', title: 't', files: [], criteria: [], deps: [] });
  walk(d, 'T1', HAPPY);
  assert.equal(d.tasks[0].status, 'done');
});

test('fix loop: changes-requested and qa-failed go back to building', () => {
  const d = addTask({ tasks: [] }, { id: 'T1', title: 't', files: [], criteria: [], deps: [] });
  walk(d, 'T1', ['building', 'built', 'reviewing', 'changes-requested', 'building', 'built', 'reviewing', 'reviewed', 'qa', 'qa-failed', 'building']);
  assert.equal(d.tasks[0].status, 'building');
});

test('illegal transitions throw', () => {
  const d = addTask({ tasks: [] }, { id: 'T1', title: 't', files: [], criteria: [], deps: [] });
  assert.throws(() => setStatus(d, 'T1', 'done'), /illegal transition planned -> done/);
  assert.throws(() => setStatus(d, 'T1', 'qa'), /illegal/);
  walk(d, 'T1', ['building', 'built']);
  assert.throws(() => setStatus(d, 'T1', 'reviewed'), /illegal/);
  assert.throws(() => setStatus(d, 'T1', 'nonsense'), /unknown status/);
  assert.throws(() => setStatus(d, 'T9', 'building'), /no task/);
  walk(d, 'T1', ['reviewing', 'reviewed', 'qa', 'done']);
  assert.throws(() => setStatus(d, 'T1', 'building'), /illegal/);
});

test('add rejects duplicates, missing ids and unknown dependencies', () => {
  const d = addTask({ tasks: [] }, { id: 'T1', title: 't', files: [], criteria: [], deps: [] });
  assert.throws(() => addTask(d, { id: 'T1', title: 't', files: [], criteria: [], deps: [] }), /already exists/);
  assert.throws(() => addTask(d, { id: '', title: 't', files: [], criteria: [], deps: [] }), /id is required/);
  assert.throws(() => addTask(d, { id: 'T2', title: 't', files: [], criteria: [], deps: ['T9'] }), /does not exist/);
});

test('next returns planned tasks whose dependencies are done; building waits for them', () => {
  let d = { tasks: [] };
  d = addTask(d, { id: 'T1', title: 'a', files: [], criteria: [], deps: [] });
  d = addTask(d, { id: 'T2', title: 'b', files: [], criteria: [], deps: ['T1'] });
  d = addTask(d, { id: 'T3', title: 'c', files: [], criteria: [], deps: [] });
  assert.deepEqual(readyTasks(d).map(t => t.id), ['T1', 'T3']);
  assert.throws(() => setStatus(d, 'T2', 'building'), /waits for T1/);
  walk(d, 'T1', HAPPY);
  assert.deepEqual(readyTasks(d).map(t => t.id), ['T2', 'T3']);
  setStatus(d, 'T2', 'building');
  assert.deepEqual(readyTasks(d).map(t => t.id), ['T3']);
});

test('gate passes only when every task is done', () => {
  assert.deepEqual(gateProblems({ tasks: [] }), ['no tasks']);
  let d = addTask({ tasks: [] }, { id: 'T1', title: 'a', files: [], criteria: [], deps: [] });
  d = addTask(d, { id: 'T2', title: 'b', files: [], criteria: [], deps: [] });
  walk(d, 'T1', HAPPY);
  assert.deepEqual(gateProblems(d), ['T2 is planned']);
  walk(d, 'T2', HAPPY);
  assert.deepEqual(gateProblems(d), []);
});

test('CLI: add, list, next, set, gate with exit codes', () => {
  const f = tmp();
  assert.equal(cli(f, 'add', 'T1', '--title', 'first', '--files', 'a.py,b.py', '--criteria', 'AC-1;AC-2').status, 0);
  assert.equal(cli(f, 'add', 'T2', '--title', 'second', '--deps', 'T1').status, 0);
  assert.notEqual(cli(f, 'add', 'T1', '--title', 'dup').status, 0);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(saved.tasks[0].files, ['a.py', 'b.py']);
  assert.deepEqual(saved.tasks[0].criteria, ['AC-1', 'AC-2']);
  assert.match(cli(f, 'list').stdout, /T2\tplanned\tfast\tT1\tsecond/);
  assert.equal(cli(f, 'next').stdout.trim(), 'T1\tfirst');
  assert.notEqual(cli(f, 'set', 'T1', 'done').status, 0);
  assert.notEqual(cli(f, 'gate').status, 0);
  for (const id of ['T1', 'T2']) for (const s of HAPPY) assert.equal(cli(f, 'set', id, s).status, 0, `${id} ${s}`);
  assert.equal(cli(f, 'gate').status, 0);
  assert.ok(!fs.existsSync(path.join(path.dirname(f), '.state.lock')));
});

test('registry and SKILL files for the Engineering Director', () => {
  assert.equal(registry.eng.kind, 'spine');
  for (const n of ['builder', 'task-reviewer', 'qa']) {
    assert.equal(registry[n].kind, 'agent');
    assert.equal(registry[n].tier, n === 'task-reviewer' ? 'deep' : 'fast');
    assert.ok(read(registry[n].path).includes(`## Debrief — ${n}`));
  }
  const eng = read('skills/eng/SKILL.md');
  for (const needle of ['eng-plan', 'eng.js', 'cost.js plan', 'runlog.js', 'backend-check', 'no-claude-scan', 'pending', 'one re-review', 'Local commits only']) {
    assert.ok(eng.includes(needle), `eng must mention "${needle}"`);
  }
  const b = read('skills/agents/builder/SKILL.md');
  for (const needle of ['Never push', 'tests first', 'Co-Authored-By']) assert.ok(b.includes(needle), `builder: ${needle}`);
  const r = read('skills/agents/task-reviewer/SKILL.md');
  for (const needle of ['Read-only', 'Fresh context', 'origin/main...HEAD', 'Blocker', 'file:line', 'scope creep']) assert.ok(r.includes(needle), `task-reviewer: ${needle}`);
  const q = read('skills/agents/qa/SKILL.md');
  for (const needle of ['never edit code', 'FAIL', 'flaky', 'Command']) assert.ok(q.toLowerCase().includes(needle.toLowerCase()), `qa: ${needle}`);
});

test('design-flow syncs main, publishes an artifact and stops for new components', () => {
  const t = read('skills/agents/design-flow/SKILL.md');
  for (const needle of ['Sync main', 'Sync again before handover', 'Claude Artifact', 'pending', 'STOP and ask', 'Differences vs production']) {
    assert.ok(t.includes(needle), `design-flow must mention "${needle}"`);
  }
});

test('--model: defaults to fast, accepts fast or deep, rejects anything else, shows in list', () => {
  const f = tmp();
  assert.equal(cli(f, 'add', 'T1', '--title', 'a').status, 0);
  assert.equal(cli(f, 'add', 'T2', '--title', 'b', '--model', 'deep').status, 0);
  for (const bad of ['tiny', 'opus', 'strong']) {
    assert.notEqual(cli(f, 'add', 'T3', '--title', 'c', '--model', bad).status, 0, bad);
  }
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(saved.tasks.map(t => t.model), ['fast', 'deep']);
  assert.match(cli(f, 'list').stdout, /T2\tplanned\tdeep\t-\tb/);
});
