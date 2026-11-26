// tests/signal-bin.test.js — the `signal` command: help, no-state guard, watch.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/signal.js');
const env = { ...process.env, SIGNAL_NO_OPEN: '1' };
const project = (withState = true) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-bin-'));
  fs.mkdirSync(path.join(d, '.pm'));
  if (withState) fs.writeFileSync(path.join(d, '.pm/state.md'), '# State\n');
  return d;
};
const ev = (kind, text) => JSON.stringify({ ts: new Date().toISOString(), kind, agent: null, text }) + '\n';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// Poll until fn() returns something truthy (up to 10 s), so a loaded machine cannot fail a test on timing alone.
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await wait(50); } }

test('package.json wires bin and the watch script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { signal: 'bin/signal.js' });
  assert.match(pkg.scripts.watch, /bin\/signal\.js watch/);
});

test('help works anywhere and lists the commands', () => {
  const r = spawnSync('node', [BIN, 'help'], { encoding: 'utf8', cwd: os.tmpdir(), env });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /signal watch/);
});

test('no .pm/state.md: plain message, exit 1', () => {
  for (const args of [['watch']]) {
    const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8', cwd: project(false), env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No Signal state here\. Run \/setup in Claude Code first\./);
  }
});

test('unknown command exits 1', () => {
  const r = spawnSync('node', [BIN, 'nope'], { encoding: 'utf8', cwd: project(), env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command "nope"/);
});

test('watch shows existing lines, a cost total, then new lines as they land', async () => {
  const d = project();
  const log = path.join(d, '.pm/run.log');
  fs.writeFileSync(log, ev('route', 'first') + ev('skip', 'second'));
  fs.writeFileSync(path.join(d, '.pm/cost.log'),
    JSON.stringify({ ts: 'x', agent: 'prd', tier: 'deep', est: 100, actual: 90 }) + '\n');
  const p = spawn('node', [BIN, 'watch'], { cwd: d, env });
  let out = '';
  p.stdout.on('data', c => { out += c; });
  try {
    await until(() => /Cost: 1 run/.test(out));
    assert.match(out, /route {3,}.*first/);
    assert.match(out, /skip {4,}.*second/);
    assert.match(out, /Cost: 1 run.*est 100.*actual 90/);
    fs.appendFileSync(log, ev('merge', 'third'));
    fs.appendFileSync(path.join(d, '.pm/cost.log'),
      JSON.stringify({ ts: 'x', agent: 'prd', tier: 'deep', est: 50, actual: null }) + '\n');
    await until(() => /Cost: 2 runs/.test(out) && /third/.test(out));
    assert.match(out, /merge {3,}.*third/);
    assert.match(out, /Cost: 2 runs.*est 150/);
  } finally { p.kill(); }
});

test('watch shows only the last 20 existing lines', async () => {
  const d = project();
  let body = '';
  for (let i = 1; i <= 25; i++) body += ev('note', `line${i}x`);
  fs.writeFileSync(path.join(d, '.pm/run.log'), body);
  const p = spawn('node', [BIN, 'watch'], { cwd: d, env });
  let out = '';
  p.stdout.on('data', c => { out += c; });
  try {
    await until(() => out.includes('line25x'));
    assert.ok(!out.includes('line5x'));
    assert.ok(out.includes('line6x') && out.includes('line25x'));
  } finally { p.kill(); }
});

