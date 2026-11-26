// tests/cli.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composeBriefing, resolveOutputPath, resolveOutputPaths, parseState } from '../scripts/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/state.js');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/registry.json'), 'utf8'));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-cli-'));
  return { dir, state: path.join(dir, 'state.md') };
}
const run = (args, opts = {}) =>
  execFileSync('node', [CLI, ...args], { encoding: 'utf8', cwd: ROOT, ...opts });

test('resolveOutputPath substitutes params', () => {
  assert.equal(resolveOutputPath(registry.skills.research, { lens: 'regulatory' }), '.pm/research/regulatory.md');
  assert.equal(resolveOutputPath(registry.skills['review-synthesizer'], { stage: 'critic' }), '.pm/review/critic.md');
});

test('resolveOutputPath returns the first file of a multi-file output, and resolveOutputPaths returns all', () => {
  const entry = { outputs: ['.pm/prd/{version}/prd.md', '.pm/prd/{version}/metrics.md'] };
  assert.equal(resolveOutputPath(entry, { version: 'v1' }), '.pm/prd/v1/prd.md');
  assert.deepEqual(resolveOutputPaths(entry, { version: 'v1' }), ['.pm/prd/v1/prd.md', '.pm/prd/v1/metrics.md']);
  assert.deepEqual(resolveOutputPaths({ outputs: null }, {}), []);
});

test('composeBriefing lists every output file of a multi-file skill', () => {
  const state = parseState('# Signal State — T\n## Phase\nx\n');
  const brief = composeBriefing(state, { ...registry.skills.prd, name: 'prd' }, { version: 'v1' });
  for (const f of ['prd.md', 'acceptance-criteria.md', 'metrics.md', 'CHANGELOG.md', 'one-pager.md', 'story-map.md']) {
    assert.ok(brief.includes(`.pm/prd/v1/${f}`), `briefing missing ${f}`);
  }
});

test('brief ac-agent requires version and resolves its output path', () => {
  const out = run(['brief', 'ac-agent', 'version=v0', '--path', (() => { const { state } = sandbox(); run(['init', 'T', '--path', state]); return state; })()]);
  assert.match(out, /\.pm\/prd\/v0\/acceptance-criteria\.md/);
  assert.throws(() => run(['brief', 'ac-agent'], { stdio: 'pipe' }));
});

test('composeBriefing includes only the sections the registry declares', () => {
  const state = parseState(`# Signal State — Test
## Phase
Discovery — X
## Facts
- a fact [source: t]
## Decisions
- 2026-01-01 — a decision [at: checkpoint]
## Next
do the thing
`);
  const brief = composeBriefing(state, { ...registry.skills.research, name: 'research' }, { lens: 'regulatory' });
  assert.match(brief, /## Briefing — research/);
  assert.match(brief, /\*\*lens:\*\* regulatory/);
  assert.match(brief, /a fact \[source: t\]/, 'facts are declared in needs and must appear');
  assert.ok(!/a decision/.test(brief), 'decisions are NOT in research.needs and must be omitted');
  assert.match(brief, /end with a Debrief block/);
});

test('init creates a state file with all sections', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.product, 'Test Product');
  assert.deepEqual(s.facts, []);
  assert.deepEqual(s.glossary, []);
});

test('merge folds a valid debrief into state and exits 0', () => {
  const { dir, state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const debrief = path.join(dir, 'debrief.md');
  fs.writeFileSync(debrief, `## Debrief — research
**Artifact:** .pm/research/regulatory.md
**Digest:** RBI obligations mapped
**Learned:**
- PA MD 2025 requires auth-event capture [source: rbi.org.in]
**Terms:**
- PA MD 2025 — RBI Master Direction on Payment Aggregators
**Suggested next:** run red-team
`);
  run(['merge', debrief, '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.facts.length, 1);
  assert.equal(s.glossary.length, 1);
  assert.equal(s.artifacts.length, 1);
  assert.match(s.next, /red-team/);
});

test('merge REJECTS a malformed debrief, exits non-zero, and leaves state untouched', () => {
  const { dir, state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const before = fs.readFileSync(state, 'utf8');
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(bad, 'I had a look and it seems fine to me overall.');

  let threw = false;
  try {
    execFileSync('node', [CLI, 'merge', bad, '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /no "## Debrief" block/);
  }
  assert.ok(threw, 'merge must throw on malformed input');
  assert.equal(fs.readFileSync(state, 'utf8'), before, 'state must be untouched after a failed merge');
});

test('decide records a dated decision', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  run(['decide', 'Lock v0 to 5 stories', '--at', 'prioritisation', '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.decisions.length, 1);
  assert.match(s.decisions[0], /Lock v0 to 5 stories \[at: prioritisation\]/);
});

test('check exits non-zero when facts exceed the limit', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  s.facts = Array.from({ length: 31 }, (_, i) => `fact ${i} [source: t]`);
  // rebuild the file with too many facts
  fs.writeFileSync(state, fs.readFileSync(state, 'utf8').replace('## Facts\n', `## Facts\n${s.facts.map(f => `- ${f}`).join('\n')}\n`));
  let threw = false;
  try {
    execFileSync('node', [CLI, 'check', '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.match(String(err.stdout) + String(err.stderr), /OVER LIMIT/);
  }
  assert.ok(threw, 'check must exit non-zero when over the fact limit');
});

// --- Regression tests: reviewer-found silent-failure paths (Task 5 fix pass 1) ---

test('decide with no positional text exits non-zero and writes nothing to Decisions', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const before = fs.readFileSync(state, 'utf8');

  let threw = false;
  try {
    execFileSync('node', [CLI, 'decide', '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /Usage: state\.js decide/);
  }
  assert.ok(threw, 'decide must exit non-zero when no decision text is given');
  assert.equal(fs.readFileSync(state, 'utf8'), before, 'state must be untouched — the flag value must not be written as a decision');
});

test('archive on a missing state file exits non-zero with a named reason and no stack trace', () => {
  const { dir } = sandbox();
  const missing = path.join(dir, 'nope.md');

  let threw = false;
  try {
    execFileSync('node', [CLI, 'archive', '--path', missing], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /No state file at/);
    assert.ok(!/ENOENT/.test(String(err.stderr)), 'must not leak a raw Node stack trace');
  }
  assert.ok(threw, 'archive must exit non-zero when the state file is missing');
});

test('brief exits non-zero naming a missing required param', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);

  let threw = false;
  try {
    execFileSync('node', [CLI, 'brief', 'research', '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /Missing required param "lens"/);
    assert.match(String(err.stderr), /regulatory/, 'must list the allowed values');
  }
  assert.ok(threw, 'brief must exit non-zero when a declared param is not supplied');
});

test('brief still resolves the skill name and key=value params after the positional-arg fix', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const out = run(['brief', 'research', 'lens=regulatory', '--path', state]);
  assert.match(out, /## Briefing — research/);
  assert.match(out, /\*\*lens:\*\* regulatory/);
});

// --- Critical 1: `## Phase` had no CLI verb, forcing a hand-edit (see skills/pm and skills/setup) ---

test('phase sets ## Phase and round-trips through the CLI', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  run(['phase', 'Discovery — export invoicing', '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.phase, 'Discovery — export invoicing');
});

test('phase overwrites a previously set phase rather than appending', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  run(['phase', 'Discovery — export invoicing', '--path', state]);
  run(['phase', 'Prioritisation — export invoicing', '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.phase, 'Prioritisation — export invoicing');
});

test('phase with no positional text exits non-zero, names the reason, and writes nothing', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const before = fs.readFileSync(state, 'utf8');

  let threw = false;
  try {
    execFileSync('node', [CLI, 'phase', '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /Usage: state\.js phase/);
  }
  assert.ok(threw, 'phase must exit non-zero when no text is given');
  assert.equal(fs.readFileSync(state, 'utf8'), before, 'state must be untouched — like decide, an empty phase must not write');
});

// --- Critical 2: merge/archive against a file with no "# Signal State —" header must
// refuse rather than silently rendering an empty parse over the original content. ---

test('merge REJECTS a hand-edited / non-Signal file, exits non-zero, and leaves it byte-identical', () => {
  const { dir } = sandbox();
  const notSignal = path.join(dir, 'notes.md');
  // The reviewer's own reproduction: a heading Signal doesn't recognise ("# My Notes"),
  // and a "### Facts" (three hashes) that splitSections' "## " split never matches.
  const original = [
    '# My Notes',
    '',
    '### Facts',
    '- a fact only I care about',
    '- another fact',
    '',
    '### Decisions',
    '- ship it anyway',
    '',
  ].join('\n');
  fs.writeFileSync(notSignal, original);

  const debrief = path.join(dir, 'debrief.md');
  fs.writeFileSync(debrief, [
    '## Debrief',
    '**Artifact:** none',
    '**Digest:** x',
    '**Learned:**',
    '- a new fact',
    '**Suggested next:** y',
    '',
  ].join('\n'));

  let threw = false;
  try {
    execFileSync('node', [CLI, 'merge', debrief, '--path', notSignal], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /does not look like a Signal state file/);
  }
  assert.ok(threw, 'merge must reject a file with no "# Signal State —" header');
  assert.equal(fs.readFileSync(notSignal, 'utf8'), original, 'the non-Signal file must be left byte-identical');
});

test('archive REJECTS a hand-edited / non-Signal file, exits non-zero, and leaves it byte-identical', () => {
  const { dir } = sandbox();
  const notSignal = path.join(dir, 'notes.md');
  const original = '# My Notes\n\n### Facts\n- a fact only I care about\n';
  fs.writeFileSync(notSignal, original);

  let threw = false;
  try {
    execFileSync('node', [CLI, 'archive', '--path', notSignal], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /does not look like a Signal state file/);
  }
  assert.ok(threw, 'archive must reject a file with no "# Signal State —" header');
  assert.equal(fs.readFileSync(notSignal, 'utf8'), original, 'the non-Signal file must be left byte-identical');
});

test('check REJECTS a hand-edited / non-Signal file rather than reporting empty counts', () => {
  const { dir } = sandbox();
  const notSignal = path.join(dir, 'notes.md');
  fs.writeFileSync(notSignal, '# My Notes\n\n### Facts\n- x\n');

  let threw = false;
  try {
    execFileSync('node', [CLI, 'check', '--path', notSignal], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /does not look like a Signal state file/);
  }
  assert.ok(threw, 'check must reject a non-Signal file rather than silently reporting 0 facts');
});

// --- Important 3: `brief` checked only that an enum param was present, never that its
// value was one of the allowed ones. `lens=totally-bogus` used to sail through. ---

test('brief REJECTS an out-of-enum param value, exits non-zero, and names the bad value plus the allowed set', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);

  let threw = false;
  try {
    execFileSync('node', [CLI, 'brief', 'research', 'lens=totally-bogus', '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /Invalid value "totally-bogus"/);
    assert.match(String(err.stderr), /regulatory/, 'must list the allowed values');
  }
  assert.ok(threw, 'brief must reject a param value outside the declared enum');
});

test('brief still accepts an in-enum value after the enum-validation fix', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const out = run(['brief', 'research', 'lens=regulatory', '--path', state]);
  assert.match(out, /\*\*lens:\*\* regulatory/);
});

// --- Important 5: ux-review's SKILL.md documented a briefing format composeBriefing
// never produces, and declared "Target" as required without the registry enforcing it.
// Fix: declare target as a required (free-form) param so the CLI enforces it. ---

test('brief REJECTS a ux-review dispatch with no target, exits non-zero, names the param', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);

  let threw = false;
  try {
    execFileSync('node', [CLI, 'brief', 'ux-review', '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /Missing required param "target"/);
  }
  assert.ok(threw, 'brief ux-review must refuse to compose a briefing with no target');
});

test('brief ux-review composes the real briefing once target is supplied', () => {
  const { state } = sandbox();
  run(['init', 'Test Product', '--path', state]);
  const out = run(['brief', 'ux-review', 'target=src/checkout', '--path', state]);
  assert.match(out, /## Briefing — ux-review/);
  assert.match(out, /\*\*target:\*\* src\/checkout/);
});

// --- Important 7: `init` against an existing product used to clobber it silently
// (same family as Critical 2 — a destructive write with no gate). ---

test('init REFUSES to overwrite an existing state file without --force, exits non-zero, leaves it untouched', () => {
  const { state } = sandbox();
  run(['init', 'Original Product', '--path', state]);
  run(['decide', 'a decision worth keeping', '--at', 'prd-freeze', '--path', state]);
  const before = fs.readFileSync(state, 'utf8');

  let threw = false;
  try {
    execFileSync('node', [CLI, 'init', 'Typo', '--path', state], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), /already exists/);
  }
  assert.ok(threw, 'init must refuse to overwrite an existing state file');
  assert.equal(fs.readFileSync(state, 'utf8'), before, 'existing state must be left untouched');
});

test('init --force overwrites an existing state file deliberately', () => {
  const { state } = sandbox();
  run(['init', 'Original Product', '--path', state]);
  run(['decide', 'a decision that will be wiped', '--at', 'prd-freeze', '--path', state]);
  run(['init', 'New Product', '--path', state, '--force']);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.product, 'New Product');
  assert.equal(s.decisions.length, 0, '--force starts from a genuinely blank state');
});

// ---- resolve / decide extensions ----
const STATE_RQ = `# Signal State — T
_Updated 2026-07-17 by pm_

## Phase
Discovery

## Facts
- a fact [source: user]

## Open Questions
- What is the retention window? [asked-by: x]
- Who signs off on pricing? [asked-by: y]
- Pricing tiers for exporters? [asked-by: y]

## Next
go
`;
function rqState(text = STATE_RQ) {
  const { dir, state } = sandbox();
  fs.writeFileSync(state, text);
  return { dir, state };
}
const fails = (args) => {
  try { execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT }); }
  catch (err) { return { code: err.status, stderr: String(err.stderr) }; }
  return null;
};

test('resolve removes the single Open Question containing the substring, case-insensitive', () => {
  const { state } = rqState();
  run(['resolve', 'RETENTION', '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.openQuestions.length, 2);
  assert.ok(!s.openQuestions.some(q => /retention/i.test(q)));
});

test('resolve exits 1 with a named reason on zero matches and on multiple matches, state untouched', () => {
  const { state } = rqState();
  const before = fs.readFileSync(state, 'utf8');
  const none = fails(['resolve', 'nonexistent', '--path', state]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no open question/i);
  const many = fails(['resolve', 'pricing', '--path', state]);
  assert.equal(many.code, 1);
  assert.match(many.stderr, /2 open questions|multiple|ambiguous/i);
  assert.equal(fs.readFileSync(state, 'utf8'), before);
});

test('decide rejects an unknown --at slug with a named reason and writes nothing', () => {
  const { state } = rqState();
  const before = fs.readFileSync(state, 'utf8');
  const r = fails(['decide', 'x', '--at', 'bogus', '--path', state]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bogus/);
  assert.match(r.stderr, /discovery-synthesis, prioritisation, prd-freeze, eng-plan, gtm-verdict/);
  assert.equal(fs.readFileSync(state, 'utf8'), before);
});

test('decide --at accepts each valid slug', () => {
  for (const slug of ['discovery-synthesis', 'prioritisation', 'prd-freeze', 'eng-plan', 'gtm-verdict']) {
    const { state } = rqState();
    run(['decide', 'ok', '--at', slug, '--path', state]);
    assert.match(fs.readFileSync(state, 'utf8'), new RegExp(`\\[at: ${slug}\\]`));
  }
});

test('decide --phase sets Phase and --resolves removes the matching Open Question', () => {
  const { state } = rqState();
  run(['decide', 'Ship v0', '--at', 'prd-freeze', '--phase', 'Build', '--resolves', 'retention', '--path', state]);
  const s = parseState(fs.readFileSync(state, 'utf8'));
  assert.equal(s.phase, 'Build');
  assert.equal(s.decisions.length, 1);
  assert.equal(s.openQuestions.length, 2);
});

test('decide --resolves with 0 or >1 matches exits 1 and records nothing', () => {
  const { state } = rqState();
  const before = fs.readFileSync(state, 'utf8');
  assert.equal(fails(['decide', 'd', '--at', 'prd-freeze', '--resolves', 'zzz', '--path', state]).code, 1);
  assert.equal(fails(['decide', 'd', '--at', 'prd-freeze', '--resolves', 'pricing', '--path', state]).code, 1);
  assert.equal(fs.readFileSync(state, 'utf8'), before);
});

// ---- archive reporting ----
test('archive prints counts; pinned facts alone over the limit are kept and check warns without failing', () => {
  const { dir, state } = sandbox();
  const facts = Array.from({ length: 32 }, (_, i) => `- pinned ${i} [source: ${i % 2 ? 'user' : 'setup'}]`).join('\n');
  fs.writeFileSync(state, `# Signal State — T\n_Updated x by pm_\n\n## Phase\nx\n\n## Facts\n${facts}\n\n## Next\nn\n`);
  const out = run(['archive', '--path', state, '--archive', path.join(dir, 'a.md')]);
  assert.match(out, /Nothing over the limit|Archived 0/i);
  assert.match(out, /32/);
  assert.equal(parseState(fs.readFileSync(state, 'utf8')).facts.length, 32);
  const chk = run(['check', '--path', state]);
  assert.match(chk, /PINNED/);
  assert.doesNotMatch(chk, /OVER LIMIT/);
});

test('archive prints "Archived N ... M remain" when trimming unpinned facts', () => {
  const { dir, state } = sandbox();
  const facts = Array.from({ length: 33 }, (_, i) => `- f${i} [source: t]`).join('\n');
  fs.writeFileSync(state, `# Signal State — T\n_Updated x by pm_\n\n## Phase\nx\n\n## Facts\n${facts}\n\n## Next\nn\n`);
  const out = run(['archive', '--path', state, '--archive', path.join(dir, 'a.md')]);
  assert.match(out, /Archived 3/);
  assert.match(out, /30/);
});

// ---- brief target= ----
test('brief target= replaces the Output path; for prd it drops the six frozen files', () => {
  const { state } = rqState();
  const out = run(['brief', 'prd', 'version=v1', 'target=.pm/prd-draft/prd.md', '--path', state]);
  assert.match(out, /\*\*Output:\*\* write `\.pm\/prd-draft\/prd\.md`/);
  assert.ok(!out.includes('.pm/prd/v1/'), 'frozen files must not be listed when target is given');
  const d = run(['brief', 'discovery', 'target=.pm/alt.md', '--path', state]);
  assert.ok(d.includes('`.pm/alt.md`') && !d.includes('.pm/discovery.md'));
});

// --- Phase 5: brief trims Facts ---

function stateWithFacts(facts) {
  return parseState(`# Signal State — T\n## Phase\nx\n## Facts\n${facts.map(f => `- ${f}`).join('\n')}\n## Decisions\n- 2026-01-01 — keep this decision [at: x]\n## Glossary\n- term: meaning\n## Open Questions\n- open one?\n## Next\ngo\n`);
}
const prdEntry = { ...registry.skills.prd, name: 'prd' };

test('brief trim keeps pinned, param-matching and newest 10 other facts, with a count line', () => {
  const facts = [
    'pinned user fact [source: user]',
    'pinned setup fact [source: setup]',
    'Refunds follow a strict window [source: research]',
    ...Array.from({ length: 15 }, (_, i) => `filler number ${i} [source: research]`),
  ];
  const b = composeBriefing(stateWithFacts(facts), prdEntry, { version: 'REFUNDS' });
  assert.match(b, /\*\*Facts:\*\*\n\(showing 13 of 18 facts; use --full for all\)/);
  assert.match(b, /pinned user fact/);
  assert.match(b, /pinned setup fact/);
  assert.match(b, /Refunds follow/, 'case-insensitive word match with a param value');
  assert.ok(!/filler number 4 /.test(b), 'older filler is dropped');
  assert.match(b, /filler number 5 /);
  assert.match(b, /filler number 14 /);
  assert.match(b, /keep this decision/);
  assert.match(b, /term: meaning/);
  assert.match(b, /open one\?/);
});

test('brief trim ignores words shorter than 4 and the source tag', () => {
  const facts = ['has abc word [source: research]', ...Array.from({ length: 11 }, (_, i) => `other ${i} [source: research]`)];
  const b = composeBriefing(stateWithFacts(facts), prdEntry, { version: 'abc source' });
  assert.ok(!/has abc word/.test(b));
});

test('brief --full disables the trim', () => {
  const { state } = sandbox();
  run(['init', 'T', '--path', state]);
  const facts = Array.from({ length: 14 }, (_, i) => `- filler ${i} [source: research]`).join('\n');
  fs.writeFileSync(state, fs.readFileSync(state, 'utf8').replace('## Facts\n', `## Facts\n${facts}\n`));
  const trimmed = run(['brief', 'prd', 'version=v0', '--path', state]);
  assert.match(trimmed, /\(showing 10 of 14 facts; use --full for all\)/);
  const full = run(['brief', 'prd', 'version=v0', '--full', '--path', state]);
  assert.match(full, /\(showing 14 of 14 facts/);
  assert.match(full, /filler 0 /);
});

test('run mode defaults to manual, set-mode auto persists, and other state survives', () => {
  const { state } = rqState();
  assert.equal(run(['mode', '--path', state]).trim(), 'manual');
  run(['set-mode', 'auto', '--path', state]);
  assert.equal(run(['mode', '--path', state]).trim(), 'auto');
  assert.match(fs.readFileSync(state, 'utf8'), /## Run Mode\nauto/);
  run(['phase', 'Draft — v1', '--path', state]);
  run(['decide', 'ok', '--at', 'prd-freeze', '--path', state]);
  assert.equal(run(['mode', '--path', state]).trim(), 'auto');
  run(['set-mode', 'manual', '--path', state]);
  assert.equal(run(['mode', '--path', state]).trim(), 'manual');
  assert.ok(!/## Run Mode/.test(fs.readFileSync(state, 'utf8')));
});

test('set-mode rejects an unknown mode and writes nothing', () => {
  const { state } = rqState();
  const before = fs.readFileSync(state, 'utf8');
  assert.equal(fails(['set-mode', 'turbo', '--path', state]).code, 1);
  assert.equal(fs.readFileSync(state, 'utf8'), before);
});

test('assume records a default as an open question, once', () => {
  const { state } = rqState();
  run(['assume', 'Target repo: acme_web', '--path', state]);
  run(['assume', 'Target repo: acme_web', '--path', state]);
  const qs = parseState(fs.readFileSync(state, 'utf8')).openQuestions.filter(q => q.startsWith('Assumed: Target repo'));
  assert.deepEqual(qs, ['Assumed: Target repo: acme_web [assumed-by: signal]']);
});
