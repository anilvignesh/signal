// scripts/state.js
// Director-owned living context (.pm/state.md): parse, merge debriefs, enforce limits, render.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addMistake, readMistakes, rulesFor, ensureMistakesFile, globalPath } from './mistakes.js';

const FACT_LIMIT = 30;
const SECTIONS = ['Phase', 'Run Mode', 'Facts', 'Decisions', 'Glossary', 'Open Questions', 'Artifacts', 'Next'];

// Split a state.md into a { Phase, Facts, ... } map of raw section bodies.
function splitSections(text) {
  const bodies = {};
  const parts = text.split(/^## /m);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const heading = part.slice(0, nl).trim();
    if (SECTIONS.includes(heading)) bodies[heading] = part.slice(nl + 1).replace(/\s+$/, '');
  }
  return bodies;
}

// Bullet lines ("- ...") from a section body, trimmed of the leading marker.
function bullets(body) {
  if (!body) return [];
  return body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim())
    .filter(Boolean);
}

// Table rows (skipping header + separator) from an Artifacts section body.
function artifactRows(body) {
  if (!body) return [];
  return body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l) && !/^\|\s*File\s*\|/i.test(l))
    .map(l => {
      const cells = l.split('|').slice(1, -1).map(c => c.trim());
      return { file: cells[0] || '', digest: cells[1] || '', updated: cells[2] || '' };
    })
    .filter(r => r.file);
}

// `renderState` always emits this header, so every legitimate state.md matches it.
// A file that doesn't — hand-edited, a heading typo, or simply the wrong file —
// must never be parsed as if it were empty Signal state: `splitSections` silently
// drops any heading it doesn't recognise, so parsing an unrecognised file yields a
// plausible-looking but empty state, and a subsequent write would overwrite the
// original content with that empty shell. Callers that are about to WRITE a state
// file (merge, archive, decide, phase) must call this first and refuse.
const SIGNAL_STATE_HEADER = /^#\s*Signal State\s*—/;

export function isSignalStateFile(text) {
  return SIGNAL_STATE_HEADER.test(text || '');
}

// Thrown by callers below when a target file exists but doesn't look like Signal
// state. A distinct name so callers (the CLI) can catch it specifically rather
// than swallowing every other error the same way.
export class NotSignalStateError extends Error {}

function assertSignalStateFile(text, sourcePath) {
  if (!isSignalStateFile(text)) {
    throw new NotSignalStateError(
      `${sourcePath} does not look like a Signal state file (missing the "# Signal State — <product>" ` +
      `header that renderState always writes) — refusing to modify it. If this file predates Signal, ` +
      `move it aside; do not point state.js at it.`
    );
  }
}

export function parseState(text) {
  const s = splitSections(text || '');
  return {
    product: (text.match(/^#\s*Signal State\s*—\s*(.+)$/m) || [])[1]?.trim() || '',
    phase: (s['Phase'] || '').trim(),
    runMode: ((s['Run Mode'] || '').trim().toLowerCase()) === 'auto' ? 'auto' : 'manual',
    facts: bullets(s['Facts']),
    decisions: bullets(s['Decisions']),
    glossary: bullets(s['Glossary']),
    openQuestions: bullets(s['Open Questions']),
    artifacts: artifactRows(s['Artifacts']),
    next: (s['Next'] || '').trim(),
  };
}

// Placeholder values an agent writes instead of leaving a list empty.
const isEmptyItem = (x) => !x || /^(none|n\/a)$/i.test(x.trim());

// Read a labelled field's list, handling three shapes:
//   **Label:** none          -> []
//   **Label:** single value   -> ['single value']
//   **Label:**\n- a\n- b      -> ['a','b']
function listField(text, label) {
  const inlineRe = new RegExp(`\\*\\*${label}:\\*\\*[ \\t]*([^\\n]*)`, 'i');
  const inline = ((text.match(inlineRe) || [])[1] || '').trim().replace(/^-\s*/, '').replace(/^-$/, '').trim();
  if (inline && isEmptyItem(inline)) return [];
  const blockRe = new RegExp(`\\*\\*${label}:\\*\\*[^\\n]*\\n([\\s\\S]*)`, 'i');
  const rest = (text.match(blockRe) || [])[1] || '';
  // Stop at the first line that opens a new field or section. A label with no
  // bullets beneath it must yield [] — never the following field's bullets.
  const own = [];
  for (const line of rest.split('\n')) {
    if (/^\s*(\*\*|##)/.test(line)) break;
    own.push(line);
  }
  const items = bullets(own.join('\n')).filter(i => !isEmptyItem(i));
  if (items.length) return items;
  return isEmptyItem(inline) ? [] : [inline];
}

// Parse a Debrief block (the fixed format every skill/agent ends with) into fields.
export function parseDebrief(text) {
  const src = text || '';
  // [ \t]* (not \s*) is intentional: the debrief is a fixed same-line format,
  // so a value placed on the line after its label must NOT be captured —
  // that shape is malformed input and should report the field as missing.
  const field = (label) => {
    const m = src.match(new RegExp(`\\*\\*${label}:\\*\\*[ \\t]*(.+)`, 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    artifact: field('Artifact'),
    digest: field('Digest'),
    learned: listField(src, 'Learned'),
    terms: listField(src, 'Terms'),
    openQuestions: listField(src, 'Open questions for user'),
    next: field('Suggested next'),
    hasAssumptions: /\*\*Assumptions \(proposals\):\*\*/i.test(src),
    assumptions: listField(src, 'Assumptions \\(proposals\\)'),
    files: listField(src, 'Files').map(item => {
      const i = item.indexOf(' — ');
      return i < 0 ? { file: item.trim(), digest: '' } : { file: item.slice(0, i).trim(), digest: item.slice(i + 3).trim() };
    }).filter(f => f.file),
  };
}

// Hard gate. A debrief that does not satisfy this contract must never reach mergeDebrief.
export function validateDebrief(text) {
  const src = text || '';
  if (!/^##\s*Debrief/im.test(src)) {
    return { ok: false, errors: ['no "## Debrief" block found in agent output'], debrief: null };
  }
  const d = parseDebrief(src);
  const errors = [];
  if (!d.artifact) errors.push('missing **Artifact:** (use "none" if the agent wrote no file)');
  if (!d.digest) errors.push('missing **Digest:**');
  const wroteNothing = /^none$/i.test(d.artifact);
  if (!d.learned.length && !wroteNothing) errors.push('missing or empty **Learned:** list (optional only when Artifact is "none")');
  if (!d.next) errors.push('missing **Suggested next:**');
  return { ok: errors.length === 0, errors, debrief: errors.length ? null : d };
}

// Merge a validated debrief into a parsed state. Pure — never mutates `state`.
export function mergeDebrief(state, debrief, opts = {}) {
  const today = opts.date || 'unknown';
  const next = {
    ...state,
    facts: [...state.facts],
    decisions: [...state.decisions],
    glossary: [...(state.glossary || [])],
    openQuestions: [...state.openQuestions],
    artifacts: [...state.artifacts],
  };

  for (const l of debrief.learned || []) {
    if (l && !next.facts.includes(l)) next.facts.push(l);
  }

  // Glossary upserts by term name — the text before the first em dash.
  const termName = (t) => t.split('—')[0].trim().toLowerCase();
  for (const t of debrief.terms || []) {
    if (!t) continue;
    const i = next.glossary.findIndex(g => termName(g) === termName(t));
    if (i >= 0) next.glossary[i] = t; else next.glossary.push(t);
  }

  const upsertArtifact = (file, digest) => {
    next.artifacts = next.artifacts.filter(a => a.file !== file);
    next.artifacts.push({ file, digest: digest || '', updated: today });
  };
  if (debrief.artifact && !/^none$/i.test(debrief.artifact)) {
    upsertArtifact(debrief.artifact, debrief.digest);
    // A frozen PRD supersedes its drafts.
    if (debrief.artifact.startsWith('.pm/prd/')) {
      next.artifacts = next.artifacts.filter(a => !a.file.startsWith('.pm/prd-draft/'));
    }
  }
  for (const f of debrief.files || []) upsertArtifact(f.file, f.digest);

  for (const q of debrief.openQuestions || []) {
    if (q && !next.openQuestions.includes(q)) next.openQuestions.push(q);
  }

  // A proposed default is never a decision: it becomes an open question the user must answer.
  const by = opts.skill || 'unknown';
  for (const a of debrief.assumptions || []) {
    const text = (a || '').replace(/\s*\[assumed-by:[^\]]*\]\s*$/, '').trim();
    if (!text) continue;
    const q = `Assumed: ${text} [assumed-by: ${by}]`;
    if (!next.openQuestions.includes(q)) next.openQuestions.push(q);
  }

  if (debrief.next) next.next = debrief.next;
  return next;
}

// Record a checkpoint decision. This is the only writer of `## Decisions`.
export function addDecision(state, text, opts = {}) {
  const entry = `${opts.date || 'unknown'} — ${text} [at: ${opts.at || 'checkpoint'}]`;
  if (state.decisions.includes(entry)) return state;
  return { ...state, decisions: [...state.decisions, entry] };
}

// Remove the one Open Question containing `substring` (case-insensitive).
// Returns { state } or { error } naming why it could not.
export function resolveQuestion(state, substring) {
  const needle = (substring || '').toLowerCase();
  const hits = needle ? state.openQuestions.filter(q => q.toLowerCase().includes(needle)) : [];
  if (hits.length === 0) return { error: `no open question contains "${substring}"` };
  if (hits.length > 1) {
    return { error: `${hits.length} open questions contain "${substring}" — be more specific:\n${hits.map(h => `  - ${h}`).join('\n')}` };
  }
  return { state: { ...state, openQuestions: state.openQuestions.filter(q => q !== hits[0]) } };
}

export const DECISION_CHECKPOINTS = ['discovery-synthesis', 'prioritisation', 'prd-freeze', 'eng-plan', 'gtm-verdict'];

export const RUN_MODES = ['manual', 'auto'];

// Record a default the Director took in the user's place. It stays an open question until the user sees it.
export function addAssumption(state, text, by = 'signal') {
  const q = `Assumed: ${(text || '').trim()} [assumed-by: ${by}]`;
  if (state.openQuestions.includes(q)) return state;
  return { ...state, openQuestions: [...state.openQuestions, q] };
}

// Facts from the user or setup are never trimmed.
const isPinned = (f) => /\[source:\s*(user|setup)\s*\]\s*$/.test(f);

// A fact is referenced when a Decision or Open Question quotes its text
// (ignoring the trailing [source: …] tag).
function referencedFacts(state) {
  const haystack = [...state.decisions, ...state.openQuestions].join('\n').toLowerCase();
  const stem = (f) => f.replace(/\s*\[source:[^\]]*\]\s*$/, '').trim().toLowerCase();
  return new Set(state.facts.filter(f => stem(f) && haystack.includes(stem(f))));
}

// Trim facts to `max`, oldest first, skipping facts a Decision or Open Question
// references and facts tagged [source: user] or [source: setup]. If those alone
// exceed `max`, all of them stay.
export function enforceFactLimit(state, max = FACT_LIMIT) {
  if (state.facts.length <= max) return { state, archived: [] };
  const keep = referencedFacts(state);
  for (const f of state.facts) if (isPinned(f)) keep.add(f);
  let toDrop = state.facts.length - max;
  const archived = [];
  const kept = [];
  for (const f of state.facts) {
    if (toDrop > 0 && !keep.has(f)) { archived.push(f); toDrop--; } else kept.push(f);
  }
  return { state: { ...state, facts: kept }, archived };
}

// Every state write goes through here — a crash mid-write must never leave a partial state.md.
export function writeStateAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Any failure in either step (write or rename) must leave no partial
    // write behind for the next run to trip over. Safe even if the write
    // itself never created tmp — rmSync({ force: true }) tolerates a missing path.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// The set of fact bullets already recorded in the archive file, so a retried
// append can be made idempotent instead of duplicating entries.
function archivedFactSet(archivePath) {
  if (!fs.existsSync(archivePath)) return new Set();
  return new Set(bullets(fs.readFileSync(archivePath, 'utf8')));
}

// Trim facts over the limit and write them to the archive.
//
// Append first, then rewrite state: if the rewrite fails, the archive already
// holds the facts and nothing is lost. A retry re-selects the same facts, so the
// append skips any fact already in the archive.
//
// `{ archived, facts }` is what was trimmed from state.md this call, not what
// was newly appended to archive.md.
export function archiveFacts(statePath, archivePath, opts = {}) {
  const max = opts.max ?? FACT_LIMIT;
  const date = opts.date || 'unknown';
  const raw = fs.readFileSync(statePath, 'utf8');
  assertSignalStateFile(raw, statePath);
  const state = parseState(raw);
  const { state: trimmed, archived } = enforceFactLimit(state, max);
  if (archived.length === 0) return { archived: 0, facts: [], remaining: state.facts.length };

  const already = archivedFactSet(archivePath);
  const newFacts = archived.filter(a => !already.has(a));
  if (newFacts.length > 0) {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const block = `\n## Archived ${date}\n\n${newFacts.map(a => `- ${a}`).join('\n')}\n`;
    fs.appendFileSync(archivePath, block);
  }
  // Always rewrite state, even if every fact was already archived (a retry) —
  // the facts are already safely archived, and the trim must still happen.
  writeStateAtomic(statePath, renderState(trimmed, { skill: 'maintain-context', date }));
  return { archived: archived.length, facts: archived, remaining: trimmed.facts.length };
}

export function renderState(state, opts = {}) {
  const skill = opts.skill || '{skill}';
  const date = opts.date || 'unknown';
  const artifactRowsMd = state.artifacts.length
    ? state.artifacts.map(a => `| ${a.file} | ${a.digest} | ${a.updated} |`).join('\n')
    : '';
  const list = (arr) => (arr.length ? arr.map(x => `- ${x}`).join('\n') : '');
  return [
    `# Signal State — ${state.product || '{product}'}`,
    `_Updated ${date} by ${skill}_`,
    '',
    '## Phase',
    state.phase || '',
    '',
    ...(state.runMode === 'auto' ? ['## Run Mode', 'auto', ''] : []),
    '## Facts',
    list(state.facts),
    '',
    '## Decisions',
    list(state.decisions),
    '',
    '## Glossary',
    list(state.glossary || []),
    '',
    '## Open Questions',
    list(state.openQuestions),
    '',
    '## Artifacts',
    '| File | Digest | Updated |',
    '|---|---|---|',
    artifactRowsMd,
    '',
    '## Next',
    state.next || '',
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

const SECTION_RENDERERS = {
  phase: (s) => `**Phase:** ${s.phase || '(not set)'}`,
  facts: (s) => `**Facts:**\n${s.facts.length ? s.facts.map(f => `- ${f}`).join('\n') : '- (none yet)'}`,  // used only when there are no facts; composeBriefing renders the trimmed list
  decisions: (s) => `**Decisions:**\n${s.decisions.length ? s.decisions.map(d => `- ${d}`).join('\n') : '- (none yet)'}`,
  glossary: (s) => `**Glossary:**\n${(s.glossary || []).length ? s.glossary.map(g => `- ${g}`).join('\n') : '- (none yet)'}`,
  openQuestions: (s) => `**Open questions:**\n${s.openQuestions.length ? s.openQuestions.map(q => `- ${q}`).join('\n') : '- (none)'}`,
  artifacts: (s) => `**Artifacts:**\n${s.artifacts.length ? s.artifacts.map(a => `- ${a.file} — ${a.digest}`).join('\n') : '- (none yet)'}`,
  next: (s) => `**Next:** ${s.next || '(not set)'}`,
};

// Substitute {param} placeholders in a registry `outputs` template. `outputs`
// is a path, an array of paths, or null.
export function resolveOutputPaths(entry, params = {}) {
  if (!entry || !entry.outputs) return [];
  const list = Array.isArray(entry.outputs) ? entry.outputs : [entry.outputs];
  return list.map(o => o.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`));
}

// The primary output path (the first one), or null.
export function resolveOutputPath(entry, params = {}) {
  return resolveOutputPaths(entry, params)[0] ?? null;
}

// Deterministic briefing: the registry decides WHICH sections, this renders them in full.
// The Director trims individual fact bullets for relevance before dispatching.
const BRIEF_NEWEST = 10;
const wordsOf = (t) => (String(t).toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length >= 4);

// Facts for a briefing: pinned ([source: user|setup]), facts sharing a word with a param
// value, and the newest BRIEF_NEWEST of the rest. Order is preserved.
export function trimFacts(facts, params = {}) {
  const wanted = new Set(Object.values(params).flatMap(wordsOf));
  const keep = new Set();
  const others = [];
  for (const f of facts) {
    const body = f.replace(/\s*\[source:[^\]]*\]\s*$/, '');
    if (isPinned(f) || wordsOf(body).some(w => wanted.has(w))) keep.add(f);
    else others.push(f);
  }
  for (const f of others.slice(-BRIEF_NEWEST)) keep.add(f);
  return facts.filter(f => keep.has(f));
}

export function composeBriefing(state, entry, params = {}, opts = {}) {
  const lines = [`## Briefing — ${entry.name || 'agent'}`, `**Purpose:** ${entry.purpose}`];
  for (const [k, v] of Object.entries(params)) lines.push(`**${k}:** ${v}`);
  for (const need of entry.needs || []) {
    const render = SECTION_RENDERERS[need];
    if (need === 'facts' && state.facts.length) {
      const shown = opts.full ? state.facts : trimFacts(state.facts, params);
      lines.push('', `**Facts:**\n(showing ${shown.length} of ${state.facts.length} facts; use --full for all)\n` +
        shown.map(f => `- ${f}`).join('\n'));
    } else if (render) lines.push('', render(state));
  }
  const rules = [...(opts.rules?.project || []), ...(opts.rules?.global || [])];
  if (rules.length) lines.push('', `**Rules from past mistakes:**\n${rules.map(r => `- ${r}`).join('\n')}`);
  lines.push('', '**Language:** write in simple English. Short sentences, common words. Explain any jargon in a few words.');
  // An entry that declares `target` as its own param (ux-review: the code under
  // review) keeps its outputs; for every other entry target= is the output path.
  const overrides = params.target && !(entry.params && 'target' in entry.params);
  const outs = overrides ? [params.target] : resolveOutputPaths(entry, params);
  lines.push('', outs.length
    ? `**Output:** write ${outs.map(o => `\`${o}\``).join(', ')}; end with a Debrief block.`
    : `**Output:** return your result inline; end with a Debrief block.`);
  return lines.join('\n') + '\n';
}

// ---- Product style and refs files (.pm/style.json, .pm/refs.json) ----
const isStrList = (v) => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim());
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

const PROJECT_FILES = {
  style: {
    file: 'style.json',
    keys: {
      banned_words: isStrList,
      banned_patterns: (v) => isStrList(v) && v.every(p => { try { new RegExp(p); return true; } catch { return false; } }),
      status_words: isStrList,
      required_lines: isStrList,
      table_columns: (v) => v && typeof v === 'object' && !Array.isArray(v) &&
        Object.values(v).every(n => Number.isInteger(n) && n > 0),
    },
  },
  refs: {
    file: 'refs.json',
    keys: {
      deployed_ref: isStr,
      pinned_commit: isStr,
      other_refs: isStrList,
      open_changes: isStrList,
      search_areas: isStrList,
      repos: (v) => Array.isArray(v) && v.every(r => r && typeof r === 'object' && isStr(r.name) && isStr(r.path)),
    },
  },
};

// Check a style/refs object. Returns a list of problems (empty = valid). Unknown top-level keys are refused.
export function validateProjectFile(kind, obj) {
  const spec = PROJECT_FILES[kind];
  if (!spec) return [`unknown file kind "${kind}"`];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['must be a JSON object'];
  const errors = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!spec.keys[k]) errors.push(`unknown key "${k}" — allowed: ${Object.keys(spec.keys).join(', ')}`);
    else if (!spec.keys[k](v)) errors.push(`bad value for "${k}"`);
  }
  return errors;
}

// Merge a patch into an existing object. Scalars replace; lists add new items; maps and repos merge by key.
export function mergeProjectFile(kind, base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'table_columns') out[k] = { ...(out[k] || {}), ...v };
    else if (k === 'repos') {
      const repos = [...(out[k] || [])];
      for (const r of v) {
        const i = repos.findIndex(x => x.name === r.name);
        if (i >= 0) repos[i] = r; else repos.push(r);
      }
      out[k] = repos;
    } else if (Array.isArray(v)) out[k] = [...new Set([...(out[k] || []), ...v])];
    else out[k] = v;
  }
  return out;
}

function projectFileCli(kind, argv, rest, statePath) {
  const file = path.join(path.dirname(statePath), PROJECT_FILES[kind].file);
  const [sub] = positionals(rest);
  const usage = `Usage: state.js ${kind} <init|merge|show> ['<json>' | --file <patch.json>] [--path <state.md>]`;
  const read = () => {
    if (!fs.existsSync(file)) return {};
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  if (sub === 'show') {
    if (!fs.existsSync(file)) { console.error(`No ${file} — run: state.js ${kind} init`); return 1; }
    process.stdout.write(fs.readFileSync(file, 'utf8'));
    return 0;
  }
  if (sub === 'init') {
    if (positionals(rest).length > 1 || flag(argv, 'file', '')) {
      console.error('init takes no JSON; use: state.js <refs|style> merge \'<json>\'');
      return 2;
    }
    if (fs.existsSync(file) && !argv.includes('--force')) {
      console.error(`${file} already exists — use "${kind} merge" to change it, or pass --force to reset it.`);
      return 1;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeStateAtomic(file, '{}\n');
    console.log(`Initialised ${file}`);
    return 0;
  }
  if (sub === 'merge') {
    const patchFile = flag(argv, 'file', '');
    const raw = patchFile ? (fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : null) : positionals(rest)[1];
    if (raw == null || raw === undefined) { console.error(patchFile ? `No patch file at ${patchFile}` : usage); return 1; }
    let patch;
    try { patch = JSON.parse(raw); } catch { console.error(`Patch is not valid JSON`); return 1; }
    const bad = validateProjectFile(kind, patch);
    if (bad.length) { console.error(`REJECTED — ${kind} patch:`); for (const e of bad) console.error(`  · ${e}`); return 1; }
    const base = read();
    if (base === null) { console.error(`${file} is not valid JSON — fix or delete it first.`); return 1; }
    const merged = mergeProjectFile(kind, base, patch);
    const badAll = validateProjectFile(kind, merged);
    if (badAll.length) { console.error(`REJECTED — merged ${kind}:`); for (const e of badAll) console.error(`  · ${e}`); return 1; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeStateAtomic(file, JSON.stringify(merged, null, 2) + '\n');
    console.log(`Updated ${file}: ${Object.keys(patch).join(', ') || '(no fields)'}`);
    return 0;
  }
  console.error(usage);
  return 1;
}

// ---- CLI ----
const today = () => new Date().toISOString().slice(0, 10);

function flag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// Positional args, with `--flag value` pairs removed. Prevents a flag's value
// being mistaken for the command's own text argument (e.g. `decide --path x`
// must not read "x" as the decision text).
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

// Shared guard: every verb that reads state.md before writing it must fail
// the same named way when the file is missing — no raw fs stack traces.
function requireStateFile(p) {
  if (!fs.existsSync(p)) {
    console.error(`No state file at ${p} — run: node ~/.signal/root/scripts/state.js init "<product>"`);
    process.exit(1);
  }
}

function loadState(p) {
  requireStateFile(p);
  const text = fs.readFileSync(p, 'utf8');
  if (!isSignalStateFile(text)) {
    console.error(
      `${p} does not look like a Signal state file (missing the "# Signal State — <product>" ` +
      `header that renderState always writes) — refusing to modify it. If this file predates ` +
      `Signal, move it aside; do not point state.js at it.`
    );
    process.exit(1);
  }
  return parseState(text);
}

function save(p, state, skill) {
  writeStateAtomic(p, renderState(state, { skill, date: today() }));
}

function loadRegistry() {
  const p = new URL('../skills/registry.json', import.meta.url);
  return JSON.parse(fs.readFileSync(p, 'utf8')).skills;
}

const mistakesPathFor = (statePath) => path.join(path.dirname(statePath), 'mistakes.md');

// One fixed instruction per debrief error, so the same failure always yields the same rule.
function ruleForError(e) {
  const m = e.match(/^missing \*\*([^*]+):\*\*/);
  if (m) return `End the debrief with the **${m[1]}:** field on the same line as its label`;
  if (/missing or empty \*\*Learned/.test(e)) return 'List at least one fact under **Learned:** unless Artifact is "none"';
  if (/no "## Debrief"/.test(e)) return 'End your output with the "## Debrief" block, copied literally from your skill';
  return 'End the debrief with every field of the debrief contract, copied literally from your skill';
}

// Record a rejected debrief once per agent and reason per day. Never throws into the merge.
function recordRejection(mistakesPath, agent, errors) {
  try {
    const what = `Debrief rejected: ${errors.join('; ')}`;
    const day = today();
    if (readMistakes(mistakesPath).some(e => e.agent === agent && e.date === day && e.what === what)) return;
    const rule = [...new Set(errors.map(ruleForError))].join('. ');
    addMistake({ text: what, rule, agent, source: 'auto', file: mistakesPath, date: day });
  } catch { /* the rejection itself is what matters */ }
}

const FROZEN_FILES = ['prd.md', 'acceptance-criteria.md', 'metrics.md', 'CHANGELOG.md', 'one-pager.md', 'story-map.md'];

// Where a PRD version stands: none, draft, incomplete (interrupted freeze) or frozen.
export function prdStatus(pmDir, version) {
  const dir = path.join(pmDir, 'prd', version);
  if (!fs.existsSync(dir)) {
    return { status: fs.existsSync(path.join(pmDir, 'prd-draft')) ? 'draft' : 'none', missing: [] };
  }
  const missing = FROZEN_FILES.filter(f => !fs.existsSync(path.join(dir, f)));
  return { status: missing.length ? 'incomplete' : 'frozen', missing };
}

export const REVIEW_STAGES = ['zoom-out', 'comprehension', 'critic', 'readiness'];

// Text of one `## ` section of a markdown file, or ''.
const mdSection = (text, name) => {
  const m = text.match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1] : '';
};
const mdTitles = (body) => [...body.matchAll(/^### (.+?)\s*$/gm)].map(m => m[1]);

// The freeze gate: every review stage has a report and a resolve report, and no
// Blocker is still open. A Blocker is open when the resolve report has no
// `### <title>` section for it, or that section says `Status: open`.
export function reviewGate(pmDir) {
  const dir = path.join(pmDir, 'review');
  const problems = [];
  for (const stage of REVIEW_STAGES) {
    const reportPath = path.join(dir, `${stage}.md`);
    const resolvePath = path.join(dir, `${stage}-resolve.md`);
    if (!fs.existsSync(reportPath)) { problems.push(`${stage}: no review report`); continue; }
    if (!fs.existsSync(resolvePath)) { problems.push(`${stage}: no resolve report`); continue; }
    const resolve = fs.readFileSync(resolvePath, 'utf8');
    const sections = new Map();
    for (const part of resolve.split(/^### /m).slice(1)) {
      const [title, ...rest] = part.split('\n');
      const status = (rest.join('\n').match(/^Status:\s*(\S+)/mi) || [])[1] || 'open';
      sections.set(title.trim(), status.toLowerCase());
    }
    for (const title of mdTitles(mdSection(fs.readFileSync(reportPath, 'utf8'), 'Blockers'))) {
      if ((sections.get(title) ?? 'open') === 'open') problems.push(`${stage}: open Blocker "${title}"`);
    }
  }
  return { ok: problems.length === 0, problems };
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Serialise every mutating command: `.state.lock` next to state.md, created with `wx`.
export function withStateLock(statePath, fn) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.state.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`Could not get ${lock} within ${LOCK_WAIT_MS / 1000}s — another state.js is running, or delete the lock if it is stale.`);
      sleepMs(10 + Math.floor(Math.random() * 40));
    }
  }
  // loadState calls process.exit on bad input, which skips `finally`; release on exit too.
  const release = () => { try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ } };
  process.on('exit', release);
  try { return fn(); } finally { process.off('exit', release); release(); }
}

const MUTATING = ['init', 'merge', 'phase', 'set-mode', 'assume', 'resolve', 'decide', 'archive', 'style', 'refs'];

function cli(argv) {
  if (MUTATING.includes(argv[0])) {
    try { return withStateLock(flag(argv, 'path', '.pm/state.md'), () => runCli(argv)); } catch (err) {
      console.error(err.message); return 1;
    }
  }
  return runCli(argv);
}

function runCli(argv) {
  const [cmd, ...rest] = argv;
  const statePath = flag(argv, 'path', '.pm/state.md');

  if (cmd === 'init') {
    const product = positionals(rest)[0] || 'Untitled';
    if (fs.existsSync(statePath) && !argv.includes('--force')) {
      console.error(
        `${statePath} already exists — refusing to overwrite it (this would destroy every ` +
        `fact, decision, glossary entry, and artifact recorded so far). Pass --force to ` +
        `reinitialise it anyway.`
      );
      return 1;
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const blank = { product, phase: '', facts: [], decisions: [], glossary: [], openQuestions: [], artifacts: [], next: '' };
    save(statePath, blank, 'setup');
    ensureMistakesFile(mistakesPathFor(statePath));
    console.log(`Initialised ${statePath} for "${product}"`);
    return 0;
  }

  if (cmd === 'style' || cmd === 'refs') return projectFileCli(cmd, argv, rest, statePath);

  if (cmd === 'prd-status') {
    const version = positionals(rest)[0];
    if (!version || !/^v\d+$/.test(version)) {
      console.error(`Bad version "${version ?? ''}" — expected v0, v1, v2…`);
      return 1;
    }
    const r = prdStatus(path.dirname(statePath), version);
    console.log(`${r.status} ${r.missing.length ? r.missing.join(',') : '-'}`);
    return 0;
  }

  if (cmd === 'review-gate') {
    const r = reviewGate(path.dirname(statePath));
    if (r.ok) { console.log('ok'); return 0; }
    console.log(`blocked\n${r.problems.map(p => `- ${p}`).join('\n')}`);
    return 1;
  }

  if (cmd === 'check') {
    const s = loadState(statePath);
    const noSource = s.facts.filter(f => !/\[source:/.test(f));
    console.log(`Product: ${s.product || '(unnamed)'}`);
    console.log(`Phase:   ${s.phase || '(none)'}`);
    console.log(`Facts:   ${s.facts.length}/${FACT_LIMIT}  ·  Decisions: ${s.decisions.length}  ·  Glossary: ${s.glossary.length}`);
    console.log(`Open Qs: ${s.openQuestions.length}  ·  Artifacts: ${s.artifacts.length}`);
    const mp = mistakesPathFor(statePath);
    if (fs.existsSync(mp)) console.log(`Mistakes: ${readMistakes(mp).length} recorded`);
    if (noSource.length) console.log(`WARN — ${noSource.length} fact(s) missing [source: …]`);
    if (s.facts.length > FACT_LIMIT) {
      if (enforceFactLimit(s, FACT_LIMIT).archived.length > 0) {
        console.log(`OVER LIMIT — run: node ~/.signal/root/scripts/state.js archive`);
        return 1;
      }
      console.log(`PINNED — ${s.facts.length} facts, all pinned or referenced; archive cannot trim them`);
    }
    return 0;
  }

  if (cmd === 'brief') {
    const name = positionals(rest)[0];
    const entry = loadRegistry()[name];
    if (!entry) { console.error(`Unknown skill "${name}" — not in skills/registry.json`); return 1; }
    const params = {};
    for (const arg of argv) {
      const m = arg.match(/^([a-z]\w*)=(.+)$/i);   // e.g. lens=regulatory
      if (m) params[m[1]] = m[2];
    }
    if (entry.params) {
      // A param's declared value is either an array of allowed values (an enum —
      // e.g. lens: ['regulatory', ...]) or `true` (required, but free-form — e.g.
      // ux-review's target, which is a path and has no fixed set of values).
      const missing = Object.keys(entry.params).filter(k => params[k] === undefined);
      if (missing.length) {
        for (const k of missing) {
          const allowed = entry.params[k];
          const suffix = Array.isArray(allowed) ? ` — allowed values: ${allowed.join(', ')}` : '';
          console.error(`Missing required param "${k}" for skill "${name}"${suffix}`);
        }
        return 1;
      }
      // Presence alone isn't enough for an enum param — the success path must
      // enforce the same allowed set the missing-param error already advertises,
      // or `lens=totally-bogus` sails through and dispatches an agent with no
      // valid lens.
      const invalid = Object.keys(entry.params)
        .filter(k => Array.isArray(entry.params[k]) && !entry.params[k].includes(params[k]));
      if (invalid.length) {
        for (const k of invalid) {
          console.error(`Invalid value "${params[k]}" for param "${k}" of skill "${name}" — allowed values: ${entry.params[k].join(', ')}`);
        }
        return 1;
      }
    }
    process.stdout.write(composeBriefing(loadState(statePath), { ...entry, name }, params, {
      full: argv.includes('--full'),
      rules: rulesFor(name, { project: mistakesPathFor(statePath), global: globalPath() }),
    }));
    return 0;
  }

  if (cmd === 'merge') {
    const file = positionals(rest)[0];
    if (!file || !fs.existsSync(file)) { console.error(`No debrief file at ${file}`); return 1; }
    const raw = fs.readFileSync(file, 'utf8');
    const v = validateDebrief(raw);
    if (!v.ok) {
      console.error(`REJECTED — ${file} is not a valid debrief:`);
      for (const e of v.errors) console.error(`  · ${e}`);
      recordRejection(mistakesPathFor(statePath), flag(argv, 'skill', 'general'), v.errors);
      console.error('State was NOT modified. Re-dispatch the agent with the debrief contract.');
      return 1;
    }
    const before = loadState(statePath);
    const merged = mergeDebrief(before, v.debrief, { date: today(), skill: flag(argv, 'skill', 'unknown') });
    if (!v.debrief.hasAssumptions) console.log('WARN — no Assumptions field in the debrief (add **Assumptions (proposals):**)');
    save(statePath, merged, flag(argv, 'skill', 'pm'));
    console.log(`Merged: +${v.debrief.learned.length} fact(s), +${v.debrief.terms.length} term(s), ` +
      `+${v.debrief.openQuestions.length + v.debrief.assumptions.length} question(s)${/^none$/i.test(v.debrief.artifact) ? '' : `, artifact ${v.debrief.artifact}`}`);
    return 0;
  }

  if (cmd === 'phase') {
    const text = positionals(rest)[0];
    if (!text) { console.error('Usage: state.js phase "<text>"'); return 1; }
    const next = { ...loadState(statePath), phase: text };
    save(statePath, next, flag(argv, 'skill', 'pm'));
    console.log(`Phase set: ${text}`);
    return 0;
  }

  if (cmd === 'mode') {
    console.log(loadState(statePath).runMode);
    return 0;
  }

  if (cmd === 'set-mode') {
    const mode = positionals(rest)[0];
    if (!RUN_MODES.includes(mode)) { console.error(`Usage: state.js set-mode <${RUN_MODES.join('|')}>`); return 1; }
    save(statePath, { ...loadState(statePath), runMode: mode }, flag(argv, 'skill', 'pm'));
    console.log(`Run mode: ${mode}`);
    return 0;
  }

  if (cmd === 'assume') {
    const text = positionals(rest)[0];
    if (!text) { console.error('Usage: state.js assume "<default taken>" [--by <name>]'); return 1; }
    save(statePath, addAssumption(loadState(statePath), text, flag(argv, 'by', 'signal')), flag(argv, 'skill', 'pm'));
    console.log(`Assumed: ${text}`);
    return 0;
  }

  if (cmd === 'resolve') {
    const text = positionals(rest)[0];
    if (!text) { console.error('Usage: state.js resolve "<open question substring>"'); return 1; }
    const r = resolveQuestion(loadState(statePath), text);
    if (r.error) { console.error(`Cannot resolve — ${r.error}`); return 1; }
    save(statePath, r.state, flag(argv, 'skill', 'pm'));
    console.log(`Resolved: ${text}`);
    return 0;
  }

  if (cmd === 'decide') {
    const text = positionals(rest)[0];
    const usage = 'Usage: state.js decide "<decision>" --at <slug> [--phase "<text>"] [--resolves "<substring>"]';
    if (!text) { console.error(usage); return 1; }
    const at = flag(argv, 'at', '');
    if (!DECISION_CHECKPOINTS.includes(at)) {
      console.error(`${at ? `Unknown checkpoint "${at}"` : 'Missing --at'} — valid: ${DECISION_CHECKPOINTS.join(', ')}`);
      return 1;
    }
    let next = loadState(statePath);
    const resolves = flag(argv, 'resolves', '');
    if (resolves) {
      const r = resolveQuestion(next, resolves);
      if (r.error) { console.error(`Cannot resolve — ${r.error}`); return 1; }
      next = r.state;
    }
    next = addDecision(next, text, { date: today(), at });
    const phase = flag(argv, 'phase', '');
    if (phase) next = { ...next, phase };
    save(statePath, next, 'pm');
    console.log(`Recorded: ${text}`);
    return 0;
  }

  if (cmd === 'archive') {
    requireStateFile(statePath);
    const archivePath = flag(argv, 'archive', '.pm/context/archive.md');
    let r;
    try {
      r = archiveFacts(statePath, archivePath, { date: today() });
    } catch (err) {
      if (err instanceof NotSignalStateError) { console.error(err.message); return 1; }
      throw err;
    }
    if (r.archived) console.log(`Archived ${r.archived} fact(s) to ${archivePath}; ${r.remaining} fact(s) remain.`);
    else if (r.remaining > FACT_LIMIT) console.log(`Archived 0 fact(s); ${r.remaining} remain — pinned facts ([source: user]/[source: setup]) exceed ${FACT_LIMIT}.`);
    else console.log(`Nothing over the limit; ${r.remaining} fact(s) remain.`);
    return 0;
  }

  console.error('Usage: state.js <init|check|brief|merge|decide|resolve|phase|set-mode|mode|assume|archive|prd-status|review-gate|style|refs> [args] [--path <state.md>]');
  return 1;
}

// process.argv[1] is the path as invoked (not symlink-resolved); import.meta.url is
// always the realpath'd module URL. Comparing them raw silently fails — and skips
// cli() with a bare exit 0 — whenever this file is reached through a symlink (e.g.
// `signal-pm/*/scripts` → `signal/scripts`). Realpath argv[1] first so both sides
// refer to the same file.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(cli(process.argv.slice(2)));
}
