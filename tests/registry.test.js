// tests/registry.test.js
// Layer 1 — contract lint. Registry <-> SKILL.md <-> debrief contract must agree.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/registry.json'), 'utf8'));
const entries = Object.entries(registry.skills);

const KINDS = ['spine', 'lifecycle', 'agent'];
const outputsOf = (e) => (Array.isArray(e.outputs) ? e.outputs : [e.outputs]);
const SECTIONS = ['phase', 'facts', 'decisions', 'glossary', 'openQuestions', 'artifacts', 'next'];

test('registry is non-empty and every entry is well formed', () => {
  assert.ok(entries.length >= 14, `expected >=14 skills, got ${entries.length}`);
  for (const [name, e] of entries) {
    assert.ok(KINDS.includes(e.kind), `${name}: bad kind "${e.kind}"`);
    assert.ok(!('engine' in e), `${name}: registry entries have no engine field`);
    assert.ok(e.purpose && e.purpose.length > 10, `${name}: purpose too short`);
    assert.ok(e.use_when && e.use_when.length > 10, `${name}: use_when too short`);
    assert.ok(Array.isArray(e.needs), `${name}: needs must be an array`);
    for (const n of e.needs) assert.ok(SECTIONS.includes(n), `${name}: unknown need "${n}"`);
    assert.ok(e.outputs === null || typeof e.outputs === 'string' ||
      (Array.isArray(e.outputs) && e.outputs.length > 0 && e.outputs.every(o => typeof o === 'string')),
      `${name}: bad outputs`);
  }
});

test('every registry entry points at a SKILL.md that exists', () => {
  for (const [name, e] of entries) {
    assert.ok(fs.existsSync(path.join(ROOT, e.path)), `${name}: missing ${e.path}`);
  }
});

test('every SKILL.md on disk is declared in the registry', () => {
  const declared = new Set(entries.map(([, e]) => e.path));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name))
      : d.name === 'SKILL.md' ? [path.relative(ROOT, path.join(dir, d.name))] : []);
  for (const f of walk(path.join(ROOT, 'skills'))) {
    assert.ok(declared.has(f), `${f} exists on disk but is not in registry.json`);
  }
});

test('every agent SKILL.md documents Briefing input and Debrief output with all required fields', () => {
  for (const [name, e] of entries) {
    if (e.kind === 'spine') continue;
    const text = fs.readFileSync(path.join(ROOT, e.path), 'utf8');
    assert.match(text, /## Briefing/, `${name}: missing "## Briefing" section`);
    assert.match(text, /## Debrief/, `${name}: missing "## Debrief" section`);
    for (const field of ['Artifact', 'Digest', 'Learned', 'Suggested next']) {
      assert.ok(text.includes(`**${field}:**`), `${name}: debrief missing **${field}:**`);
    }
  }
});

test('params declared in the registry are documented in the SKILL.md', () => {
  for (const [name, e] of entries) {
    if (!e.params) continue;
    const text = fs.readFileSync(path.join(ROOT, e.path), 'utf8');
    for (const p of Object.keys(e.params)) {
      assert.ok(text.includes(p), `${name}: param "${p}" not documented in ${e.path}`);
    }
  }
});

test('every declared output path is under .pm/ and appears in its SKILL.md', () => {
  for (const [name, e] of entries) {
    if (!e.outputs) continue;
    const text = fs.readFileSync(path.join(ROOT, e.path), 'utf8');
    for (const out of outputsOf(e)) {
      assert.ok(out.startsWith('.pm/'),
        `${name}: outputs "${out}" is outside .pm/`);
      // Compare the literal prefix before any {param} placeholder, so templated
      // paths match the stem the SKILL.md actually names.
      const stem = out.split('{')[0];
      assert.ok(text.includes(stem),
        `${name}: SKILL.md never mentions its declared output path "${stem}"`);
    }
  }
});

test('every {param} in an outputs template is declared in that entry\'s params', () => {
  for (const [name, e] of entries) {
    if (!e.outputs) continue;
    const placeholders = outputsOf(e).flatMap(o => [...o.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
    for (const p of placeholders) {
      assert.ok(e.params && Object.prototype.hasOwnProperty.call(e.params, p),
        `${name}: outputs ${JSON.stringify(e.outputs)} references {${p}} but "${p}" is not declared in params`);
    }
  }
});

test('registry key matches the skill\'s own directory name', () => {
  for (const [name, e] of entries) {
    const dir = path.basename(path.dirname(e.path));
    assert.equal(dir, name, `registry key "${name}" does not match its directory name "${dir}" (${e.path})`);
  }
});

// The roster is declared in the registry and CLAUDE.md. This keeps CLAUDE.md in sync.
test('CLAUDE.md @-includes every registry skill, and nothing else', () => {
  const registryPaths = new Set(entries.map(([, e]) => e.path));
  for (const doc of ['CLAUDE.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    const includes = [...text.matchAll(/^@(skills\/\S+)$/gm)].map(m => m[1]);
    assert.ok(includes.length > 0, `${doc}: found no "@skills/..." includes at all`);
    for (const p of registryPaths) {
      assert.ok(includes.includes(p), `${doc}: missing "@${p}" — every registered skill must be included`);
    }
    for (const inc of includes) {
      assert.ok(registryPaths.has(inc), `${doc}: includes "@${inc}" which is not declared in skills/registry.json`);
    }
  }
});

test('no skill, script, or README references a deleted tool', () => {
  const DENY = ['linear', 'playwright', 'browserbase', 'figma', 'ffmpeg', 'whisper',
    'mixpanel', 'amplitude', 'slack', 'clickup', 'notion', 'jira',
    'tavily', 'jina', 'firecrawl', 'mcp', 'product-context'];
  const files = [
    ...entries.map(([, e]) => e.path),
    ...fs.readdirSync(path.join(ROOT, 'scripts')).map(f => `scripts/${f}`),
    'README.md',
  ];
  for (const f of files) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8').toLowerCase();
    for (const term of DENY) {
      assert.ok(!text.includes(term), `${f} still references deleted tool "${term}"`);
    }
  }
});

test('every agent SKILL.md shows the "## Debrief — name" heading inside the block it asks for', () => {
  // Regression guard. The template used to present "## Debrief" as its own section
  // heading and then show the block starting at **Artifact:**, so an agent copying
  // "the block" faithfully emitted no heading — and state.js merge rejected it.
  // Two independent agents hit this on the first real run.
  for (const [name, e] of entries) {
    if (e.kind === 'spine') continue;
    const text = fs.readFileSync(path.join(ROOT, e.path), 'utf8');
    assert.ok(text.includes(`## Debrief — ${name}`),
      `${name}: SKILL.md must show the literal heading "## Debrief — ${name}" in the block it tells the agent to emit`);
  }
});

test('registry needs cover what each skill reads from state', () => {
  const EXPECT = {
    discovery: ['decisions', 'artifacts'],
    prioritize: ['glossary', 'openQuestions'],
    prd: ['openQuestions'],
    'ux-review': ['artifacts'],
    'ac-agent': ['glossary', 'decisions'],
    metrics: ['glossary'],
    'maintain-context': ['glossary', 'openQuestions', 'next'],
  };
  for (const [name, needs] of Object.entries(EXPECT)) {
    for (const n of needs) {
      assert.ok(registry.skills[name].needs.includes(n), `${name}: needs must include "${n}"`);
    }
  }
});

test('registry outputs match the files each skill writes', () => {
  const s = registry.skills;
  assert.equal(s['maintain-context'].outputs, '.pm/handoff.md');
  assert.equal(s.setup.outputs, null);
  assert.equal(s['ac-agent'].outputs, '.pm/prd/{version}/acceptance-criteria.md');
  assert.deepEqual(s['ac-agent'].params, { version: ['v0', 'v1', 'v2'] });
  assert.deepEqual(s.prd.outputs, [
    '.pm/prd/{version}/prd.md',
    '.pm/prd/{version}/acceptance-criteria.md',
    '.pm/prd/{version}/metrics.md',
    '.pm/prd/{version}/CHANGELOG.md',
    '.pm/prd/{version}/one-pager.md',
    '.pm/prd/{version}/story-map.md',
  ]);
});

test('setup purpose names what setup writes: state.md, Facts and Glossary', () => {
  const p = registry.skills.setup.purpose;
  assert.match(p, /state\.md/);
  assert.match(p, /Facts/);
  assert.match(p, /Glossary/);
});

test('every registry entry declares a tier of fast or deep', () => {
  for (const [name, e] of entries) {
    assert.ok(['fast', 'deep'].includes(e.tier), `${name}: bad tier "${e.tier}"`);
  }
  const deep = ['red-team', 'data-model', 'review-zoom-out', 'review-design', 'review-readiness', 'review-codebase', 'task-reviewer', 'backend-review', 'gtm-check'];
  for (const [name, e] of entries) assert.equal(e.tier, deep.includes(name) ? 'deep' : 'fast', `${name}: wrong tier`);
});

test('Signal is Claude-only: no second engine and no engine field anywhere', () => {
  const g = 'gem' + 'ini';
  assert.ok(!fs.existsSync(path.join(ROOT, `${g.toUpperCase()}.md`)));
  assert.ok(!fs.existsSync(path.join(ROOT, `scripts/${g}.js`)));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  const files = [...walk(path.join(ROOT, 'skills')), ...walk(path.join(ROOT, 'scripts')),
    path.join(ROOT, 'README.md'), path.join(ROOT, 'CLAUDE.md')];
  for (const f of files) {
    assert.ok(!new RegExp('gem' + 'ini', 'i').test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)} mentions the removed engine`);
  }
  assert.equal(registry.skills.research.tier, 'fast');
});

test('tickets agent is a standard agent that writes the versioned ticket', () => {
  const t = registry.skills.tickets;
  assert.equal(t.kind, 'agent');
  assert.equal(t.tier, 'fast');
  assert.equal(t.outputs, '.pm/prd/{version}/ticket.md');
  assert.deepEqual(t.params, { version: ['v0', 'v1', 'v2'] });
});

test('ground and inventory are standard agents with the evidence and existing-work outputs', () => {
  const s = registry.skills;
  assert.ok(entries.length >= 18, `expected >=18 skills, got ${entries.length}`);
  for (const [n, out] of [['ground', '.pm/evidence.md'], ['inventory', '.pm/existing.md']]) {
    assert.equal(s[n].kind, 'agent');
    assert.equal(s[n].tier, 'fast');
    assert.equal(s[n].outputs, out);
    assert.ok(s[n].use_when && s[n].purpose && Array.isArray(s[n].needs));
  }
});

test('ground and inventory skills carry their contract rules', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const g = read('skills/agents/ground/SKILL.md');
  for (const needle of ['.pm/refs.json', 'git grep', 'Never `checkout`', 'never `fetch`', 'NOT FOUND', '**Searched:**', '**Ref:**', 'pinned commit']) {
    assert.ok(g.includes(needle), `ground must mention "${needle}"`);
  }
  const i = read('skills/agents/inventory/SKILL.md');
  for (const needle of ['tracker adapter', 'three closest', 'overlaps, contradicts, extends, supersedes or unrelated', 'Duplicate check:', 'Scanned:']) {
    assert.ok(i.includes(needle), `inventory must mention "${needle}"`);
  }
});

test('discovery, tickets, prd and pm wire in the new gates', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const need = (f, list) => { const t = read(f); for (const n of list) assert.ok(t.includes(n), `${f} must mention "${n}"`); };
  need('skills/discovery/SKILL.md', ['frame', '.pm/concepts_brief.md', '[unconfirmed]']);
  need('skills/agents/tickets/SKILL.md', ['Hard gate', '.pm/existing.md', 'unresolved overlap']);
  need('skills/prd/SKILL.md', ['dispatch ground', 'Current state', 'concepts_brief.md', 'ONE question', 'Assumptions']);
  need('skills/pm/SKILL.md', ['## Preflight', '## Sample first', '## Gates', 'three sample rows', '.pm/refs.json', 'unresolved overlap', '[Director] Route:']);
});

test('review agents, synthesizer and resolve are registered with a SKILL.md and a Debrief block', () => {
  const reviewers = ['review-zoom-out', 'review-comprehension', 'review-design', 'review-structural',
    'review-style', 'review-readiness', 'review-codebase'];
  for (const n of [...reviewers, 'review-synthesizer']) {
    const e = registry.skills[n];
    assert.ok(e, `${n}: not in registry`);
    assert.equal(e.kind, 'agent');
    assert.ok(['fast', 'deep'].includes(e.tier), `${n}: bad tier`);
    assert.ok(e.use_when && e.purpose, `${n}: needs use_when and purpose`);
    const text = fs.readFileSync(path.join(ROOT, e.path), 'utf8');
    assert.ok(text.includes(`## Debrief — ${n}`), `${n}: missing Debrief block`);
    assert.match(text, /## Briefing/);
  }
  for (const n of reviewers) assert.equal(registry.skills[n].outputs, null, `${n}: reviewers return findings inline`);
  assert.equal(registry.skills['review-synthesizer'].tier, 'fast');
  assert.equal(registry.skills['review-synthesizer'].outputs, '.pm/review/{stage}.md');
  assert.ok(fs.existsSync(path.join(ROOT, registry.skills.resolve.path)));
  assert.ok(!registry.skills['pm-critic'], 'pm-critic is retired');
  assert.ok(!fs.existsSync(path.join(ROOT, 'skills/agents/pm-critic')));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').includes('pm-critic'));
  assert.ok(registry.skills['review-synthesizer'].params.stage.includes('brainstorm'));
});

test('reviewers are read-only, stateless and the codebase reviewer uses the evidence file', () => {
  const read = (n) => fs.readFileSync(path.join(ROOT, registry.skills[n].path), 'utf8');
  for (const n of ['review-zoom-out', 'review-comprehension', 'review-design', 'review-structural',
    'review-style', 'review-readiness', 'review-codebase']) {
    const t = read(n);
    for (const needle of ['Read-only', 'Fresh context', 'No chitchat', 'stateless']) {
      assert.ok(t.includes(needle), `${n} must mention "${needle}"`);
    }
  }
  const c = read('review-codebase');
  for (const needle of ['.pm/evidence.md', '.pm/refs.json', 'git grep', 'Never `checkout`', 'never `fetch`']) {
    assert.ok(c.includes(needle), `review-codebase must mention "${needle}"`);
  }
});

test('resolve carries its rules and the standards and notice exist', () => {
  const t = fs.readFileSync(path.join(ROOT, 'skills/resolve/SKILL.md'), 'utf8');
  for (const needle of ['CONTEST', 'ESCALATE', 'PROPOSE FIX', 'DECLINE', 'Never contest a comprehension gap',
    'Never change a severity', 'One re-audit per stage', 'One question per turn']) {
    assert.ok(t.includes(needle), `resolve must mention "${needle}"`);
  }
  for (const f of ['feature-spec.md', 'implementation-readiness.md', 'zoom-out.md', 'NOTICE.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'skills/standards', f)), `missing skills/standards/${f}`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'skills/standards/NOTICE.md'), 'utf8'), /Apache-2\.0/);
});

test('no file under skills/, scripts/ or README.md names the retired small model', () => {
  const word = 'hai' + 'ku';
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full);
      else if (fs.readFileSync(full, 'utf8').toLowerCase().includes(word)) hits.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'skills'));
  walk(path.join(ROOT, 'scripts'));
  if (fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').toLowerCase().includes(word)) hits.push('README.md');
  assert.deepEqual(hits, []);
});

test('signal is the single-trigger entry skill, fast tier, in the main session', () => {
  const s = registry.skills.signal;
  assert.equal(s.kind, 'spine');
  assert.equal(s.tier, 'fast');
  assert.equal(s.path, 'skills/signal/SKILL.md');
  const text = fs.readFileSync(path.join(ROOT, s.path), 'utf8');
  for (const needle of ['set-mode auto', 'state.js assume', 'prd-freeze', 'pr-ship.js plan', 'Hard stops', 'Nothing is pushed']) {
    assert.ok(text.includes(needle), `signal must mention "${needle}"`);
  }
  for (const f of ['skills/pm/SKILL.md', 'skills/eng/SKILL.md', 'skills/prd/SKILL.md', 'skills/setup/SKILL.md']) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes('auto mode'), `${f} must read the run mode`);
  }
});
