// tests/cost.test.js — cost conductor: estimate, plan, log, summary.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODEL_FOR_TIER, OUTPUT_ALLOWANCE, normalizeTier, readLog, estimateAgent, planAgents, appendLog, summarize, calibrate, unitPlan, UNIT_COST, MIN_SAMPLES } from '../scripts/cost.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/cost.js');
const STATE_CLI = path.join(ROOT, 'scripts/state.js');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/registry.json'), 'utf8')).skills;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signal-cost-'));
const cli = (args, env = {}) =>
  spawnSync('node', [CLI, ...args], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } });

function stateIn(dir) {
  const p = path.join(dir, 'state.md');
  spawnSync('node', [STATE_CLI, 'init', 'T', '--path', p], { cwd: ROOT });
  return p;
}

test('model mapping and output allowances', () => {
  assert.deepEqual(MODEL_FOR_TIER, { fast: 'sonnet', deep: 'opus' });
  assert.deepEqual(OUTPUT_ALLOWANCE, { fast: 4000, deep: 6000 });
});

test('estimateAgent = ceil(chars/4) of skill text + brief, plus tier allowance', () => {
  const dir = tmp();
  const statePath = stateIn(dir);
  const e = estimateAgent('red-team', {}, { statePath });
  const skill = fs.readFileSync(path.join(ROOT, registry['red-team'].path), 'utf8');
  const brief = spawnSync('node', [STATE_CLI, 'brief', 'red-team', '--path', statePath], { encoding: 'utf8', cwd: ROOT }).stdout;
  assert.equal(e.tier, 'deep');
  assert.equal(e.input, Math.ceil((skill.length + brief.length) / 4));
  assert.equal(e.output, 6000);
  assert.equal(e.total, e.input + 6000);
});

test('estimateAgent throws on an unknown agent', () => {
  assert.throws(() => estimateAgent('nope', {}, { statePath: stateIn(tmp()) }), /Unknown skill/);
});

test('estimate CLI prints agent, tier, input, output, total', () => {
  const statePath = stateIn(tmp());
  const r = cli(['estimate', 'research', 'lens=regulatory', '--path', statePath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /research/);
  assert.match(r.stdout, /fast \(sonnet\)/);
  assert.match(r.stdout, /input\s+\d+/i);
  assert.match(r.stdout, /output\s+4000/i);
  assert.match(r.stdout, /total\s+\d+/i);
});

test('planAgents parses agent:param=value,param=value and sums', () => {
  const statePath = stateIn(tmp());
  const p = planAgents(['research:lens=regulatory', 'metrics'], { statePath });
  assert.equal(p.lines.length, 2);
  assert.equal(p.total, p.lines[0].total + p.lines[1].total);
});

test('plan exits 0 under the threshold and 2 above; env overrides the default', () => {
  const statePath = stateIn(tmp());
  const ok = cli(['plan', 'metrics', '--path', statePath]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /total/i);
  const over = cli(['plan', 'metrics', '--path', statePath], { SIGNAL_COST_CONFIRM: '10' });
  assert.equal(over.status, 2);
  assert.match(over.stdout, /metrics/);
  const bad = cli(['plan', 'metrics', '--path', statePath], { SIGNAL_COST_CONFIRM: '10000000' });
  assert.equal(bad.status, 0);
});

test('plan compares the calibrated expected total to the threshold, not the raw estimate', () => {
  const statePath = stateIn(tmp());
  const raw = planAgents(['research:lens=regulatory'], { statePath }).total;
  // raw is under the limit, but research is expected to cost ~13x its raw estimate
  const r = cli(['plan', 'research:lens=regulatory', '--path', statePath], { SIGNAL_COST_CONFIRM: String(raw * 2) });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /expected total/i);
  const fine = cli(['plan', 'research:lens=regulatory', '--path', statePath], { SIGNAL_COST_CONFIRM: String(raw * 60) });
  assert.equal(fine.status, 0, fine.stdout);
});

test('log appends one JSON line per call; actual is null when omitted', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'cost.log');
  assert.equal(cli(['log', 'prd', '--tier', 'fast', '--est', '9000', '--actual', '8000', '--path', file]).status, 0);
  assert.equal(cli(['log', 'metrics', '--tier', 'fast', '--est', '5000', '--path', file]).status, 0);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].agent, 'prd');
  assert.equal(lines[0].actual, 8000);
  assert.equal(lines[1].actual, null);
  assert.equal(lines[1].est, 5000);
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
});

test('log rejects a bad tier or missing est', () => {
  const file = path.join(tmp(), 'cost.log');
  assert.notEqual(cli(['log', 'prd', '--tier', 'huge', '--est', '1', '--path', file]).status, 0);
  assert.notEqual(cli(['log', 'prd', '--tier', 'fast', '--path', file]).status, 0);
  assert.ok(!fs.existsSync(file));
});

test('summarize totals per agent and counts runs without an actual', () => {
  const s = summarize([
    { agent: 'prd', tier: 'fast', est: 100, actual: 90 },
    { agent: 'prd', tier: 'fast', est: 100, actual: null },
    { agent: 'metrics', tier: 'fast', est: 50, actual: null },
  ]);
  assert.equal(s.perAgent.prd.runs, 2);
  assert.equal(s.perAgent.prd.est, 200);
  assert.equal(s.perAgent.prd.actual, 90);
  assert.equal(s.total.runs, 3);
  assert.equal(s.total.est, 250);
  assert.equal(s.total.actual, 90);
  assert.equal(s.noActual, 2);
});

test('summary CLI prints per-agent lines, a total and the no-actual count; handles a missing log', () => {
  const file = path.join(tmp(), 'cost.log');
  const empty = cli(['summary', '--path', file]);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /no runs/i);
  appendLog(file, { agent: 'prd', tier: 'fast', est: 100, actual: 90 });
  appendLog(file, { agent: 'metrics', tier: 'fast', est: 50, actual: null });
  const r = cli(['summary', '--path', file]);
  assert.match(r.stdout, /prd\s+1 run/);
  assert.match(r.stdout, /metrics\s+1 run/);
  assert.match(r.stdout, /total/i);
  assert.match(r.stdout, /1 run\(s\) have no actual/);
});

test('summarize is safe against prototype-polluting agent names', () => {
  const s = summarize([{ agent: '__proto__', est: 1, actual: 2 }, { agent: 'constructor', est: 1, actual: 1 }, { agent: 'prototype', actual: 1 }]);
  assert.equal(({}).runs, undefined);
  assert.equal(Object.prototype.runs, undefined);
  assert.equal(s.total.runs, 3);
  assert.equal(Object.keys(s.perAgent).length, 3);
});

test('summarize: hook lines do not inflate runs or est; hook actual wins', () => {
  const s = summarize([
    { agent: 'prd', est: 100, actual: null },
    { agent: 'prd', est: 100, actual: 5 },
    { agent: 'prd', est: null, actual: 300, source: 'hook' },
    { agent: 'prd', est: null, actual: 200, source: 'hook' },
    { agent: 'prd', est: null, actual: 50, source: 'hook' },
    { agent: 'metrics', est: 10, actual: 7 },
    { agent: 'ux', est: null, actual: null, source: 'hook' },
  ]);
  assert.deepEqual(s.perAgent.prd, { runs: 3, est: 200, actual: 550 });
  assert.deepEqual(s.perAgent.metrics, { runs: 1, est: 10, actual: 7 });
  assert.equal(s.perAgent.ux.runs, 1);
  assert.equal(s.total.runs, 5);
  assert.equal(s.noActual, 1);
});

test('calibrate: static factors, median of earlier runs, clamped', () => {
  const want = { research: 13, 'ac-agent': 26, 'data-model': 40, metrics: 27, 'red-team': 11, tickets: 10,
    'design-flow': 15, 'ux-review': 8, discovery: 6, prioritize: 6, prd: 6, 'gtm-check': 6, setup: 2, 'maintain-context': 2, other: 6 };
  for (const [a, f] of Object.entries(want)) assert.equal(calibrate(a, []).factor, f, a);
  const rows = [
    { agent: 'prd', est: 100, actual: null }, { agent: 'prd', est: null, actual: 300, source: 'hook' },
    { agent: 'prd', est: 100, actual: null }, { agent: 'prd', est: null, actual: 500, source: 'hook' },
    { agent: 'prd', est: 100, actual: null }, { agent: 'prd', est: null, actual: 400, source: 'hook' },
  ];
  assert.equal(calibrate('prd', rows).factor, 4);
  const many = (est, actual) => Array.from({ length: 3 }, () => ({ agent: 'prd', est, actual }));
  assert.equal(calibrate('prd', many(100, 10)).factor, 1);
  assert.equal(calibrate('prd', many(1, 900)).factor, 60);
});

test('estimate and plan print the factor used; log beside state.md calibrates', () => {
  const dir = tmp();
  const statePath = stateIn(dir);
  const r = cli(['estimate', 'research', 'lens=regulatory', '--path', statePath]);
  assert.match(r.stdout, /expected \d+\s+\(factor 13x, static\)/);
  for (let i = 0; i < 3; i++) appendLog(path.join(dir, 'cost.log'), { agent: 'research', tier: 'fast', est: 100, actual: 500 });
  const p = cli(['plan', 'research:lens=voc', '--path', statePath]);
  assert.match(p.stdout, /factor 5x, median of 3 earlier runs/);
  assert.equal(p.status, 0);
});

test('plan prints raw, expected and a log --est <raw> hint per agent', () => {
  const statePath = stateIn(tmp());
  const raw = planAgents(['metrics', 'tickets:version=v0'], { statePath }).lines;
  const r = cli(['plan', 'metrics', 'tickets:version=v0', '--path', statePath], { SIGNAL_COST_CONFIRM: '99999999' });
  assert.match(r.stdout, /raw \d+\s+expected \d+-\d+ \(mid \d+, factor 27x/);
  for (const l of raw) assert.match(r.stdout, new RegExp(`${l.agent}\\s+log with --est ${l.total}\\b`));
});

test('calibration is consistent when est is the raw estimate', () => {
  const rows = [
    { agent: 'metrics', est: 5000, actual: null }, { agent: 'metrics', est: null, actual: 135000, source: 'hook' },
  ];
  assert.equal(calibrate('metrics', rows).factor, 27);
  const s = summarize([{ agent: 'metrics', est: 5000, actual: 135000 }]);
  assert.equal(s.perAgent.metrics.actual / s.perAgent.metrics.est, 27);
});

test('summary and log accept the state file, the log file, or --log', () => {
  const dir = tmp();
  const statePath = stateIn(dir);
  const log = path.join(dir, 'cost.log');
  assert.equal(cli(['log', 'prd', '--tier', 'fast', '--est', '10', '--path', statePath]).status, 0);
  assert.equal(readLogLines(log), 1);
  assert.match(cli(['summary', '--path', statePath]).stdout, /prd\s+1 run/);
  assert.match(cli(['summary', '--path', log]).stdout, /prd\s+1 run/);
  const other = path.join(dir, 'other.log');
  assert.equal(cli(['log', 'prd', '--tier', 'fast', '--est', '10', '--log', other]).status, 0);
  assert.match(cli(['summary', '--log', other]).stdout, /prd\s+1 run/);
  const odd = path.join(dir, 'renamed.md');
  fs.copyFileSync(statePath, odd);
  assert.match(cli(['summary', '--path', odd]).stdout, /prd\s+1 run/);
});
const readLogLines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;

test('fewer than 3 samples use the defaults table; 3 or more use the median', () => {
  assert.equal(MIN_SAMPLES, 3);
  const two = Array.from({ length: 2 }, () => ({ agent: 'prd', est: 100, actual: 900 }));
  assert.equal(calibrate('prd', two).basis, 'static');
  assert.equal(calibrate('prd', two).factor, 6);
  const three = [...two, { agent: 'prd', est: 100, actual: 900 }];
  assert.equal(calibrate('prd', three).factor, 9);
  assert.equal(calibrate('prd', three).low, 9);
});

test('calibrate returns a range around the default factor', () => {
  const c = calibrate('prd', []);
  assert.ok(c.low < c.factor && c.factor < c.high, JSON.stringify(c));
  // a PRD run cost about 230k against a 35k estimate: 6.6x sits inside the range
  assert.ok(230000 / 35000 >= c.low && 230000 / 35000 <= c.high);
});

test('plan prints a low-high range, not a single number', () => {
  const statePath = stateIn(tmp());
  const r = cli(['plan', 'discovery', '--path', statePath], { SIGNAL_COST_CONFIRM: '99999999' });
  assert.match(r.stdout, /expected \d+-\d+ \(mid \d+, factor 6x, static\)/);
  assert.match(r.stdout, /expected total \d+-\d+ \(mid \d+\)/);
});

test('unitPlan: per-batch defaults from the real run', () => {
  const g = unitPlan('gap-check', { rows: '10' });
  assert.equal(g.low <= 40000 && 40000 <= g.high, true);
  assert.equal(unitPlan('gap-check', { rows: '25' }).units, 3);
  assert.equal(unitPlan('code-verify', { rows: '15' }).units, 1);
  assert.equal(unitPlan('code-verify', { rows: '16' }).units, 2);
  const m = unitPlan('master-section', {});
  assert.equal(m.low, 60000);
  assert.equal(m.high, 100000);
  assert.equal(unitPlan('prd', {}), null);
  assert.throws(() => unitPlan('gap-check', { rows: '0' }), /rows/);
  assert.ok(UNIT_COST['code-verify'].low <= 130000 && 130000 <= UNIT_COST['code-verify'].high);
});

test('plan handles per-batch agents not in the registry', () => {
  const statePath = stateIn(tmp());
  const r = cli(['plan', 'gap-check:rows=20', 'master-section', '--path', statePath], { SIGNAL_COST_CONFIRM: '99999999' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gap-check\s+20 rows, 2 units\s+expected 60000-100000/);
  assert.match(r.stdout, /expected total 120000-200000/);
});

test('old tiers map to the two new ones: small and standard to fast, strong to deep', () => {
  assert.equal(normalizeTier('small'), 'fast');
  assert.equal(normalizeTier('standard'), 'fast');
  assert.equal(normalizeTier('strong'), 'deep');
  assert.equal(normalizeTier('deep'), 'deep');
});

test('old cost-log rows still read and summarise', () => {
  const file = path.join(tmp(), 'cost.log');
  fs.writeFileSync(file, ['small', 'standard', 'strong']
    .map(t => JSON.stringify({ ts: 'x', agent: 'prd', tier: t, est: 100, actual: 90 })).join('\n') + '\n');
  assert.deepEqual(readLog(file).map(r => r.tier), ['fast', 'fast', 'deep']);
  assert.equal(summarize(readLog(file)).perAgent.prd.runs, 3);
  assert.equal(cli(['log', 'prd', '--tier', 'strong', '--est', '1', '--path', stateIn(tmp())]).status, 0);
});
