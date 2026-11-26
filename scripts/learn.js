#!/usr/bin/env node
// scripts/learn.js — the self-learning loop. See docs/designs/self-learning.md.
// Records what happened in each run, finds patterns, proposes lessons, applies only approved ones, then scores them.
// Files: <dir>/runs.jsonl and <dir>/lessons.json. Default dir: .pm/learn. No network. No agent tokens.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addMistake } from './mistakes.js';

export const MIN_TASKS = 4;       // tasks per group before a group counts
export const MIN_PRS = 3;         // PRs per group before a group counts
export const GAP = 0.25;          // first-pass gap that makes a lesson
export const ANALYZE_EVERY = 5;   // runs between analyses
export const SCORE_AFTER = 5;     // runs before an approved lesson is scored
export const TAG_MIN_TASKS = 3;   // a finding tag must show in this many tasks
export const TAG_MIN_RUNS = 2;    // ...across this many runs

const pct = (x) => `${Math.round(x * 100)}%`;
const rate = (rows, f) => rows.length ? rows.filter(f).length / rows.length : 0;

// ---------- storage ----------
const runsFile = (dir) => path.join(dir, 'runs.jsonl');
const lessonsFile = (dir) => path.join(dir, 'lessons.json');

export function readRows(dir) {
  try {
    return fs.readFileSync(runsFile(dir), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}
export function append(dir, row) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(runsFile(dir), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}
export function readLessons(dir) {
  try { return JSON.parse(fs.readFileSync(lessonsFile(dir), 'utf8')); } catch { return { lessons: [], lastAnalyzedRuns: 0, nextId: 1 }; }
}
const writeLessons = (dir, d) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(lessonsFile(dir), JSON.stringify(d, null, 2) + '\n'); };

export const finishedRuns = (rows) => rows.filter(r => r.type === 'run-end').length;
export const currentRun = (rows) => { const s = rows.filter(r => r.type === 'run-start'); return s.length ? s[s.length - 1].run : null; };

// ---------- measures ----------
export const taskFirstPass = (t) => t.buildRounds <= 1 && t.qa === 'first' && t.outcome !== 'failed';
export const prFirstPass = (p) => p.ci === 'first' && (p.fixRounds || 0) === 0;
const bucket = (n, cuts, labels) => labels[cuts.findIndex(c => n <= c) === -1 ? labels.length - 1 : cuts.findIndex(c => n <= c)];
export const sizeBucket = (t) => bucket(t.files, [5, 12], ['1-5 files', '6-12 files', '13+ files']);
export const criteriaBucket = (t) => bucket(t.criteria, [3, 6], ['1-3 criteria', '4-6 criteria', '7+ criteria']);
export const prSizeBucket = (p) => bucket(p.files, [8, 14], ['up to 8 files', '9-14 files', '15-20 files']);

// Group rows by key, keep groups with enough rows, return [{key, n, ok, rate}].
function groups(rows, keyOf, passOf, min) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m].filter(([, v]) => v.length >= min)
    .map(([key, v]) => ({ key, n: v.length, ok: v.filter(passOf).length, rate: rate(v, passOf) }))
    .sort((a, b) => b.rate - a.rate);
}
const fmt = (g) => `${g.key} (first pass ${g.ok} of ${g.n}, ${pct(g.rate)})`;

// One lesson from a dimension, or null.
function compare(dim, list, { forWho, better, rightText }) {
  if (!list.length) return null;
  const best = list[0], worst = list[list.length - 1];
  if (list.length >= 2 && best.rate - worst.rate >= GAP) {
    return { key: `${dim}:${best.key}>${worst.key}`, kind: 'better-way', forWho, text: better(best, worst), evidence: { best, worst } };
  }
  if (best.rate >= 0.9 && best.n >= MIN_TASKS + 2) {
    return { key: `${dim}:keep:${best.key}`, kind: 'went-right', forWho, text: rightText(best), evidence: { best } };
  }
  return null;
}

// ---------- analysis ----------
export function findLessons(rows) {
  const tasks = rows.filter(r => r.type === 'task');
  const prs = rows.filter(r => r.type === 'pr');
  const out = [];
  const add = (l) => { if (l) out.push(l); };
  const pass = taskFirstPass;

  add(compare('task-size', groups(tasks, sizeBucket, pass, MIN_TASKS), { forWho: 'director',
    better: (b, w) => `Plan tasks of ${b.key}. They passed first time more often: ${fmt(b)}, against ${fmt(w)}.`,
    rightText: (b) => `Keep tasks at ${b.key}. They work: ${fmt(b)}.` }));
  add(compare('criteria', groups(tasks, criteriaBucket, pass, MIN_TASKS), { forWho: 'director',
    better: (b, w) => `Give each task ${b.key}. ${fmt(b)}, against ${fmt(w)}.`,
    rightText: (b) => `Keep tasks at ${b.key}. They work: ${fmt(b)}.` }));
  add(compare('task-kind', groups(tasks.filter(t => t.kind), (t) => t.kind, pass, MIN_TASKS), { forWho: 'director',
    better: (b, w) => `Tasks of kind "${b.key}" go well and "${w.key}" tasks do not. ${fmt(b)}, against ${fmt(w)}. Plan "${w.key}" tasks smaller and give them more detail.`,
    rightText: (b) => `Keep planning "${b.key}" tasks the same way. ${fmt(b)}.` }));

  for (const risky of [0, 1]) {
    const cls = tasks.filter(t => !!t.risky === !!risky && t.model);
    add(compare(`model:${risky ? 'risky' : 'normal'}`, groups(cls, (t) => t.model, pass, MIN_TASKS), { forWho: 'director',
      better: (b, w) => `For ${risky ? 'risky' : 'normal'} tasks use the "${b.key}" model. ${fmt(b)}, against ${fmt(w)}.`,
      rightText: (b) => `Keep the "${b.key}" model for ${risky ? 'risky' : 'normal'} tasks. ${fmt(b)}.` }));
  }

  add(compare('split-strategy', groups(prs.filter(p => p.strategy), (p) => p.strategy, prFirstPass, MIN_PRS), { forWho: 'director',
    better: (b, w) => `Split work by "${b.key}". Those PRs passed CI the first time more often: ${fmt(b)}, against ${fmt(w)}.`,
    rightText: (b) => `Keep splitting by "${b.key}". ${fmt(b)}.` }));
  add(compare('pr-size', groups(prs, prSizeBucket, prFirstPass, MIN_PRS), { forWho: 'director',
    better: (b, w) => `Aim for PRs of ${b.key}. ${fmt(b)}, against ${fmt(w)}.`,
    rightText: (b) => `Keep PRs at ${b.key}. ${fmt(b)}.` }));

  // Findings that keep coming back, across tasks and runs.
  const tagTasks = new Map();
  for (const t of tasks) for (const tag of new Set(t.tags || [])) {
    if (!tagTasks.has(tag)) tagTasks.set(tag, []);
    tagTasks.get(tag).push(t);
  }
  for (const [tag, ts] of tagTasks) {
    const runs = new Set(ts.map(t => t.run));
    if (ts.length >= TAG_MIN_TASKS && runs.size >= TAG_MIN_RUNS) {
      out.push({ key: `finding:${tag}`, kind: 'better-way', forWho: 'builder',
        text: `Reviewers keep flagging "${tag}" (${ts.length} tasks in ${runs.size} runs). Check it before you commit.`, evidence: { tag, tasks: ts.length, runs: runs.size } });
    }
  }
  return out;
}

export function analyze(dir) {
  const rows = readRows(dir);
  const d = readLessons(dir);
  const known = new Set(d.lessons.map(l => l.key));
  const added = [];
  for (const l of findLessons(rows)) {
    if (known.has(l.key)) continue;
    const lesson = { id: d.nextId++, status: 'proposed', createdAtRun: finishedRuns(rows), ...l };
    d.lessons.push(lesson); added.push(lesson);
  }
  d.lastAnalyzedRuns = finishedRuns(rows);
  writeLessons(dir, d);
  return added;
}

// ---------- lifecycle ----------
const overallFirstPass = (rows) => rate(rows.filter(r => r.type === 'task'), taskFirstPass);
const find = (d, id) => { const l = d.lessons.find(x => x.id === Number(id)); if (!l) throw new Error(`No lesson ${id}.`); return l; };

export function decide(dir, id, action, { mistakesFile = '.pm/mistakes.md' } = {}) {
  const d = readLessons(dir);
  const l = find(d, id);
  if (action === 'approve') {
    if (l.status !== 'proposed') throw new Error(`Lesson ${id} is ${l.status}, not proposed.`);
    const rows = readRows(dir);
    l.status = 'approved';
    l.appliedAtRun = finishedRuns(rows);
    l.baseline = overallFirstPass(rows);
    if (l.forWho !== 'director') {
      addMistake({ text: `Learned from past runs: ${l.text}`, rule: l.text, agent: l.forWho, source: 'learned', file: mistakesFile });
    }
  } else if (action === 'reject') {
    if (l.status !== 'proposed') throw new Error(`Lesson ${id} is ${l.status}, not proposed.`);
    l.status = 'rejected';
  } else if (action === 'retire') {
    l.status = 'retired';
  } else throw new Error(`Unknown action ${action}.`);
  writeLessons(dir, d);
  return l;
}

export function score(dir) {
  const rows = readRows(dir);
  const d = readLessons(dir);
  const runs = finishedRuns(rows);
  const changed = [];
  for (const l of d.lessons.filter(x => x.status === 'approved' && runs - x.appliedAtRun >= SCORE_AFTER)) {
    const endRuns = new Set(rows.filter(r => r.type === 'run-end').slice(l.appliedAtRun).map(r => r.run));
    const after = overallFirstPass(rows.filter(r => r.type === 'task' && endRuns.has(r.run)));
    const diff = after - l.baseline;
    l.after = after;
    l.status = diff >= 0.05 ? 'helped' : diff <= -0.10 ? 'worse' : 'no-effect';
    changed.push(l);
  }
  writeLessons(dir, d);
  return changed;
}

// ---------- report ----------
export function report(dir) {
  const rows = readRows(dir);
  const tasks = rows.filter(r => r.type === 'task'), prs = rows.filter(r => r.type === 'pr');
  const runs = finishedRuns(rows);
  const lines = [];
  lines.push(`Runs finished: ${runs}. Tasks: ${tasks.length}. PRs: ${prs.length}.`);
  if (!tasks.length) { lines.push('No task data yet.'); return lines; }
  const done = tasks.filter(t => t.outcome !== 'failed');
  lines.push(`First pass: ${pct(rate(tasks, taskFirstPass))} of tasks needed no fix round. Rework: ${pct(1 - rate(tasks, taskFirstPass))}.`);
  const redo = tasks.reduce((n, t) => n + (t.redispatch || 0), 0);
  lines.push(`Wasted dispatches: ${redo} (agents that had to run again).`);
  const withTok = tasks.filter(t => t.actual);
  if (withTok.length && done.length) lines.push(`Tokens per finished task: about ${Math.round(withTok.reduce((n, t) => n + t.actual, 0) / done.length)}.`);
  const withBoth = tasks.filter(t => t.actual && t.est);
  if (withBoth.length) {
    const ratio = withBoth.reduce((n, t) => n + t.actual, 0) / withBoth.reduce((n, t) => n + t.est, 0);
    lines.push(`Estimate accuracy: real use is ${ratio.toFixed(2)} times the estimate.`);
  }
  if (prs.length) {
    lines.push(`PRs first pass: ${pct(rate(prs, prFirstPass))} passed CI the first time.`);
    for (const g of groups(prs.filter(p => p.strategy), (p) => p.strategy, prFirstPass, 1)) lines.push(`  Split by ${fmt(g)}.`);
  }
  const d = readLessons(dir);
  const by = (s) => d.lessons.filter(l => l.status === s).length;
  lines.push(`Lessons: ${by('proposed')} waiting for your answer, ${by('approved')} in use, ${by('helped')} helped, ${by('no-effect')} no effect, ${by('worse')} made things worse.`);
  lines.push('Note: a lesson that "helped" matches a better result. That does not prove it caused it.');
  return lines;
}

// ---------- CLI ----------
const WHO = { director: 'for the Director', builder: 'for the builder' };
export const describe = (l) => `${l.id}. [${l.status}] ${l.kind === 'went-right' ? 'Went right' : 'Better way'} (${WHO[l.forWho] || `for ${l.forWho}`}): ${l.text}`;

export function main(argv, out = console.log) {
  const [cmd, ...rest] = argv;
  const flag = (n, def) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : def; };
  const dir = flag('dir', '.pm/learn');
  const num = (n) => Number(flag(n, 0)) || 0;
  try {
    const rows = readRows(dir);
    if (cmd === 'start') {
      const run = flag('run', `run-${finishedRuns(rows) + 1}-${Date.now().toString(36)}`);
      append(dir, { type: 'run-start', run }); out(run); return 0;
    }
    if (cmd === 'task') {
      const run = flag('run') || currentRun(rows);
      if (!run) throw new Error('No open run. Run `learn.js start` first.');
      append(dir, { type: 'task', run, task: flag('task'), repo: flag('repo'), kind: flag('kind'), files: num('files'), lines: num('lines'),
        criteria: num('criteria'), model: flag('model'), risky: flag('risky') === '1', buildRounds: num('build-rounds') || 1,
        reviewRounds: num('review-rounds') || 1, blockers: num('blockers'), majors: num('majors'), qa: flag('qa', 'first'),
        redispatch: num('redispatch'), tags: (flag('tags', '') || '').split(',').map(s => s.trim()).filter(Boolean),
        est: num('est'), actual: num('actual'), outcome: flag('outcome', 'done') });
      out('recorded task'); return 0;
    }
    if (cmd === 'pr') {
      const run = flag('run') || currentRun(rows);
      if (!run) throw new Error('No open run. Run `learn.js start` first.');
      append(dir, { type: 'pr', run, repo: flag('repo'), strategy: flag('strategy'), parts: num('parts') || 1, files: num('files'), lines: num('lines'),
        ci: flag('ci', 'first'), fixRounds: num('fix-rounds'), conflicts: num('conflicts') });
      out('recorded PR'); return 0;
    }
    if (cmd === 'finish') {
      const run = flag('run') || currentRun(rows);
      if (!run) throw new Error('No open run.');
      append(dir, { type: 'run-end', run });
      const total = finishedRuns(readRows(dir));
      const d = readLessons(dir);
      const scored = score(dir);
      for (const l of scored) out(`Lesson ${l.id} is now "${l.status}". ${l.status === 'helped' ? '' : 'Consider retiring it: learn.js retire ' + l.id}`);
      if (total - d.lastAnalyzedRuns >= ANALYZE_EVERY) {
        const added = analyze(dir);
        out(added.length ? `${added.length} new lesson(s) proposed. Show them to the user: learn.js list proposed` : 'Analysis ran. No new lessons.');
      } else out(`Run ${total} saved. Next analysis after run ${d.lastAnalyzedRuns + ANALYZE_EVERY}.`);
      return 0;
    }
    if (cmd === 'analyze') { const a = analyze(dir); a.forEach(l => out(describe(l))); if (!a.length) out('No new lessons.'); return 0; }
    if (cmd === 'list') {
      const st = rest.find(a => !a.startsWith('--'));
      const ls = readLessons(dir).lessons.filter(l => !st || l.status === st);
      if (!ls.length) out('No lessons.'); ls.forEach(l => out(describe(l))); return 0;
    }
    if (cmd === 'approve' || cmd === 'reject' || cmd === 'retire') {
      for (const id of rest.filter(a => /^\d+$/.test(a))) out(describe(decide(dir, id, cmd, { mistakesFile: flag('mistakes', '.pm/mistakes.md') })));
      return 0;
    }
    if (cmd === 'score') { const c = score(dir); c.forEach(l => out(describe(l))); if (!c.length) out('Nothing to score yet.'); return 0; }
    if (cmd === 'brief') {
      const ls = readLessons(dir).lessons.filter(l => l.status === 'approved' && l.forWho === 'director');
      if (!ls.length) out('No learned lessons yet.');
      else { out('Lessons learned from past runs (plan with these):'); ls.forEach(l => out(`- ${l.text}`)); }
      return 0;
    }
    if (cmd === 'report') { report(dir).forEach(l => out(l)); return 0; }
  } catch (e) { out(`error: ${e.message}`); return 1; }
  out('usage: learn.js start|task|pr|finish|analyze|list [status]|approve <id>...|reject <id>...|retire <id>...|score|brief|report [--dir <path>]');
  return 64;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
