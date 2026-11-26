// tests/setup-hooks.test.js — `signal setup-hooks` merge, idempotence, remove, refusal. Temp dirs only.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/signal.js');
const HOOK = path.join(ROOT, 'scripts/hook.js');
const LIVE = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
const EVENTS = LIVE;
const proj = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signal-sh-'));
const sig = (cwd, ...args) => spawnSync('node', [BIN, 'setup-hooks', ...args], { cwd, encoding: 'utf8' });
const settings = (d) => JSON.parse(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8'));
const ours = (s) => EVENTS.flatMap(e => (s.hooks?.[e] || []).flatMap(x => x.hooks)).filter(h => h.command.includes('scripts/hook.js'));

test('creates settings with all five events and absolute commands', () => {
  const d = proj();
  const r = sig(d);
  assert.equal(r.status, 0, r.stderr);
  const s = settings(d);
  for (const e of LIVE) assert.deepEqual(s.hooks[e], [{ hooks: [{ type: 'command', command: `node ${HOOK}` }] }]);
  assert.match(r.stdout, /added PreToolUse/);
});

test('merge keeps every existing key and hook; repeat run changes nothing', () => {
  const d = proj();
  fs.mkdirSync(path.join(d, '.claude'));
  const existing = {
    permissions: { allow: ['Bash(ls)'] },
    env: { A: '1' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'echo n' }] }],
    },
  };
  fs.writeFileSync(path.join(d, '.claude/settings.json'), JSON.stringify(existing));
  assert.equal(sig(d).status, 0);
  const once = settings(d);
  assert.deepEqual(once.permissions, existing.permissions);
  assert.deepEqual(once.env, existing.env);
  assert.deepEqual(once.hooks.Notification, existing.hooks.Notification);
  assert.deepEqual(once.hooks.PreToolUse[0], existing.hooks.PreToolUse[0]);
  assert.equal(once.hooks.PreToolUse.length, 2);
  const raw1 = fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8');
  const r = sig(d);
  assert.match(r.stdout, /Nothing changed/);
  assert.equal(fs.readFileSync(path.join(d, '.claude/settings.json'), 'utf8'), raw1);
  assert.equal(ours(settings(d)).length, 5);
});

test('--remove deletes only Signal entries', () => {
  const d = proj();
  fs.mkdirSync(path.join(d, '.claude'));
  fs.writeFileSync(path.join(d, '.claude/settings.json'), JSON.stringify({
    model: 'x',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }, { type: 'command', command: `node ${HOOK}` }] }],
    },
  }));
  sig(d);
  const r = sig(d, '--remove');
  assert.equal(r.status, 0, r.stderr);
  const s = settings(d);
  assert.equal(s.model, 'x');
  assert.deepEqual(s.hooks, {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
  });
  assert.equal(ours(s).length, 0);
});

test('--remove on a clean project is a no-op and creates nothing; removing all drops the hooks key', () => {
  const d = proj();
  const r = sig(d, '--remove');
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(d, '.claude')));
  sig(d); sig(d, '--remove');
  assert.deepEqual(settings(d), {});
});

test('invalid JSON is refused, explained, and left untouched', () => {
  const d = proj();
  fs.mkdirSync(path.join(d, '.claude'));
  const f = path.join(d, '.claude/settings.json');
  fs.writeFileSync(f, '{ "a": ');
  for (const args of [[], ['--remove']]) {
    const r = sig(d, ...args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(f, 'utf8'), '{ "a": ');
  }
});

test('unknown option is rejected', () => {
  assert.equal(sig(proj(), '--nope').status, 1);
});

test('help lists setup-hooks', () => {
  const r = spawnSync('node', [BIN, 'help'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.match(r.stdout, /setup-hooks/);
});

test('a user hook that merely ends in scripts/hook.js is left alone, also on --remove', () => {
  const d = proj();
  fs.mkdirSync(path.join(d, '.claude'));
  const mine = { type: 'command', command: 'node /home/me/other/scripts/hook.js' };
  fs.writeFileSync(path.join(d, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [mine] }] } }));
  sig(d);
  let stop = settings(d).hooks.Stop.flatMap(e => e.hooks);
  assert.ok(stop.some(h => h.command === mine.command));
  assert.equal(stop.length, 2);
  sig(d, '--remove');
  stop = settings(d).hooks.Stop.flatMap(e => e.hooks);
  assert.deepEqual(stop, [mine]);
  assert.deepEqual(fs.readdirSync(path.join(d, '.claude')).filter(f => f.includes('tmp')), []);
});

test('hooks work through a symlinked install path', () => {
  const d = proj();
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-link-')), 'root');
  fs.symlinkSync(ROOT, link);
  const r = spawnSync('node', [path.join(link, 'bin/signal.js'), 'setup-hooks'], { cwd: d, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added Stop/);
  assert.equal(settings(d).hooks.Stop[0].hooks[0].command, `node ${HOOK}`);
});
