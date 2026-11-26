#!/usr/bin/env node
// scripts/eng.js
// Deterministic task state for the Engineering Director.
// Store: .pm/eng/tasks.json (JSON, not markdown: the Director and tests read it without parsing prose).
// Shape: { "tasks": [ { id, title, files[], criteria[], deps[], repo, model, status } ] }
// Every write takes the same lock file approach as state.js (withStateLock: `.state.lock` next to the file).
//
//   eng.js add <id> --title <t> [--files a,b] [--criteria "x;y"] [--deps T1,T2] [--repo <path>] [--model fast|deep]
//   eng.js list
//   eng.js next                 ready tasks: planned, every dependency done
//   eng.js set <id> <status>    legal transitions only
//   eng.js gate                 exit 0 only when every task is done
// All commands take --path <file> (default .pm/eng/tasks.json). Illegal input exits non-zero.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withStateLock } from './state.js';

export const STATUSES = ['planned', 'building', 'built', 'reviewing', 'changes-requested', 'reviewed', 'qa', 'qa-failed', 'done'];
export const TRANSITIONS = {
  planned: ['building'],
  building: ['built'],
  built: ['reviewing'],
  reviewing: ['changes-requested', 'reviewed'],
  'changes-requested': ['building'],
  reviewed: ['qa'],
  qa: ['qa-failed', 'done'],
  'qa-failed': ['building'],
  done: [],
};

export const MODELS = ['fast', 'deep'];
const DEFAULT_PATH = '.pm/eng/tasks.json';

export function load(file) {
  if (!fs.existsSync(file)) return { tasks: [] };
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!d || !Array.isArray(d.tasks)) throw new Error(`${file} is not a task file`);
  return d;
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const list = (v) => (v ? String(v).split(/[;,]/).map(s => s.trim()).filter(Boolean) : []);

export function addTask(data, { id, title, files, criteria, deps, repo, model = 'fast' }) {
  if (!id || !/^[\w.-]+$/.test(id)) throw new Error('task id is required (letters, digits, - _ .)');
  if (!title) throw new Error('--title is required');
  if (data.tasks.some(t => t.id === id)) throw new Error(`task ${id} already exists`);
  for (const d of deps) if (!data.tasks.some(t => t.id === d)) throw new Error(`dependency ${d} does not exist yet; add it first`);
  if (!MODELS.includes(model)) throw new Error(`--model must be fast or deep, not "${model}"`);
  data.tasks.push({ id, title, files, criteria, deps, repo: repo || '', model, status: 'planned' });
  return data;
}

export function readyTasks(data) {
  const done = new Set(data.tasks.filter(t => t.status === 'done').map(t => t.id));
  return data.tasks.filter(t => t.status === 'planned' && t.deps.every(d => done.has(d)));
}

export function setStatus(data, id, to) {
  const t = data.tasks.find(x => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  if (!STATUSES.includes(to)) throw new Error(`unknown status "${to}"; use ${STATUSES.join(', ')}`);
  if (!TRANSITIONS[t.status].includes(to)) {
    throw new Error(`illegal transition ${t.status} -> ${to} for ${id}; allowed: ${TRANSITIONS[t.status].join(', ') || 'none'}`);
  }
  if (t.status === 'planned') {
    const open = t.deps.filter(d => data.tasks.find(x => x.id === d)?.status !== 'done');
    if (open.length) throw new Error(`${id} waits for ${open.join(', ')}`);
  }
  t.status = to;
  return data;
}

export function gateProblems(data) {
  if (!data.tasks.length) return ['no tasks'];
  return data.tasks.filter(t => t.status !== 'done').map(t => `${t.id} is ${t.status}`);
}

function flag(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

export function run(argv) {
  const [cmd, ...rest] = argv;
  const file = flag(rest, 'path', DEFAULT_PATH);
  const pos = positionals(rest);
  const write = (fn) => withStateLock(file, () => { const d = fn(load(file)); save(file, d); return d; });
  switch (cmd) {
    case 'add':
      write(d => addTask(d, {
        id: pos[0], title: flag(rest, 'title'), files: list(flag(rest, 'files')),
        criteria: list(flag(rest, 'criteria')), deps: list(flag(rest, 'deps')), repo: flag(rest, 'repo'), model: flag(rest, 'model'),
      }));
      console.log(`added ${pos[0]}`);
      return 0;
    case 'list':
      for (const t of load(file).tasks) console.log(`${t.id}\t${t.status}\t${t.model || 'fast'}\t${t.deps.join(',') || '-'}\t${t.title}`);
      return 0;
    case 'next':
      for (const t of readyTasks(load(file))) console.log(`${t.id}\t${t.title}`);
      return 0;
    case 'set':
      write(d => setStatus(d, pos[0], pos[1]));
      console.log(`${pos[0]} -> ${pos[1]}`);
      return 0;
    case 'gate': {
      const p = gateProblems(load(file));
      if (p.length) { console.log(`blocked\n${p.map(x => `- ${x}`).join('\n')}`); return 1; }
      console.log('ok: every task is done');
      return 0;
    }
    default:
      console.error('usage: eng.js add|list|next|set|gate [--path file]');
      return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
