// tests/install.test.js — scripts/install.sh creates and removes the ~/.signal/root link (temp HOME only).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = path.join(ROOT, 'scripts/install.sh');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signal-home-'));
const sh = (h, ...a) => spawnSync('sh', [SH, ...a], { encoding: 'utf8', env: { ...process.env, HOME: h } });

test('install links ~/.signal/root to the repo, replaces a stale link, uninstall removes only it', () => {
  const h = home();
  const link = path.join(h, '.signal/root');
  assert.equal(sh(h).status, 0);
  assert.equal(fs.realpathSync(link), fs.realpathSync(ROOT));
  fs.rmSync(link); fs.symlinkSync(os.tmpdir(), link);
  assert.equal(sh(h).status, 0);
  assert.equal(fs.realpathSync(link), fs.realpathSync(ROOT));
  fs.writeFileSync(path.join(h, '.signal/keep.txt'), 'x');
  assert.equal(sh(h, '--uninstall').status, 0);
  assert.ok(!fs.existsSync(link) && fs.existsSync(path.join(h, '.signal/keep.txt')));
});

test('install never overwrites a real file or directory at ~/.signal/root', () => {
  const h = home();
  const dir = path.join(h, '.signal/root');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine'), 'x');
  assert.equal(sh(h).status, 0);
  assert.ok(!fs.lstatSync(dir).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(dir, 'mine')));
  sh(h, '--uninstall');
  assert.ok(fs.existsSync(path.join(dir, 'mine')));
});

const withExtra = (fn) => {
  const dir = path.join(ROOT, 'extras/zz-test-addon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: zz-test-addon\ndescription: test\n---\n');
  try { fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('extras install only with --with-extras; uninstall removes them', () => {
  withExtra(() => {
    const h = home();
    const link = path.join(h, '.claude/skills/zz-test-addon');
    assert.equal(sh(h).status, 0);
    assert.ok(!fs.existsSync(link));
    assert.equal(sh(h, '--with-extras').status, 0);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ROOT, 'extras/zz-test-addon')));
    assert.equal(sh(h).status, 0);
    assert.ok(fs.existsSync(link), 'plain install leaves add-on links alone');
    assert.equal(sh(h, '--uninstall').status, 0);
    assert.ok(!fs.existsSync(link));
  });
});

test('--with-extras never overwrites a real directory and prunes stale add-on links', () => {
  withExtra(() => {
    const h = home();
    const link = path.join(h, '.claude/skills/zz-test-addon');
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, 'mine'), 'x');
    assert.equal(sh(h, '--with-extras').status, 0);
    assert.ok(!fs.lstatSync(link).isSymbolicLink() && fs.existsSync(path.join(link, 'mine')));
    fs.rmSync(link, { recursive: true });
    const stale = path.join(h, '.claude/skills/gone');
    fs.symlinkSync(path.join(ROOT, 'extras/gone'), stale);
    assert.equal(sh(h, '--with-extras').status, 0);
    assert.ok(!fs.existsSync(stale) && !fs.lstatSync(link).isDirectory());
  });
});

test('install links the signal skill from the registry', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-home-'));
  assert.equal(sh(h).status, 0);
  const link = path.join(h, '.claude/skills/signal');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(link, 'SKILL.md')));
  sh(h, '--uninstall');
});
