// tests/intake.test.js
// Intake: style.json and refs.json via state.js, and the Assumptions debrief field.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseDebrief, validateDebrief, mergeDebrief, parseState,
  validateProjectFile, mergeProjectFile,
} from '../scripts/state.js';

const STATE_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/state.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-intake-'));
  const sp = path.join(dir, '.pm', 'state.md');
  const run = (...args) => spawnSync('node', [STATE_JS, ...args, '--path', sp], { encoding: 'utf8' });
  assert.equal(run('init', 'P').status, 0);
  return { dir, sp, run, pm: path.dirname(sp) };
}

const DEBRIEF = (assumptions) => `## Debrief — x
**Artifact:** none
**Digest:** d
**Learned:**
- a fact [source: x]
**Terms:**
none
${assumptions}**Open questions for user:**
none
**Suggested next:** go
`;

// ---- validation and merge (pure) ----

test('style: valid shape passes, unknown key and bad regex are refused', () => {
  assert.deepEqual(validateProjectFile('style', { banned_words: ['x'], table_columns: { Name: 3 } }), []);
  assert.match(validateProjectFile('style', { colour: 'red' })[0], /unknown key "colour"/);
  assert.match(validateProjectFile('style', { banned_patterns: ['('] })[0], /banned_patterns/);
  assert.match(validateProjectFile('style', { table_columns: { A: 0 } })[0], /table_columns/);
});

test('refs: valid shape passes, wrong types are refused', () => {
  assert.deepEqual(validateProjectFile('refs', { deployed_ref: 'origin/production', pinned_commit: 'abc', repos: [{ name: 'b', path: '/x' }] }), []);
  assert.ok(validateProjectFile('refs', { repos: [{ name: 'b' }] }).length);
  assert.ok(validateProjectFile('refs', { deployed_ref: 5 }).length);
  assert.ok(validateProjectFile('refs', []).length);
});

test('mergeProjectFile: scalars replace, lists add without duplicates, repos merge by name', () => {
  const base = { deployed_ref: 'a', other_refs: ['x'], repos: [{ name: 'b', path: '/1' }] };
  const out = mergeProjectFile('refs', base, { deployed_ref: 'c', other_refs: ['x', 'y'], repos: [{ name: 'b', path: '/2' }, { name: 'f', path: '/3' }] });
  assert.equal(out.deployed_ref, 'c');
  assert.deepEqual(out.other_refs, ['x', 'y']);
  assert.deepEqual(out.repos, [{ name: 'b', path: '/2' }, { name: 'f', path: '/3' }]);
  assert.deepEqual(mergeProjectFile('style', { table_columns: { A: 1 } }, { table_columns: { B: 2 } }).table_columns, { A: 1, B: 2 });
});

// ---- CLI ----

test('style init then merge writes .pm/style.json; second init is refused', () => {
  const { pm, run } = setup();
  assert.equal(run('style', 'init').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pm, 'style.json'), 'utf8')), {});
  assert.notEqual(run('style', 'init').status, 0);
  const r = run('style', 'merge', '{"banned_words":["foo"],"status_words":["Live"]}');
  assert.equal(r.status, 0, r.stderr);
  run('style', 'merge', '{"banned_words":["bar","foo"]}');
  const s = JSON.parse(fs.readFileSync(path.join(pm, 'style.json'), 'utf8'));
  assert.deepEqual(s.banned_words, ['foo', 'bar']);
  assert.deepEqual(s.status_words, ['Live']);
});

test('refs merge refuses unknown keys and bad JSON, and leaves the file unchanged', () => {
  const { pm, run } = setup();
  run('refs', 'init');
  run('refs', 'merge', '{"deployed_ref":"origin/production","pinned_commit":"abc1234"}');
  const before = fs.readFileSync(path.join(pm, 'refs.json'), 'utf8');
  const bad = run('refs', 'merge', '{"nope":1}');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown key "nope"/);
  assert.notEqual(run('refs', 'merge', 'not json').status, 0);
  assert.equal(fs.readFileSync(path.join(pm, 'refs.json'), 'utf8'), before);
});

test('merge works without init, accepts --file, and show prints the file', () => {
  const { dir, pm, run } = setup();
  const patch = path.join(dir, 'patch.json');
  fs.writeFileSync(patch, '{"search_areas":["payments"]}');
  assert.equal(run('refs', 'merge', '--file', patch).status, 0);
  assert.deepEqual(JSON.parse(run('refs', 'show').stdout).search_areas, ['payments']);
  assert.notEqual(run('style', 'show').status, 0);
  assert.ok(fs.existsSync(path.join(pm, 'refs.json')));
});

// ---- Assumptions ----

test('parseDebrief reads the Assumptions field; "none" is empty; absent is flagged', () => {
  const two = parseDebrief(DEBRIEF('**Assumptions (proposals):**\n- one row per merchant\n- INR only\n'));
  assert.equal(two.hasAssumptions, true);
  assert.deepEqual(two.assumptions, ['one row per merchant', 'INR only']);
  const none = parseDebrief(DEBRIEF('**Assumptions (proposals):** none\n'));
  assert.equal(none.hasAssumptions, true);
  assert.deepEqual(none.assumptions, []);
  const absent = parseDebrief(DEBRIEF(''));
  assert.equal(absent.hasAssumptions, false);
  assert.deepEqual(absent.assumptions, []);
  assert.equal(validateDebrief(DEBRIEF('')).ok, true);
});

test('Assumptions field does not swallow or lose the neighbouring fields', () => {
  const d = parseDebrief(DEBRIEF('**Assumptions (proposals):**\n- a\n'));
  assert.deepEqual(d.openQuestions, []);
  assert.equal(d.next, 'go');
});

test('mergeDebrief turns each assumption into an open question tagged assumed-by', () => {
  const state = parseState('# Signal State — P\n\n## Open Questions\n- existing [asked-by: y]\n');
  const d = parseDebrief(DEBRIEF('**Assumptions (proposals):**\n- one row per merchant\n'));
  const next = mergeDebrief(state, d, { date: '2026-10-05', skill: 'prd' });
  assert.ok(next.openQuestions.includes('Assumed: one row per merchant [assumed-by: prd]'));
  assert.equal(next.decisions.length, 0);
  const again = mergeDebrief(next, d, { skill: 'prd' });
  assert.equal(again.openQuestions.length, next.openQuestions.length);
});

test('merge CLI: assumptions land in state; missing field warns and still merges', () => {
  const { dir, sp, run } = setup();
  const f = path.join(dir, 'd.md');
  fs.writeFileSync(f, DEBRIEF('**Assumptions (proposals):**\n- INR only\n'));
  const ok = run('merge', f, '--skill', 'prd');
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout, /no Assumptions field/);
  assert.match(fs.readFileSync(sp, 'utf8'), /Assumed: INR only \[assumed-by: prd\]/);
  fs.writeFileSync(f, DEBRIEF(''));
  const old = run('merge', f, '--skill', 'prd');
  assert.equal(old.status, 0);
  assert.match(old.stdout, /no Assumptions field/);
});

// ---- setup skill ----

test('setup skill asks ten questions and writes style and refs', () => {
  const md = fs.readFileSync(path.join(path.dirname(STATE_JS), '../skills/setup/SKILL.md'), 'utf8');
  for (const n of [8, 9, 10]) assert.match(md, new RegExp(`^${n}\\. `, 'm'));
  assert.match(md, /state\.js style init/);
  assert.match(md, /state\.js refs init/);
  assert.match(md, /\*\*Assumptions \(proposals\):\*\*/);
  assert.ok(md.indexOf('**Terms:**') < md.indexOf('**Assumptions (proposals):**'));
});

test('style init and refs init refuse a JSON argument with exit 2', () => {
  for (const kind of ['style', 'refs']) {
    const { pm, run } = setup();
    const r = run(kind, 'init', '{"banned_words":["x"]}');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /init takes no JSON; use: state\.js <refs\|style> merge '<json>'/);
    assert.equal(fs.existsSync(path.join(pm, `${kind}.json`)), false);
  }
});
