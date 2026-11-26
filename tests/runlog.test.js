// tests/runlog.test.js — run log: append-only events, plain-line tail.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KINDS, appendEvent, readEvents, formatEvent } from '../scripts/runlog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/runlog.js');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-runlog-')), 'run.log');
const cli = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', cwd: ROOT });

test('kinds are the fixed set', () => {
  assert.deepEqual(KINDS, ['route', 'skip', 'brief', 'dispatch', 'merge', 'decide', 'note']);
});

test('add appends one JSON line with ts, kind, agent, text', () => {
  const f = tmp();
  assert.equal(cli(['add', 'route', 'research → prd', '--path', f]).status, 0);
  assert.equal(cli(['add', 'dispatch', 'prd (deep)', '--agent', 'prd', '--path', f]).status, 0);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const [a, b] = lines.map(l => JSON.parse(l));
  assert.deepEqual(Object.keys(a), ['ts', 'kind', 'agent', 'text']);
  assert.equal(a.agent, null);
  assert.equal(b.agent, 'prd');
  assert.ok(!Number.isNaN(Date.parse(a.ts)));
});

test('add never rewrites earlier lines', () => {
  const f = tmp();
  appendEvent(f, { kind: 'note', text: 'one' });
  const before = fs.readFileSync(f, 'utf8');
  appendEvent(f, { kind: 'note', text: 'two' });
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(before));
});

test('unknown kind is rejected with a named reason', () => {
  const f = tmp();
  const r = cli(['add', 'bogus', 'x', '--path', f]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown kind "bogus"/);
  assert.match(r.stderr, /route, skip, brief, dispatch, merge, decide, note/);
  assert.ok(!fs.existsSync(f));
});

test('add without text is rejected', () => {
  const r = cli(['add', 'note', '--path', tmp()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /text/i);
});

test('tail prints the last n as plain lines', () => {
  const f = tmp();
  for (let i = 1; i <= 5; i++) appendEvent(f, { kind: 'brief', agent: 'prd', text: `step ${i}` });
  appendEvent(f, { kind: 'route', text: 'no agent' });
  const r = cli(['tail', '2', '--path', f]);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d\d:\d\d  brief {1,}  prd  step 5$/);
  assert.match(lines[1], /^\d\d:\d\d  route {1,}  -  no agent$/);
});

test('tail on a missing file prints nothing and exits 0', () => {
  const r = cli(['tail', '--path', tmp()]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('readEvents skips broken lines; formatEvent pads kind to 8', () => {
  const f = tmp();
  fs.writeFileSync(f, 'not json\n' + JSON.stringify({ ts: '2026-01-01T10:05:00.000Z', kind: 'merge', agent: null, text: 'ok' }) + '\n');
  const ev = readEvents(f);
  assert.equal(ev.length, 1);
  assert.match(formatEvent(ev[0]), /^\d\d:\d\d  merge {3}  -  ok$/);
});
