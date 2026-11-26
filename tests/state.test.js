// tests/state.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseState, parseDebrief, mergeDebrief, addDecision, enforceFactLimit, renderState, archiveFacts, writeStateAtomic, prdStatus, reviewGate } from '../scripts/state.js';

const SAMPLE = `# Signal State — Merchant Reports
_Updated 2026-07-17 by pm_

## Phase
Discovery — export invoicing

## Facts
- Exporters lack self-serve FIRA [source: voc.md]
- UPI cap is ₹1L [source: regulatory.md]

## Decisions
- 2026-07-17 — Lock VendorX for PAN [source: checkpoint]

## Open Questions
- What is the retention window? [asked-by: grill-discovery]

## Artifacts
| File | Digest | Updated |
|---|---|---|
| .pm/context/voc.md | 3 pain points on FIRA | 2026-07-17 |

## Next
Run /prioritize to bucket tasks
`;

test('parseState extracts all sections', () => {
  const s = parseState(SAMPLE);
  assert.equal(s.product, 'Merchant Reports');
  assert.equal(s.phase, 'Discovery — export invoicing');
  assert.equal(s.facts.length, 2);
  assert.equal(s.decisions.length, 1);
  assert.equal(s.openQuestions.length, 1);
  assert.equal(s.artifacts.length, 1);
  assert.equal(s.artifacts[0].file, '.pm/context/voc.md');
  assert.match(s.next, /prioritize/);
});

test('parseState tolerates empty / malformed input', () => {
  const s = parseState('');
  assert.equal(s.facts.length, 0);
  assert.equal(s.artifacts.length, 0);
  assert.equal(s.phase, '');
});

test('parseDebrief reads the standard block', () => {
  const d = parseDebrief(`## Debrief — voc
**Artifact:** .pm/context/voc.md
**Digest:** 3 pain points on FIRA
**Learned:**
- Users export to Excel manually
- Support tickets spike at month-end
**Open questions for user:** none
**Suggested next:** run competitive agent`);
  assert.equal(d.artifact, '.pm/context/voc.md');
  assert.equal(d.learned.length, 2);
  assert.equal(d.openQuestions.length, 0);
  assert.match(d.next, /competitive/);
});

test('mergeDebrief folds learned into facts and upserts artifact', () => {
  const s = parseState(SAMPLE);
  const d = parseDebrief(`## Debrief — competitive
**Artifact:** .pm/context/competitive.md
**Digest:** 4 competitors mapped
**Learned:**
- Paystream has no FIRA export
- Exporters lack self-serve FIRA
**Open questions for user:** Should we match Paylane pricing?
**Suggested next:** draft PRD`);
  const next = mergeDebrief(s, d, { date: '2026-07-18' });
  // new fact added, duplicate fact not re-added
  assert.ok(next.facts.includes('Paystream has no FIRA export'));
  assert.equal(next.facts.filter(f => f === 'Exporters lack self-serve FIRA').length, 1);
  // artifact appended
  assert.equal(next.artifacts.length, 2);
  assert.equal(next.artifacts[1].file, '.pm/context/competitive.md');
  // open question captured, next updated
  assert.ok(next.openQuestions.some(q => /Paylane/.test(q)));
  assert.equal(next.next, 'draft PRD');
});

test('mergeDebrief with artifact "none" does not add a row', () => {
  const s = parseState(SAMPLE);
  const d = parseDebrief(`## Debrief — handoff
**Artifact:** none
**Digest:** —
**Learned:**
- Session paused
**Open questions for user:** none
**Suggested next:** resume with /pm continue`);
  const next = mergeDebrief(s, d, { date: '2026-07-18' });
  assert.equal(next.artifacts.length, 1);
});

test('enforceFactLimit archives oldest facts over the limit', () => {
  const s = parseState(SAMPLE);
  s.facts = Array.from({ length: 35 }, (_, i) => `fact ${i}`);
  const { state, archived } = enforceFactLimit(s, 30);
  assert.equal(state.facts.length, 30);
  assert.equal(archived.length, 5);
  assert.equal(archived[0], 'fact 0');       // oldest archived
  assert.equal(state.facts[0], 'fact 5');     // newest kept
});

test('renderState round-trips through parseState', () => {
  const s = parseState(SAMPLE);
  const rendered = renderState(s, { skill: 'pm', date: '2026-07-17' });
  const reparsed = parseState(rendered);
  assert.equal(reparsed.phase, s.phase);
  assert.equal(reparsed.facts.length, s.facts.length);
  assert.equal(reparsed.artifacts.length, s.artifacts.length);
  assert.equal(reparsed.next, s.next);
});

test('parseState reads a Glossary section', () => {
  const s = parseState(SAMPLE.replace('## Artifacts', '## Glossary\n- FIRA — Foreign Inward Remittance Advice\n\n## Artifacts'));
  assert.equal(s.glossary.length, 1);
  assert.match(s.glossary[0], /^FIRA —/);
});

test('parseState defaults glossary to an empty array when the section is absent', () => {
  assert.deepEqual(parseState(SAMPLE).glossary, []);
});

test('mergeDebrief folds Terms into the glossary and upserts by term name', () => {
  const s = parseState(SAMPLE);
  s.glossary = ['FIRA — old definition'];
  const d = parseDebrief(`## Debrief — research
**Artifact:** .pm/research/regulatory.md
**Digest:** two terms
**Learned:**
- Something learned
**Terms:**
- FIRA — Foreign Inward Remittance Advice
- OCA — Operating Current Account
**Suggested next:** draft PRD`);
  const next = mergeDebrief(s, d, { date: '2026-07-31' });
  assert.equal(next.glossary.length, 2, 'FIRA should be replaced, not duplicated');
  assert.equal(next.glossary[0], 'FIRA — Foreign Inward Remittance Advice');
  assert.match(next.glossary[1], /^OCA —/);
});

test('mergeDebrief does not mutate the input state', () => {
  const s = parseState(SAMPLE);
  // Pre-populate every array field mergeDebrief touches — not just facts —
  // so every merge path (facts, glossary upsert-existing, glossary upsert-new,
  // decisions, openQuestions, artifacts) actually fires against non-empty state.
  s.glossary = ['FIRA — old definition', 'OCA — Operating Current Account'];
  const snapshot = () => JSON.stringify({
    facts: s.facts,
    decisions: s.decisions,
    glossary: s.glossary,
    openQuestions: s.openQuestions,
    artifacts: s.artifacts,
  });
  const before = snapshot();

  const d = parseDebrief(`## Debrief — x
**Artifact:** .pm/context/new-artifact.md
**Digest:** new digest
**Learned:**
- brand new fact
**Terms:**
- FIRA — Foreign Inward Remittance Advice
- LRS — Liberalised Remittance Scheme
**Open questions for user:** Is this a new open question?
**Suggested next:** n`);
  const next = mergeDebrief(s, d, { date: '2026-07-31' });

  assert.equal(snapshot(), before, 'input state was mutated by mergeDebrief');

  // Mutate the returned state's arrays afterwards and re-assert the input is
  // still untouched — this is what actually catches a shared reference (a
  // same-length substitution or `.length`-only check would not catch it).
  next.facts.push('mutation probe');
  next.decisions.push('mutation probe');
  next.glossary.push('mutation probe');
  next.openQuestions.push('mutation probe');
  next.artifacts.push({ file: 'probe', digest: 'probe', updated: 'probe' });

  assert.equal(snapshot(), before, 'input state was mutated through the returned state (shared reference)');
});

test('addDecision appends a dated, attributed entry and dedupes', () => {
  const s = parseState(SAMPLE);
  const once = addDecision(s, 'Lock v0 to 5 stories', { date: '2026-07-31', at: 'prioritization' });
  assert.equal(once.decisions.length, 2);
  assert.equal(once.decisions[1], '2026-07-31 — Lock v0 to 5 stories [at: prioritization]');
  const twice = addDecision(once, 'Lock v0 to 5 stories', { date: '2026-07-31', at: 'prioritization' });
  assert.equal(twice.decisions.length, 2, 'duplicate decision should not be appended');
});

test('renderState emits Glossary and round-trips it', () => {
  const s = parseState(SAMPLE);
  s.glossary = ['FIRA — Foreign Inward Remittance Advice'];
  const reparsed = parseState(renderState(s, { skill: 'pm', date: '2026-07-31' }));
  // Assert on content (including the em dash separator), not just length —
  // a renderer change that mangles "term — definition" must fail this.
  assert.deepEqual(reparsed.glossary, s.glossary);
  assert.equal(reparsed.glossary[0], 'FIRA — Foreign Inward Remittance Advice');
  assert.equal(reparsed.decisions.length, s.decisions.length);
});

test('archiveFacts writes the archive file and trims state atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const statePath = path.join(dir, 'state.md');
  const archivePath = path.join(dir, 'context', 'archive.md');

  const s = parseState(SAMPLE);
  s.facts = Array.from({ length: 35 }, (_, i) => `fact ${i} [source: t]`);
  fs.writeFileSync(statePath, renderState(s, { skill: 'test', date: '2026-07-31' }));

  const result = archiveFacts(statePath, archivePath, { max: 30, date: '2026-07-31' });

  assert.equal(result.archived, 5);
  assert.ok(fs.existsSync(archivePath), 'archive file was not created');
  const archive = fs.readFileSync(archivePath, 'utf8');
  assert.match(archive, /fact 0 \[source: t\]/, 'oldest fact missing from archive');
  assert.match(archive, /fact 4 \[source: t\]/);
  assert.ok(!/fact 5 /.test(archive), 'kept fact should not be archived');

  const after = parseState(fs.readFileSync(statePath, 'utf8'));
  assert.equal(after.facts.length, 30);
  assert.match(after.facts[0], /^fact 5 /);
  assert.ok(!fs.existsSync(statePath + '.tmp'), 'temp file was left behind');
});

test('archiveFacts is a no-op under the limit and creates no file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const statePath = path.join(dir, 'state.md');
  const archivePath = path.join(dir, 'context', 'archive.md');
  fs.writeFileSync(statePath, SAMPLE);
  const result = archiveFacts(statePath, archivePath, { max: 30, date: '2026-07-31' });
  assert.equal(result.archived, 0);
  assert.equal(fs.existsSync(archivePath), false);
});

test('archiveFacts appends to an existing archive rather than overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const statePath = path.join(dir, 'state.md');
  const archivePath = path.join(dir, 'context', 'archive.md');
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, '# Archive\n\n- an older fact\n');

  const s = parseState(SAMPLE);
  s.facts = Array.from({ length: 32 }, (_, i) => `fact ${i}`);
  fs.writeFileSync(statePath, renderState(s, { skill: 'test', date: '2026-07-31' }));

  archiveFacts(statePath, archivePath, { max: 30, date: '2026-07-31' });
  const archive = fs.readFileSync(archivePath, 'utf8');
  assert.match(archive, /an older fact/, 'existing archive content was destroyed');
  assert.match(archive, /fact 0/);
});

test('archiveFacts is a no-op exactly at the limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const statePath = path.join(dir, 'state.md');
  const archivePath = path.join(dir, 'context', 'archive.md');

  const s = parseState(SAMPLE);
  s.facts = Array.from({ length: 30 }, (_, i) => `fact ${i}`);
  fs.writeFileSync(statePath, renderState(s, { skill: 'test', date: '2026-07-31' }));

  const result = archiveFacts(statePath, archivePath, { max: 30, date: '2026-07-31' });
  assert.equal(result.archived, 0);
  assert.deepEqual(result.facts, []);
  assert.equal(fs.existsSync(archivePath), false);
});

test('writeStateAtomic removes the .tmp file and rethrows if rename fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const p = path.join(dir, 'state.md');

  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated rename failure'); };
  try {
    assert.throws(() => writeStateAtomic(p, 'content'), /simulated rename failure/);
  } finally {
    fs.renameSync = original;
  }

  assert.ok(!fs.existsSync(p + '.tmp'), 'temp file was left behind after a failed rename');
  assert.ok(!fs.existsSync(p), 'target file should not exist since the rename never completed');
});

test('writeStateAtomic removes the .tmp file and rethrows if the write itself fails partway', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const p = path.join(dir, 'state.md');

  // Simulate ENOSPC / quota loss mid-write: the real fs.writeFileSync manages
  // to get partial content onto disk at `tmp` before throwing.
  const original = fs.writeFileSync;
  fs.writeFileSync = (file, content) => {
    original(file, String(content).slice(0, 3));
    throw new Error('simulated ENOSPC');
  };
  try {
    assert.throws(() => writeStateAtomic(p, 'full content'), /simulated ENOSPC/);
  } finally {
    fs.writeFileSync = original;
  }

  assert.ok(!fs.existsSync(p + '.tmp'), 'temp file was left behind after a failed write');
  assert.ok(!fs.existsSync(p), 'target file should not exist since the write never completed');
});

test('archiveFacts retried after a failed rewrite does not duplicate archive entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const statePath = path.join(dir, 'state.md');
  const archivePath = path.join(dir, 'context', 'archive.md');

  const s = parseState(SAMPLE);
  s.facts = Array.from({ length: 35 }, (_, i) => `fact ${i}`);
  fs.writeFileSync(statePath, renderState(s, { skill: 'test', date: '2026-07-31' }));

  // Simulate the rewrite step failing after the archive append has already
  // succeeded — this is the exact partial-failure window the fix must survive.
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated rename failure'); };
  try {
    assert.throws(() => archiveFacts(statePath, archivePath, { max: 30, date: '2026-07-31' }));
  } finally {
    fs.renameSync = original;
  }

  // state.md was never rewritten, so a caller retrying will re-select the
  // same oldest facts.
  const afterFailure = parseState(fs.readFileSync(statePath, 'utf8'));
  assert.equal(afterFailure.facts.length, 35, 'state.md should be untouched after the failed rewrite');

  const retryResult = archiveFacts(statePath, archivePath, { max: 30, date: '2026-07-31' });
  assert.equal(retryResult.archived, 5);

  const archive = fs.readFileSync(archivePath, 'utf8');
  const occurrences = archive.split('- fact 0').length - 1;
  assert.equal(occurrences, 1, 'fact 0 should appear exactly once in the archive despite the retry');

  const afterRetry = parseState(fs.readFileSync(statePath, 'utf8'));
  assert.equal(afterRetry.facts.length, 30, 'the retry must still trim state.md');
});

function stateWithFacts(facts, extra = {}) {
  return { ...parseState(SAMPLE), facts, decisions: [], openQuestions: [], ...extra };
}

test('enforceFactLimit keeps an old fact that a Decision references and trims the next-oldest instead', () => {
  const facts = Array.from({ length: 5 }, (_, i) => `fact ${i} [source: t]`);
  const s = stateWithFacts(facts, { decisions: ['2026-07-17 — Chose X because fact 0 holds [at: scope]'] });
  const { state, archived } = enforceFactLimit(s, 3);
  assert.deepEqual(archived, ['fact 1 [source: t]', 'fact 2 [source: t]']);
  assert.deepEqual(state.facts, ['fact 0 [source: t]', 'fact 3 [source: t]', 'fact 4 [source: t]']);
});

test('enforceFactLimit keeps a fact that an Open Question references', () => {
  const facts = Array.from({ length: 4 }, (_, i) => `fact ${i} [source: t]`);
  const s = stateWithFacts(facts, { openQuestions: ['Does fact 1 still hold? [asked-by: prd]'] });
  const { state, archived } = enforceFactLimit(s, 2);
  assert.deepEqual(state.facts, ['fact 1 [source: t]', 'fact 3 [source: t]']);
  assert.deepEqual(archived, ['fact 0 [source: t]', 'fact 2 [source: t]']);
});

test('enforceFactLimit trims by age alone when nothing is referenced', () => {
  const facts = Array.from({ length: 5 }, (_, i) => `fact ${i} [source: t]`);
  const { state, archived } = enforceFactLimit(stateWithFacts(facts), 3);
  assert.deepEqual(archived, ['fact 0 [source: t]', 'fact 1 [source: t]']);
  assert.equal(state.facts.length, 3);
});

test('enforceFactLimit keeps every referenced fact even when they alone exceed the limit', () => {
  const facts = ['alpha one [source: t]', 'beta two [source: t]', 'gamma three [source: t]'];
  const s = stateWithFacts(facts, { decisions: ['Use alpha one and beta two [at: x]'] });
  const { state, archived } = enforceFactLimit(s, 1);
  assert.deepEqual(state.facts, ['alpha one [source: t]', 'beta two [source: t]']);
  assert.deepEqual(archived, ['gamma three [source: t]']);
});

test('archiveFacts does not archive a fact a Decision references', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const statePath = path.join(dir, 'state.md');
  const archivePath = path.join(dir, 'context', 'archive.md');
  const s = stateWithFacts(
    Array.from({ length: 33 }, (_, i) => `fact ${i} [source: t]`),
    { decisions: ['2026-07-17 — Lock scope on fact 0 [at: scope]'] });
  fs.writeFileSync(statePath, renderState(s, { skill: 'test', date: '2026-07-31' }));
  const r = archiveFacts(statePath, archivePath, { max: 30, date: '2026-07-31' });
  assert.equal(r.archived, 3);
  const after = parseState(fs.readFileSync(statePath, 'utf8'));
  assert.equal(after.facts.length, 30);
  assert.ok(after.facts.includes('fact 0 [source: t]'), 'referenced fact was trimmed');
  assert.ok(!fs.readFileSync(archivePath, 'utf8').includes('- fact 0 '), 'referenced fact reached the archive');
});

// ---- Files field, prd-draft cleanup, listField hygiene, pinned archive ----
const DEB = (extra) => `## Debrief
**Artifact:** ${extra.artifact || '.pm/discovery.md'}
**Digest:** main digest
**Learned:**
- a learning [source: t]
${extra.body || ''}
**Suggested next:** go
`;
const emptyState = () => parseState('# Signal State — T\n## Phase\nx\n');

test('Files field: each bullet is upserted into Artifacts like the main Artifact', () => {
  const d = parseDebrief(DEB({ body: '**Files:**\n- .pm/a.md — digest a\n- .pm/b.md — digest b' }));
  assert.deepEqual(d.files, [{ file: '.pm/a.md', digest: 'digest a' }, { file: '.pm/b.md', digest: 'digest b' }]);
  let s = mergeDebrief(emptyState(), d, { date: '2026-01-01' });
  assert.deepEqual(s.artifacts.map(a => a.file).sort(), ['.pm/a.md', '.pm/b.md', '.pm/discovery.md']);
  const d2 = parseDebrief(DEB({ body: '**Files:**\n- .pm/a.md — new digest' }));
  s = mergeDebrief(s, d2, { date: '2026-02-02' });
  const a = s.artifacts.filter(x => x.file === '.pm/a.md');
  assert.equal(a.length, 1);
  assert.equal(a[0].digest, 'new digest');
  assert.equal(a[0].updated, '2026-02-02');
});

test('Files field is optional and "none" yields no files', () => {
  assert.deepEqual(parseDebrief(DEB({})).files, []);
  assert.deepEqual(parseDebrief(DEB({ body: '**Files:** none' })).files, []);
});

test('mergeDebrief drops .pm/prd-draft/ rows when the Artifact is under .pm/prd/', () => {
  const st = { ...emptyState(), artifacts: [
    { file: '.pm/prd-draft/prd.md', digest: 'd', updated: 'x' },
    { file: '.pm/discovery.md', digest: 'd', updated: 'x' }] };
  const s = mergeDebrief(st, parseDebrief(DEB({ artifact: '.pm/prd/v1/prd.md' })), { date: 'z' });
  assert.deepEqual(s.artifacts.map(a => a.file).sort(), ['.pm/discovery.md', '.pm/prd/v1/prd.md']);
  const keep = mergeDebrief(st, parseDebrief(DEB({ artifact: '.pm/other.md' })), { date: 'z' });
  assert.ok(keep.artifacts.some(a => a.file === '.pm/prd-draft/prd.md'));
});

test('listField ignores empty / none / n/a items and strips a leading "- " inline', () => {
  const d = parseDebrief(DEB({ body: '**Terms:** - X — y\n**Open questions for user:** N/A' }));
  assert.deepEqual(d.terms, ['X — y']);
  assert.deepEqual(d.openQuestions, []);
  const b = parseDebrief(DEB({ body: '**Terms:**\n- none\n- Real — def\n- n/a\n**Open questions for user:** -' }));
  assert.deepEqual(b.terms, ['Real — def']);
  assert.deepEqual(b.openQuestions, []);
});

test('enforceFactLimit never trims [source: user] or [source: setup] facts', () => {
  const facts = [
    'u0 [source: user]', 's0 [source: setup]',
    ...Array.from({ length: 30 }, (_, i) => `f${i} [source: t]`),
  ];
  const { state, archived } = enforceFactLimit({ ...emptyState(), facts }, 30);
  assert.equal(archived.length, 2);
  assert.deepEqual(archived, ['f0 [source: t]', 'f1 [source: t]']);
  assert.ok(state.facts.includes('u0 [source: user]') && state.facts.includes('s0 [source: setup]'));
});

test('enforceFactLimit keeps all pinned facts even when they alone exceed the limit', () => {
  const facts = Array.from({ length: 32 }, (_, i) => `p${i} [source: user]`);
  const { state, archived } = enforceFactLimit({ ...emptyState(), facts }, 30);
  assert.equal(archived.length, 0);
  assert.equal(state.facts.length, 32);
});

// ---- concurrency (reliability fixes) ----
import { spawn, spawnSync } from 'node:child_process';
const STATE_JS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../scripts/state.js');
const runAll = (cmds) => Promise.all(cmds.map(args => new Promise(res => {
  const p = spawn('node', [STATE_JS, ...args], { stdio: 'ignore' });
  p.on('close', code => res(code));
})));
const initState = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-lock-'));
  const sp = path.join(d, '.pm/state.md');
  const r = spawnSync('node', [STATE_JS, 'init', 'P', '--path', sp], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { d, sp };
};

test('six parallel decide calls yield six decisions', async () => {
  const { sp } = initState();
  const codes = await runAll([1, 2, 3, 4, 5, 6].map(i => ['decide', `d${i}`, '--at', 'prd-freeze', '--path', sp]));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  assert.equal(parseState(fs.readFileSync(sp, 'utf8')).decisions.length, 6);
  assert.ok(!fs.existsSync(path.join(path.dirname(sp), '.state.lock')));
});

test('six parallel merge calls all land; a stale lock is removed', async () => {
  const { d, sp } = initState();
  const deb = [1, 2, 3, 4, 5, 6].map(i => {
    const f = path.join(d, `deb${i}.md`);
    fs.writeFileSync(f, `## Debrief — research\n**Artifact:** none\n**Digest:** d\n**Learned:**\n- fact number ${i} [source: x.md]\n**Terms:** none\n**Open questions for user:** none\n**Suggested next:** go\n`);
    return f;
  });
  const lock = path.join(path.dirname(sp), '.state.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const codes = await runAll(deb.map(f => ['merge', f, '--path', sp]));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  assert.equal(parseState(fs.readFileSync(sp, 'utf8')).facts.length, 6);
});

// ---- prd-status: resumable freeze ----
const FROZEN_SIX = ['prd.md', 'acceptance-criteria.md', 'metrics.md', 'CHANGELOG.md', 'one-pager.md', 'story-map.md'];
const prdPm = (frozen, draft) => {
  const pm = fs.mkdtempSync(path.join(os.tmpdir(), 'prdstatus-'));
  if (frozen) { fs.mkdirSync(path.join(pm, 'prd/v0'), { recursive: true }); for (const f of frozen) fs.writeFileSync(path.join(pm, 'prd/v0', f), 'x'); }
  if (draft) fs.mkdirSync(path.join(pm, 'prd-draft'), { recursive: true });
  return pm;
};

test('prdStatus: none, draft, incomplete, frozen', () => {
  assert.deepEqual(prdStatus(prdPm(), 'v0'), { status: 'none', missing: [] });
  assert.deepEqual(prdStatus(prdPm(null, true), 'v0'), { status: 'draft', missing: [] });
  assert.deepEqual(prdStatus(prdPm(FROZEN_SIX), 'v0'), { status: 'frozen', missing: [] });
  assert.equal(prdStatus(prdPm(FROZEN_SIX.slice(0, 5)), 'v0').status, 'incomplete');
  assert.equal(prdStatus(prdPm([]), 'v0').status, 'incomplete');
});

test('prdStatus: interrupted freeze (prd.md + acceptance-criteria.md only) is incomplete, even with a leftover draft dir', () => {
  const r = prdStatus(prdPm(['prd.md', 'acceptance-criteria.md'], true), 'v0');
  assert.deepEqual(r, { status: 'incomplete', missing: ['metrics.md', 'CHANGELOG.md', 'one-pager.md', 'story-map.md'] });
});

test('state.js prd-status: one line, exit 0; bad version exits 1 with a reason', () => {
  const pm = prdPm(['prd.md', 'acceptance-criteria.md']);
  const sp = path.join(pm, 'state.md');
  const ok = spawnSync('node', [STATE_JS, 'prd-status', 'v0', '--path', sp], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'incomplete metrics.md,CHANGELOG.md,one-pager.md,story-map.md\n');
  assert.equal(spawnSync('node', [STATE_JS, 'prd-status', 'v1', '--path', sp], { encoding: 'utf8' }).stdout, 'none -\n');
  const bad = spawnSync('node', [STATE_JS, 'prd-status', '../x', '--path', sp], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /version/i);
  assert.equal(spawnSync('node', [STATE_JS, 'prd-status', '--path', sp], { encoding: 'utf8' }).status, 1);
});

// ---- review-gate: freeze needs no open Blocker and a resolve report per stage ----
const STAGES = ['zoom-out', 'comprehension', 'critic', 'readiness'];
const reviewPm = ({ blockers = {}, resolves = {} } = {}) => {
  const pm = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewgate-'));
  fs.mkdirSync(path.join(pm, 'review'));
  for (const s of STAGES) {
    const titles = blockers[s] || [];
    fs.writeFileSync(path.join(pm, 'review', `${s}.md`),
      `# Review report — ${s}\n\n## Blockers\n${titles.length ? titles.map(t => `### ${t}\n**Finding:** x\n`).join('\n') : 'None.\n'}\n## Majors\n### A major\nNone of the gate.\n\n## Nits\nNone.\n`);
    if (resolves[s] !== null) {
      fs.writeFileSync(path.join(pm, 'review', `${s}-resolve.md`),
        (resolves[s] || titles.map(t => [t, 'fixed'])).map(([t, st]) => `### ${t}\nCategory: PROPOSE FIX\nStatus: ${st}\n`).join('\n') || '# Resolve\n');
    }
  }
  return pm;
};

test('reviewGate passes when no stage has a Blocker and every resolve report exists', () => {
  assert.deepEqual(reviewGate(reviewPm()), { ok: true, problems: [] });
});

test('reviewGate fails on a missing stage report or resolve report', () => {
  const pm = reviewPm();
  fs.rmSync(path.join(pm, 'review/critic-resolve.md'));
  fs.rmSync(path.join(pm, 'review/readiness.md'));
  const r = reviewGate(pm);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['critic: no resolve report', 'readiness: no review report']);
  assert.equal(reviewGate(fs.mkdtempSync(path.join(os.tmpdir(), 'reviewgate-'))).problems.length, 4);
});

test('reviewGate: a Blocker is open without a resolve section or with Status: open, closed otherwise; Majors never block', () => {
  const pm = reviewPm({
    blockers: { 'zoom-out': ['Too big', 'No owner'], critic: ['Race'] },
    resolves: { 'zoom-out': [['Too big', 'fixed'], ['No owner', 'open']], critic: [['Race', 'contested']] },
  });
  const r = reviewGate(pm);
  assert.deepEqual(r.problems, ['zoom-out: open Blocker "No owner"']);
  fs.writeFileSync(path.join(pm, 'review/zoom-out-resolve.md'), '### Too big\nStatus: accepted\n\n### No owner\nStatus: fixed\n');
  assert.equal(reviewGate(pm).ok, true);
  fs.writeFileSync(path.join(pm, 'review/zoom-out-resolve.md'), '### Too big\nStatus: accepted\n');
  assert.deepEqual(reviewGate(pm).problems, ['zoom-out: open Blocker "No owner"']);
});

test('state.js review-gate: exit 0 and ok when clear, exit 1 and the reasons when blocked', () => {
  const pm = reviewPm();
  const sp = path.join(pm, 'state.md');
  const ok = spawnSync('node', [STATE_JS, 'review-gate', '--path', sp], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'ok\n');
  fs.rmSync(path.join(pm, 'review/zoom-out-resolve.md'));
  const bad = spawnSync('node', [STATE_JS, 'review-gate', '--path', sp], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, 'blocked\n- zoom-out: no resolve report\n');
});
