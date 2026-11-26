#!/usr/bin/env node
// scripts/hook.js — Claude Code hook. Reads the hook JSON on stdin, appends one line to
// <cwd>/.pm/activity.jsonl. Never throws, never blocks, always exits 0. Tool output is never stored.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendLog } from './cost.js';

const MAX_TRANSCRIPT = 20 * 1024 * 1024;
const STATE_SUB = ['brief', 'merge', 'decide', 'phase', 'archive', 'check', 'resolve'];
const COST_SUB = { plan: 'cost_plan', log: 'cost_log', summary: 'cost_summary', estimate: 'cost_estimate' };

const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const str = (v) => (typeof v === 'string' && v ? v : null);

export function parseSignalAgent(prompt) {
  const tag = typeof prompt === 'string' && prompt.match(/^\s*\[signal-agent:\s*([^\]\s]+)\s*\]/);
  if (tag && /^[a-z][a-z0-9-]*$/.test(tag[1])) return tag[1];
  const m = typeof prompt === 'string' && prompt.match(/skills\/(?:agents\/)?([a-z0-9][a-z0-9-]*)\/SKILL\.md/i);
  return m ? m[1] : null;
}

// What a tool call was about, in a few words. Never the tool's output.
export function summarizeTool(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = i.command ?? i.file_path ?? i.notebook_path ?? i.query ?? i.pattern ?? i.url ?? i.description ?? i.path;
  return cut(typeof pick === 'string' ? pick : null, 120);
}

export function directorKind(command) {
  if (typeof command !== 'string') return null;
  let m = command.match(/scripts\/state\.js\s+(\w+)/);
  if (m && STATE_SUB.includes(m[1])) return m[1];
  m = command.match(/scripts\/cost\.js\s+(\w+)/);
  if (m && COST_SUB[m[1]]) return COST_SUB[m[1]];
  if (/scripts\/runlog\.js/.test(command)) return 'runlog';
  return null;
}

// Sum usage across an agent transcript. Null if unreadable or too big.
export function sumTranscript(file) {
  try {
    if (typeof file !== 'string' || !fs.statSync(file).isFile() || fs.statSync(file).size > MAX_TRANSCRIPT) return null;
    const byMsg = new Map();
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = o && o.message && o.message.usage;
      if (!u || typeof u !== 'object') continue;
      byMsg.set(o.message.id || `#${n++}`, u); // a streamed message repeats; keep the last
    }
    if (!byMsg.size) return null;
    const t = { input: 0, output: 0, cache: 0, cacheWrite: 0 };
    for (const u of byMsg.values()) {
      t.input += Number(u.input_tokens) || 0;
      t.output += Number(u.output_tokens) || 0;
      t.cache += Number(u.cache_read_input_tokens) || 0;
      t.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
    }
    return t;
  } catch { return null; }
}

// Append-only sidecar, one JSON line per dispatch ({d:agent|null}) and per start ({s:agent_id}).
// Appends are atomic, so parallel hooks never overwrite each other and no lock is needed.
// The Nth start belongs to the Nth dispatch (FIFO); the match is computed when reading.
const MAX_INDEX = 512 * 1024;
function appendIndex(file, rec) {
  try {
    try { if (fs.statSync(file).size > MAX_INDEX) fs.rmSync(file, { force: true }); } catch { /* none yet */ }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch { /* ignore */ }
}
// -> { dispatches: [agent|null], starts: [agent_id] } in file order.
function readIndex(file) {
  const out = { dispatches: [], starts: [] };
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if ('d' in o) out.dispatches.push(typeof o.d === 'string' ? o.d : null);
    else if (typeof o.s === 'string') out.starts.push(o.s);
  }
  return out;
}
// The Signal agent an agent_id was dispatched as, or null.
function agentFor(idx, aid) {
  const k = idx.starts.indexOf(aid);
  return k >= 0 && k < idx.dispatches.length ? idx.dispatches[k] : null;
}

export function handleHook(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.cwd !== 'string' || !payload.cwd) return;
  const pm = path.join(payload.cwd, '.pm');
  if (!fs.existsSync(pm) || !fs.statSync(pm).isDirectory()) return;

  const name = payload.hook_event_name;
  const aid = str(payload.agent_id);
  const tool = str(payload.tool_name);
  const input = payload.tool_input;
  const indexFile = path.join(pm, '.activity-index.jsonl');

  const row = {
    ts: new Date().toISOString(), event: null, session: cut(payload.session_id, 100) || null,
    agent_id: cut(aid, 100), agent_type: cut(str(payload.agent_type), 100), signal_agent: null,
    tool: cut(tool, 60), summary: null, kind: null, tokens: null, message: null, duration_ms: null,
  };

  if (name === 'PreToolUse' && tool === 'Agent' && !aid) {
    row.event = 'dispatch';
    row.summary = cut(input && input.description, 120);
    row.signal_agent = cut(parseSignalAgent(input && input.prompt), 100);
    appendIndex(indexFile, { d: row.signal_agent });
  } else if (name === 'SubagentStart') {
    row.event = 'agent_start';
    let sa = null;
    if (aid) {
      appendIndex(indexFile, { s: aid });
      sa = agentFor(readIndex(indexFile), aid);
    }
    row.signal_agent = cut(sa, 100);
  } else if ((name === 'PreToolUse' || name === 'PostToolUse') && aid) {
    row.event = name === 'PreToolUse' ? 'tool' : 'tool_done';
    row.summary = summarizeTool(tool, input);
    row.signal_agent = cut(agentFor(readIndex(indexFile), aid), 100);
  } else if (name === 'SubagentStop') {
    row.event = 'agent_stop';
    row.tokens = sumTranscript(payload.agent_transcript_path);
    row.message = cut(payload.last_assistant_message, 500);
    row.signal_agent = cut(aid ? agentFor(readIndex(indexFile), aid) : null, 100);
    if (row.signal_agent && row.tokens) {
      try {
        appendLog(path.join(pm, 'cost.log'), {
          agent: row.signal_agent, tier: null, est: null,
          actual: row.tokens.input + row.tokens.output + row.tokens.cacheWrite, source: 'hook',
        });
      } catch { /* ignore */ }
    }
  } else if (name === 'PreToolUse' && tool === 'Bash' && !aid) {
    const cmd = input && input.command;
    const kind = directorKind(cmd);
    if (!kind) return;
    row.event = 'director';
    row.kind = kind;
    row.summary = cut(cmd, 120);
  } else if (name === 'Stop') {
    row.event = 'session_stop';
  } else {
    return;
  }
  fs.appendFileSync(path.join(pm, 'activity.jsonl'), JSON.stringify(row) + '\n');
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    try { handleHook(JSON.parse(raw)); } catch { /* never block the harness */ }
    process.exit(0);
  });
}

if (process.argv[1]) {
  let self = false;
  try { self = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { /* ignore */ }
  if (self) main();
}
