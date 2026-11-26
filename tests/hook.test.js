// tests/hook.test.js — scripts/hook.js: every event type, bad payload, no .pm/, cost line.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarize, readLog } from '../scripts/cost.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'scripts/hook.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signal-hook-'));
const project = () => { const d = tmp(); fs.mkdirSync(path.join(d, '.pm')); return d; };
const run = (input) => spawnSync('node', [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
const lines = (d) => {
  const f = path.join(d, '.pm/activity.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};
const base = (cwd, extra) => ({ session_id: 's1', transcript_path: '/x', cwd, ...extra });
const KEYS = ['ts', 'event', 'session', 'agent_id', 'agent_type', 'signal_agent', 'tool', 'summary', 'kind', 'tokens', 'message', 'duration_ms'];

test('dispatch: Agent call without agent_id, signal agent parsed from the prompt', () => {
  const d = project();
  const r = run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { description: 'Research the market', prompt: 'Read skills/agents/research/SKILL.md and go' } }));
  assert.equal(r.status, 0);
  const [e] = lines(d);
  assert.deepEqual(Object.keys(e), KEYS);
  assert.equal(e.event, 'dispatch');
  assert.equal(e.signal_agent, 'research');
  assert.equal(e.summary, 'Research the market');
  assert.equal(e.session, 's1');
});

test('dispatch parses the flat skills/<name>/SKILL.md form and yields null when absent', () => {
  const d = project();
  run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'a', prompt: 'see skills/prd/SKILL.md' } }));
  run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'b', prompt: 'no path here' } }));
  const [a, b] = lines(d);
  assert.equal(a.signal_agent, 'prd');
  assert.equal(b.signal_agent, null);
});

test('agent_start, tool, tool_done carry agent identity and short summaries; no tool output stored', () => {
  const d = project();
  run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'skills/agents/red-team/SKILL.md' } }));
  run(base(d, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' }));
  run(base(d, { hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'x'.repeat(300) } }));
  run(base(d, { hook_event_name: 'PostToolUse', agent_id: 'a1', agent_type: 'general-purpose', tool_name: 'Read',
    tool_input: { file_path: '/a/b.md' }, tool_response: { content: 'SECRET OUTPUT' } }));
  run(base(d, { hook_event_name: 'PreToolUse', agent_id: 'a1', tool_name: 'WebSearch', tool_input: { query: 'upi limits' } }));
  run(base(d, { hook_event_name: 'PreToolUse', agent_id: 'a1', tool_name: 'WebFetch', tool_input: { url: 'https://e.com', prompt: 'p' } }));
  const ev = lines(d);
  assert.deepEqual(ev.map(e => e.event), ['dispatch', 'agent_start', 'tool', 'tool_done', 'tool', 'tool']);
  assert.equal(ev[1].signal_agent, 'red-team');
  assert.equal(ev[2].signal_agent, 'red-team');
  assert.equal(ev[2].summary.length, 120);
  assert.equal(ev[3].summary, '/a/b.md');
  assert.equal(ev[4].summary, 'upi limits');
  assert.equal(ev[5].summary, 'https://e.com');
  assert.ok(!fs.readFileSync(path.join(d, '.pm/activity.jsonl'), 'utf8').includes('SECRET OUTPUT'));
});

test('agent_stop sums transcript usage, stores last message, and appends a cost line', () => {
  const d = project();
  const tr = path.join(d, 'agent.jsonl');
  fs.writeFileSync(tr, [
    JSON.stringify({ message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 } } }),
    JSON.stringify({ message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 } } }),
    'not json',
    JSON.stringify({ message: { id: 'm2', usage: { input_tokens: 2, output_tokens: 3 } } }),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  ].join('\n'));
  run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'skills/agents/research/SKILL.md' } }));
  run(base(d, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' }));
  run(base(d, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose',
    agent_transcript_path: tr, last_assistant_message: 'm'.repeat(900) }));
  const stop = lines(d).at(-1);
  assert.equal(stop.event, 'agent_stop');
  assert.deepEqual(stop.tokens, { input: 12, output: 10, cache: 100, cacheWrite: 1 });
  assert.equal(stop.message.length, 500);
  const rows = readLog(path.join(d, '.pm/cost.log'));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].agent, rows[0].tier, rows[0].est, rows[0].actual], ['research', null, null, 23]);
  assert.equal(rows[0].source, 'hook');
  const s = summarize(rows);
  assert.equal(s.total.actual, 23);
  assert.equal(s.total.est, 0);
});

test('agent_stop with a missing or oversized transcript gives null tokens and no cost line', () => {
  const d = project();
  run(base(d, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_transcript_path: '/nope/x.jsonl', last_assistant_message: 'done' }));
  const big = path.join(d, 'big.jsonl');
  fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, 21 * 1024 * 1024);
  run(base(d, { hook_event_name: 'SubagentStop', agent_id: 'a2', agent_transcript_path: big }));
  const [a, b] = lines(d);
  assert.equal(a.tokens, null);
  assert.equal(b.tokens, null);
  assert.equal(a.message, 'done');
  assert.ok(!fs.existsSync(path.join(d, '.pm/cost.log')));
});

test('director Bash calls become director events; other Bash calls are not logged', () => {
  const d = project();
  const bash = (command) => run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }));
  bash('node scripts/state.js merge --path .pm/state.md');
  bash('node /x/signal/scripts/state.js brief research topic=x');
  bash('node scripts/cost.js plan research prd');
  bash('node scripts/cost.js log research --tier fast --est 5');
  bash('node scripts/runlog.js add note "hi"');
  bash('ls -la');
  bash('node scripts/state.js bogus');
  const ev = lines(d);
  assert.deepEqual(ev.map(e => e.kind), ['merge', 'brief', 'cost_plan', 'cost_log', 'runlog']);
  assert.ok(ev.every(e => e.event === 'director' && e.agent_id === null));
  assert.match(ev[0].summary, /state\.js merge/);
});

test('director-looking Bash inside a subagent is a plain tool event', () => {
  const d = project();
  run(base(d, { hook_event_name: 'PreToolUse', agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'node scripts/state.js merge' } }));
  assert.equal(lines(d)[0].event, 'tool');
});

test('Stop becomes session_stop; unrelated events are ignored', () => {
  const d = project();
  run(base(d, { hook_event_name: 'Stop' }));
  run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } }));
  run(base(d, { hook_event_name: 'UserPromptSubmit' }));
  assert.deepEqual(lines(d).map(e => e.event), ['session_stop']);
});

test('bad payloads exit 0 and write nothing', () => {
  const d = project();
  for (const input of ['', 'not json', '[]', 'null', '{"cwd": 5}', JSON.stringify({ cwd: d })]) {
    const r = run(input);
    assert.equal(r.status, 0, `input ${JSON.stringify(input)}`);
  }
  assert.deepEqual(lines(d), []);
});

test('no .pm/ in the payload cwd: nothing is created, exit 0', () => {
  const d = tmp();
  const r = run(base(d, { hook_event_name: 'Stop' }));
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readdirSync(d), []);
});

test('a corrupt sidecar index is tolerated', () => {
  const d = project();
  fs.writeFileSync(path.join(d, '.pm/.activity-index.jsonl'), '{{{ broken\n');
  const r = run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'skills/prd/SKILL.md' } }));
  assert.equal(r.status, 0);
  run(base(d, { hook_event_name: 'SubagentStart', agent_id: 'a1' }));
  assert.equal(lines(d)[1].signal_agent, 'prd');
});

test('8 parallel dispatches then starts are all matched, none lost', async () => {
  const d = project();
  const { spawn } = await import('node:child_process');
  const go = (payload) => new Promise(res => {
    const p = spawn('node', [HOOK]); p.on('close', c => res(c)); p.stdin.end(JSON.stringify(payload));
  });
  const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
  const codes = await Promise.all(names.map(n => go(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { description: n, prompt: `skills/agents/${n}/SKILL.md` } }))));
  assert.ok(codes.every(c => c === 0));
  const starts = await Promise.all(names.map((n, i) => go(base(d, { hook_event_name: 'SubagentStart', agent_id: `id${i}` }))));
  assert.ok(starts.every(c => c === 0));
  const got = lines(d).filter(e => e.event === 'agent_start').map(e => e.signal_agent).sort();
  assert.deepEqual(got, names);
});

test('dispatch tag line [signal-agent: name] wins over the SKILL.md path; bad names fall back', () => {
  const d = project();
  const go = (prompt) => run(base(d, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', prompt } }));
  go('[signal-agent: red-team]\nRead skills/agents/research/SKILL.md');
  go('[signal-agent: Bad_Name]\nRead skills/agents/research/SKILL.md');
  go('[signal-agent: 9x]\nnothing');
  assert.deepEqual(lines(d).map(e => e.signal_agent), ['red-team', 'research', null]);
});
