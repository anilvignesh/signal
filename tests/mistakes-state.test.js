// tests/mistakes-state.test.js — state.js integration: init, auto capture, brief, check.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addMistake, readMistakes } from '../scripts/mistakes.js';

const STATE = path.resolve('scripts/state.js');
const setup = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mstate-'));
  const home = path.join(d, 'home'); fs.mkdirSync(home);
  const sp = path.join(d, '.pm', 'state.md');
  const run = (...a) => spawnSync('node', [STATE, ...a, '--path', sp], { encoding: 'utf8', env: { ...process.env, SIGNAL_HOME: home } });
  return { d, home, sp, mp: path.join(d, '.pm', 'mistakes.md'), run };
};
const BAD = '## Debrief — prd\n**Artifact:** none\n**Learned:**\n- x\n**Suggested next:** go\n';   // no Digest

test('init creates mistakes.md with header and never overwrites it', () => {
  const { sp, mp, run } = setup();
  assert.equal(run('init', 'P').status, 0);
  assert.match(fs.readFileSync(mp, 'utf8'), /^# Mistakes\n/);
  addMistake({ text: 'a', rule: 'b', file: mp });
  const before = fs.readFileSync(mp, 'utf8');
  run('init', 'P', '--force');
  assert.equal(fs.readFileSync(mp, 'utf8'), before);
  assert.ok(fs.existsSync(sp));
});

test('rejected merge records one auto entry, leaves state byte-identical, dedupes same day', () => {
  const { d, sp, mp, run } = setup();
  run('init', 'P');
  const deb = path.join(d, 'deb.md'); fs.writeFileSync(deb, BAD);
  const state = fs.readFileSync(sp);
  let r = run('merge', deb, '--skill', 'prd');
  assert.equal(r.status, 1);
  assert.ok(fs.readFileSync(sp).equals(state));
  let e = readMistakes(mp);
  assert.equal(e.length, 1);
  assert.equal(e[0].agent, 'prd'); assert.equal(e[0].source, 'auto');
  assert.equal(e[0].what, 'Debrief rejected: missing **Digest:**');
  assert.equal(e[0].rule, 'End the debrief with the **Digest:** field on the same line as its label');
  run('merge', deb, '--skill', 'prd');
  assert.equal(readMistakes(mp).length, 1);
  run('merge', deb, '--skill', 'research');
  assert.equal(readMistakes(mp).length, 2);
});

test('brief adds the rules section (project 5 + global 3), omits it when none, keeps it with --full', () => {
  const { home, mp, run } = setup();
  run('init', 'P');
  assert.ok(!run('brief', 'prd', 'version=v0').stdout.includes('Rules from past mistakes'));
  for (let i = 1; i <= 6; i++) addMistake({ text: 't', rule: `P${i}`, agent: 'prd', file: mp });
  addMistake({ text: 't', rule: 'OTHER', agent: 'research', file: mp });
  for (let i = 1; i <= 4; i++) addMistake({ text: 't', rule: `G${i}`, agent: 'general', file: path.join(home, 'mistakes.md') });
  for (const extra of [[], ['--full']]) {
    const out = run('brief', 'prd', 'version=v0', ...extra).stdout;
    assert.match(out, /\*\*Rules from past mistakes:\*\*\n- P6\n- P5\n- P4\n- P3\n- P2\n- G4\n- G3\n- G2\n/);
    assert.ok(!out.includes('OTHER') && !out.includes('- P1\n'));
  }
});

test('check prints the mistakes count', () => {
  const { mp, run } = setup();
  run('init', 'P');
  assert.match(run('check').stdout, /Mistakes: 0 recorded/);
  addMistake({ text: 'a', rule: 'b', file: mp });
  assert.match(run('check').stdout, /Mistakes: 1 recorded/);
});

