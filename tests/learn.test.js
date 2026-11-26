// tests/learn.test.js — the self-learning loop.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, readRows, readLessons, findLessons, analyze, decide, score, report, taskFirstPass } from '../scripts/learn.js';
import { readMistakes } from '../scripts/mistakes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signal-learn-'));
const cli = (dir, ...a) => { const out = []; const code = main([...a, '--dir', dir], (s) => out.push(s)); return { code, text: out.join('\n') }; };

// Record `n` tasks in a run.
function task(dir, o = {}) {
  const a = ['task', '--task', o.task || 'T1', '--repo', 'r', '--files', String(o.files ?? 4), '--criteria', String(o.criteria ?? 3),
    '--model', o.model || 'fast', '--build-rounds', String(o.rounds ?? 1), '--qa', o.qa || 'first', '--kind', o.kind || 'backend'];
  if (o.tags) a.push('--tags', o.tags);
  if (o.risky) a.push('--risky', '1');
  assert.equal(cli(dir, ...a).code, 0);
}
const pr = (dir, o) => assert.equal(cli(dir, 'pr', '--strategy', o.strategy, '--files', String(o.files ?? 8), '--ci', o.ci || 'first', '--fix-rounds', String(o.fix ?? 0)).code, 0);
const run = (dir, fn) => { cli(dir, 'start'); fn(); return cli(dir, 'finish'); };

test('record: a task and a PR need an open run; first pass is computed', () => {
  const dir = tmp();
  assert.match(cli(dir, 'task', '--task', 'T1').text, /No open run/);
  cli(dir, 'start'); task(dir); task(dir, { rounds: 2 });
  const t = readRows(dir).filter(r => r.type === 'task');
  assert.equal(taskFirstPass(t[0]), true);
  assert.equal(taskFirstPass(t[1]), false);
});

test('analyze: nothing is proposed before there is enough data', () => {
  const dir = tmp();
  run(dir, () => { task(dir); task(dir); });
  assert.deepEqual(analyze(dir), []);
});

test('analyze: small tasks beat large ones, so it proposes a better way for the Director', () => {
  const dir = tmp();
  for (let r = 0; r < 5; r++) run(dir, () => {
    task(dir, { files: 4 }); task(dir, { files: 4 });
    task(dir, { files: 16, rounds: 2 }); task(dir, { files: 16, rounds: 2 });
  });
  const l = readLessons(dir).lessons.find(x => x.key.startsWith('task-size'));
  assert.ok(l, 'a task-size lesson exists');
  assert.equal(l.kind, 'better-way');
  assert.equal(l.forWho, 'director');
  assert.match(l.text, /1-5 files/);
  assert.equal(l.status, 'proposed');
});

test('finish: analysis runs after every 5th run, not before', () => {
  const dir = tmp();
  for (let r = 0; r < 4; r++) assert.match(run(dir, () => task(dir)).text, /Next analysis after run 5/);
  assert.match(run(dir, () => task(dir)).text, /Analysis ran|proposed/);
});

test('analyze: the split strategy that passes CI more often wins', () => {
  const dir = tmp();
  for (let r = 0; r < 3; r++) run(dir, () => {
    pr(dir, { strategy: 'slice' }); pr(dir, { strategy: 'seam', ci: 'fixed', fix: 1 });
  });
  const ls = findLessons(readRows(dir));
  const l = ls.find(x => x.key.startsWith('split-strategy'));
  assert.ok(l);
  assert.match(l.text, /"slice"/);
});

test('analyze: a choice that works well is kept as "went right"', () => {
  const dir = tmp();
  for (let r = 0; r < 4; r++) run(dir, () => { task(dir, { files: 8 }); task(dir, { files: 8 }); });
  const l = findLessons(readRows(dir)).find(x => x.key.startsWith('task-size'));
  assert.equal(l.kind, 'went-right');
});

test('analyze: a finding that keeps coming back becomes a builder lesson', () => {
  const dir = tmp();
  for (let r = 0; r < 2; r++) run(dir, () => { task(dir, { tags: 'missing-transaction' }); task(dir, { tags: 'missing-transaction' }); });
  const l = findLessons(readRows(dir)).find(x => x.key === 'finding:missing-transaction');
  assert.ok(l);
  assert.equal(l.forWho, 'builder');
});

test('analyze: does not repeat a lesson it already proposed', () => {
  const dir = tmp();
  for (let r = 0; r < 5; r++) run(dir, () => { task(dir, { files: 4 }); task(dir, { files: 4 }); task(dir, { files: 16, rounds: 2 }); task(dir, { files: 16, rounds: 2 }); });
  const before = readLessons(dir).lessons.length;
  analyze(dir);
  assert.equal(readLessons(dir).lessons.length, before);
});

test('approve: a builder lesson becomes a rule the briefing hands out; a director lesson is read by brief', () => {
  const dir = tmp();
  const mf = path.join(dir, 'mistakes.md');
  for (let r = 0; r < 5; r++) run(dir, () => {
    task(dir, { files: 4, tags: 'missing-transaction' }); task(dir, { files: 4 });
    task(dir, { files: 16, rounds: 2 }); task(dir, { files: 16, rounds: 2 });
  });
  const ls = readLessons(dir).lessons;
  const b = ls.find(l => l.forWho === 'builder'), d = ls.find(l => l.forWho === 'director');
  decide(dir, b.id, 'approve', { mistakesFile: mf });
  decide(dir, d.id, 'approve', { mistakesFile: mf });
  const rules = readMistakes(mf);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].agent, 'builder');
  assert.equal(rules[0].source, 'learned');
  assert.match(cli(dir, 'brief').text, /Lessons learned from past runs/);
});

test('reject and retire: only legal from the right state', () => {
  const dir = tmp();
  for (let r = 0; r < 5; r++) run(dir, () => { task(dir, { files: 4 }); task(dir, { files: 4 }); task(dir, { files: 16, rounds: 2 }); task(dir, { files: 16, rounds: 2 }); });
  const id = readLessons(dir).lessons[0].id;
  assert.equal(decide(dir, id, 'reject').status, 'rejected');
  assert.throws(() => decide(dir, id, 'approve'), /not proposed/);
});

test('score: after 5 more runs a lesson is marked helped, no-effect or worse', () => {
  const dir = tmp();
  for (let r = 0; r < 5; r++) run(dir, () => { task(dir, { files: 4 }); task(dir, { files: 4 }); task(dir, { files: 16, rounds: 2 }); task(dir, { files: 16, rounds: 2 }); });
  const l = readLessons(dir).lessons.find(x => x.key.startsWith('task-size'));
  decide(dir, l.id, 'approve', { mistakesFile: path.join(dir, 'm.md') });
  assert.deepEqual(score(dir), [], 'too early');
  for (let r = 0; r < 5; r++) run(dir, () => { task(dir, { files: 4 }); task(dir, { files: 4 }); });
  assert.equal(readLessons(dir).lessons.find(x => x.id === l.id).status, 'helped');
});

test('report: plain-English efficiency lines', () => {
  const dir = tmp();
  run(dir, () => { task(dir); task(dir, { rounds: 2 }); pr(dir, { strategy: 'slice' }); });
  const text = report(dir).join('\n');
  assert.match(text, /First pass: 50%/);
  assert.match(text, /Rework: 50%/);
  assert.match(text, /Split by slice/);
  assert.match(text, /does not prove it caused it/);
});
