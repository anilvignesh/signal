#!/usr/bin/env node
// scripts/cost.js — cost conductor: estimate a run, plan several, log each dispatch, summarise.
// Estimates are rough (chars / 4). Actual counts come only from what the harness reports.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_CLI = path.join(ROOT, 'scripts/state.js');

// Two tiers only. The model names are aliases that resolve to the latest release.
export const MODEL_FOR_TIER = { fast: 'sonnet', deep: 'opus' };
export const OUTPUT_ALLOWANCE = { fast: 4000, deep: 6000 };
// Old cost-log rows used small/standard/strong. Read them as fast or deep.
export const LEGACY_TIER = { small: 'fast', standard: 'fast', strong: 'deep' };
export const normalizeTier = (t) => LEGACY_TIER[t] || t;
export const DEFAULT_THRESHOLD = 400000;
const DEFAULT_LOG = '.pm/cost.log';

const loadRegistry = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/registry.json'), 'utf8')).skills;

// Tokens for one agent run: skill text + its briefing, plus an output allowance by tier.
export function estimateAgent(agent, params = {}, { statePath = '.pm/state.md' } = {}) {
  const entry = loadRegistry()[agent];
  if (!entry) throw new Error(`Unknown skill "${agent}" — not in skills/registry.json`);
  const skill = fs.readFileSync(path.join(ROOT, entry.path), 'utf8');
  const args = [STATE_CLI, 'brief', agent, ...Object.entries(params).map(([k, v]) => `${k}=${v}`), '--path', statePath];
  const r = spawnSync('node', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || `brief failed for ${agent}`).trim());
  const input = Math.ceil((skill.length + r.stdout.length) / 4);
  const output = OUTPUT_ALLOWANCE[entry.tier];
  return { agent, tier: entry.tier, input, output, total: input + output };
}

// "agent" or "agent:param=value,param=value"
export function parseSpec(spec) {
  const i = spec.indexOf(':');
  const agent = i < 0 ? spec : spec.slice(0, i);
  const params = {};
  if (i >= 0) {
    for (const pair of spec.slice(i + 1).split(',')) {
      const j = pair.indexOf('=');
      if (j > 0) params[pair.slice(0, j)] = pair.slice(j + 1);
    }
  }
  return { agent, params };
}

export function planAgents(specs, opts = {}) {
  const lines = specs.map(s => {
    const { agent, params } = parseSpec(s);
    return estimateAgent(agent, params, opts);
  });
  return { lines, total: lines.reduce((n, l) => n + l.total, 0) };
}

// The log is append-only: one JSON line per dispatch.
export function appendLog(file, { agent, tier, est, actual = null, source }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { ts: new Date().toISOString(), agent, tier, est, actual };
  if (source) row.source = source;
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => {
    try {
      const row = JSON.parse(l);
      if (row && typeof row === 'object' && row.tier) row.tier = normalizeTier(row.tier);
      return [row];
    } catch { return []; }
  });
}

// Per agent: director lines (no source) and hook lines (source "hook") describe the same runs.
// runs = the larger of the two counts; est comes from any line; actual prefers the hook's.
export function summarize(rows) {
  const by = Object.create(null); // agent names come from a log: never a plain object
  for (const r of rows) {
    const g = (by[r.agent] ||= { plain: [], hook: [] });
    (r.source === 'hook' ? g.hook : g.plain).push(r);
  }
  const num = (r) => typeof r.actual === 'number';
  const perAgent = Object.create(null);
  const total = { runs: 0, est: 0, actual: 0 };
  let noActual = 0;
  for (const [agent, g] of Object.entries(by)) {
    const src = g.hook.length ? g.hook : g.plain;
    const a = {
      runs: Math.max(g.plain.length, g.hook.length),
      est: [...g.plain, ...g.hook].reduce((n, r) => n + (Number(r.est) || 0), 0),
      actual: src.reduce((n, r) => n + (num(r) ? r.actual : 0), 0),
    };
    perAgent[agent] = a;
    total.runs += a.runs; total.est += a.est; total.actual += a.actual;
    noActual += Math.max(0, a.runs - src.filter(num).length);
  }
  return { perAgent, total, noActual };
}

// Measured from real runs: actual work tokens / raw estimate.
export const OUTPUT_FACTOR = {
  research: 13, 'ac-agent': 26, 'data-model': 40, metrics: 27, 'red-team': 11, tickets: 10,
  'design-flow': 15, 'ux-review': 8, discovery: 6, prioritize: 6, prd: 6, 'gtm-check': 6, setup: 2, 'maintain-context': 2,
};
export const DEFAULT_FACTOR = 6;

// Defaults table. Used until an agent has MIN_SAMPLES earlier runs in the log.
// Seeded from a real run: a PRD run with critic and acceptance criteria cost about 230k tokens
// against a 35k estimate (factor 6.6, inside the prd range below).
// Range = low..high multiple of the raw estimate; "expected" is the factor itself.
export const MIN_SAMPLES = 3;
export const RANGE_SPREAD = { low: 0.6, high: 1.6 };

// Agents that run per batch of rows, not per brief. Tokens are for one unit, low..high.
// Plan them as "gap-check:rows=25". Units = ceil(rows / per).
export const UNIT_COST = {
  'gap-check':      { per: 10, low: 30000, high: 50000, note: 'about 40k tokens per 10 rows' },
  'code-verify':    { per: 15, low: 100000, high: 160000, note: 'about 130k tokens per group of 15 rows' },
  'master-section': { per: 1,  low: 60000, high: 100000, note: 'about 60-100k tokens per section agent' },
};

// Factor that turns the raw estimate into an expected total for one agent, with a low-high range.
// Median actual/est of earlier runs once there are MIN_SAMPLES; the defaults table before that.
export function calibrate(agent, rows = []) {
  const mine = rows.filter(r => r.agent === agent);
  const hooks = mine.filter(r => r.source === 'hook');
  const plain = mine.filter(r => r.source !== 'hook');
  const ests = plain.filter(r => Number(r.est) > 0).map(r => Number(r.est));
  const acts = (hooks.length ? hooks : plain).filter(r => typeof r.actual === 'number' && r.actual > 0).map(r => r.actual);
  const n = Math.min(ests.length, acts.length);
  const clamp = (x) => Math.min(60, Math.max(1, Math.round(x * 100) / 100));
  if (n < MIN_SAMPLES) {
    const factor = OUTPUT_FACTOR[agent] ?? DEFAULT_FACTOR;
    return { factor, low: clamp(factor * RANGE_SPREAD.low), high: clamp(factor * RANGE_SPREAD.high), basis: 'static' };
  }
  const ratios = Array.from({ length: n }, (_, i) => acts[i] / ests[i]).sort((x, y) => x - y);
  const mid = ratios.length >> 1;
  const med = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { factor: clamp(med), low: clamp(ratios[0]), high: clamp(ratios[ratios.length - 1]), basis: `median of ${n} earlier runs` };
}

// One plan line for a per-batch agent, or null when the agent is not in UNIT_COST.
export function unitPlan(agent, params = {}) {
  const u = UNIT_COST[agent];
  if (!u) return null;
  const rows = Number(params.rows ?? params.n ?? u.per);
  if (!Number.isFinite(rows) || rows < 1) throw new Error(`${agent} needs rows=<n>`);
  const units = Math.ceil(rows / u.per);
  const low = units * u.low, high = units * u.high;
  return { agent, tier: 'fast', unit: true, units, rows, low, high, expected: Math.round((low + high) / 2), note: u.note };
}

// ---- CLI ----
function flag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}
const fmt = (n) => String(n);
const logFor = (argv, statePath) => flag(argv, 'log', path.join(path.dirname(path.resolve(statePath)), 'cost.log'));
// log/summary: --log wins; --path may be the state file (use its sibling cost.log) or the log itself.
function logFile(argv) {
  const explicit = flag(argv, 'log');
  if (explicit) return explicit;
  const p = flag(argv, 'path', DEFAULT_LOG);
  let isState = path.basename(p) === 'state.md';
  if (!isState) {
    try { isState = fs.readFileSync(p, 'utf8').startsWith('# Signal State'); } catch { /* not readable: a log path */ }
  }
  return isState ? path.join(path.dirname(path.resolve(p)), 'cost.log') : p;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const pos = positionals(rest);
  const statePath = flag(argv, 'path', '.pm/state.md');
  try {
    if (cmd === 'estimate') {
      const params = {};
      for (const a of pos.slice(1)) {
        const m = a.match(/^([a-z]\w*)=(.+)$/i);
        if (m) params[m[1]] = m[2];
      }
      const e = estimateAgent(pos[0], params, { statePath });
      const c = calibrate(e.agent, readLog(logFor(argv, statePath)));
      console.log(`agent   ${e.agent}\ntier    ${e.tier} (${MODEL_FOR_TIER[e.tier]})\ninput   ${fmt(e.input)}\noutput  ${fmt(e.output)}\ntotal   ${fmt(e.total)}\nexpected ${fmt(Math.round(e.total * c.factor))}  (factor ${c.factor}x, ${c.basis})`);
      return 0;
    }
    if (cmd === 'plan') {
      const threshold = Number(process.env.SIGNAL_COST_CONFIRM) || DEFAULT_THRESHOLD;
      const rows = readLog(logFor(argv, statePath));
      let total = 0, lowTotal = 0, expectedTotal = 0, highTotal = 0;
      const hints = [];
      for (const spec of pos) {
        const { agent, params } = parseSpec(spec);
        const u = UNIT_COST[agent] && !loadRegistry()[agent] ? unitPlan(agent, params) : null;
        if (u) {
          lowTotal += u.low; expectedTotal += u.expected; highTotal += u.high;
          console.log(`${u.agent}  ${u.rows} rows, ${u.units} unit${u.units === 1 ? '' : 's'}  expected ${u.low}-${u.high} (mid ${u.expected}, default: ${u.note})`);
          continue;
        }
        const l = estimateAgent(agent, params, { statePath });
        const c = calibrate(l.agent, rows);
        const exp = Math.round(l.total * c.factor), lo = Math.round(l.total * c.low), hi = Math.round(l.total * c.high);
        total += l.total; lowTotal += lo; expectedTotal += exp; highTotal += hi;
        hints.push(l);
        console.log(`${l.agent}  ${l.tier} (${MODEL_FOR_TIER[l.tier]})  input ${l.input}  output ${l.output}  raw ${l.total}  expected ${lo}-${hi} (mid ${exp}, factor ${c.factor}x, ${c.basis})`);
      }
      console.log(`total ${total}  expected total ${lowTotal}-${highTotal} (mid ${expectedTotal})  (threshold ${threshold})`);
      for (const l of hints) console.log(`${l.agent}  log with --est ${l.total}`);
      if (expectedTotal > threshold) { console.log('OVER THRESHOLD — confirm with the user before dispatching.'); return 2; }
      return 0;
    }
    if (cmd === 'log') {
      const tier = normalizeTier(flag(argv, 'tier'));
      const est = Number(flag(argv, 'est'));
      const actualRaw = flag(argv, 'actual');
      if (!pos[0]) throw new Error('log needs an agent name');
      if (!MODEL_FOR_TIER[tier]) throw new Error('--tier must be fast or deep');
      if (!Number.isFinite(est) || flag(argv, 'est') === undefined) throw new Error('--est must be a number');
      const actual = actualRaw === undefined ? null : Number(actualRaw);
      if (actual !== null && !Number.isFinite(actual)) throw new Error('--actual must be a number');
      appendLog(logFile(argv), { agent: pos[0], tier, est, actual });
      return 0;
    }
    if (cmd === 'summary') {
      const rows = readLog(logFile(argv));
      if (!rows.length) { console.log('No runs logged yet.'); return 0; }
      const s = summarize(rows);
      for (const [agent, a] of Object.entries(s.perAgent)) {
        console.log(`${agent}  ${a.runs} run${a.runs === 1 ? '' : 's'}  est ${a.est}  actual ${a.actual}`);
      }
      console.log(`total  ${s.total.runs} runs  est ${s.total.est}  actual ${s.total.actual}`);
      console.log(`${s.noActual} run(s) have no actual (actual counts only runs that reported one).`);
      return 0;
    }
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  console.error('Usage: cost.js <estimate|plan|log|summary> [args]');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exit(cli(process.argv.slice(2)));
}
