#!/usr/bin/env node
// scripts/runlog.js — the run log. One JSON line per Director step in .pm/run.log. Append-only.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const KINDS = ['route', 'skip', 'brief', 'dispatch', 'merge', 'decide', 'note'];
const DEFAULT_LOG = '.pm/run.log';

export function appendEvent(file, { kind, agent = null, text }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown kind "${kind}". Use one of: ${KINDS.join(', ')}.`);
  if (!text || !String(text).trim()) throw new Error('Missing text. Say what happened in a few words.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { ts: new Date().toISOString(), kind, agent: agent || null, text: String(text) };
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

export function parseLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a broken line */ }
  }
  return out;
}

export function readEvents(file) {
  return fs.existsSync(file) ? parseLines(fs.readFileSync(file, 'utf8')) : [];
}

export function formatEvent(ev) {
  const d = new Date(ev.ts);
  const hm = Number.isNaN(d.getTime()) ? '--:--'
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${hm}  ${String(ev.kind).padEnd(8)}  ${ev.agent || '-'}  ${ev.text}`;
}

function flags(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' || argv[i] === '--path') opt[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

export function cli(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = flags(rest);
  const file = opt.path || DEFAULT_LOG;
  try {
    if (cmd === 'add') {
      appendEvent(file, { kind: pos[0], agent: opt.agent, text: pos[1] });
      return 0;
    }
    if (cmd === 'tail') {
      const n = pos[0] ? Number(pos[0]) : 20;
      for (const ev of readEvents(file).slice(-n)) console.log(formatEvent(ev));
      return 0;
    }
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  console.error('Usage: runlog.js <add <kind> "<text>" [--agent <name>] | tail [n]> [--path <file>]');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exit(cli(process.argv.slice(2)));
}
