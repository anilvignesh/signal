// tests/claude.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasClaude, runAgent } from '../scripts/claude.js';

test('hasClaude returns a boolean and never throws', () => {
  assert.equal(typeof hasClaude(), 'boolean');
});

test('runAgent degrades cleanly when the binary is absent', async () => {
  const r = await runAgent('ac-agent', 'briefing text', { bin: '/nonexistent/claude-binary' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'claude-missing');
  assert.equal(r.engine, 'none');
});

test('runAgent validates the debrief and records the raw response', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-claude-'));
  // A stub that ignores its args and prints a valid debrief.
  const stub = path.join(dir, 'fake-claude');
  fs.writeFileSync(stub, `#!/bin/sh
cat <<'EOF'
## Debrief — ac-agent
**Artifact:** none
**Digest:** stubbed run
**Learned:**
- a finding [source: stub]
**Suggested next:** merge it
EOF
`);
  fs.chmodSync(stub, 0o755);

  const r = await runAgent('ac-agent', 'briefing text', { bin: stub, runDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'claude');
  assert.equal(r.debrief.learned.length, 1);
  assert.ok(fs.existsSync(r.logPath), 'raw response was not recorded');
  assert.match(fs.readFileSync(r.logPath, 'utf8'), /stubbed run/);
});

test('runAgent reports validation errors without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-claude-'));
  const stub = path.join(dir, 'fake-claude');
  fs.writeFileSync(stub, `#!/bin/sh\necho "I had a look and it seems fine."\n`);
  fs.chmodSync(stub, 0o755);

  const r = await runAgent('ac-agent', 'briefing text', { bin: stub, runDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-debrief');
  assert.match(r.errors.join(' '), /no "## Debrief" block/);
  assert.ok(fs.existsSync(r.logPath), 'raw response must be recorded even on failure');
});

test('runAgent reports invocation-failed when the binary exits non-zero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-claude-'));
  const stub = path.join(dir, 'fake-claude');
  fs.writeFileSync(stub, `#!/bin/sh\necho "boom" 1>&2\nexit 1\n`);
  fs.chmodSync(stub, 0o755);

  const r = await runAgent('ac-agent', 'briefing text', { bin: stub, runDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invocation-failed');
  assert.equal(r.engine, 'claude');
  assert.ok(fs.existsSync(r.logPath), 'raw response must be recorded even on a non-zero exit');
});

test('runAgent reports timeout when the binary runs past the deadline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-claude-'));
  const stub = path.join(dir, 'fake-claude');
  fs.writeFileSync(stub, `#!/bin/sh\nsleep 5\necho done\n`);
  fs.chmodSync(stub, 0o755);

  const r = await runAgent('ac-agent', 'briefing text', { bin: stub, runDir: dir, timeout: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.engine, 'claude');
});

test('runAgent invokes the binary with exactly `-p <prompt>` — an argument array, no shell string, no extra flags', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-claude-'));
  // Stub echoes its own argv so we can assert on exactly what was passed.
  const stub = path.join(dir, 'fake-claude');
  fs.writeFileSync(stub, `#!/bin/sh
echo "ARGC:$#"
echo "ARGV1:$1"
echo "ARGV2:$2"
cat <<'INNER'
## Debrief — ac-agent
**Artifact:** none
**Digest:** stubbed
**Learned:**
- a finding [source: stub]
**Suggested next:** merge it
INNER
`);
  fs.chmodSync(stub, 0o755);

  // A prompt with shell metacharacters and newlines — proves this travels as one argv
  // element (execFileSync + array), never through a shell that would split or expand it.
  const prompt = 'line one\nline two; rm -rf / && echo $HOME `whoami`';
  const r = await runAgent('ac-agent', prompt, { bin: stub, runDir: dir });
  assert.equal(r.ok, true);
  assert.match(r.raw, /ARGC:2/);
  assert.match(r.raw, /ARGV1:-p/);
  assert.match(r.raw, new RegExp(`ARGV2:${prompt.split('\n')[0]}`));
});
