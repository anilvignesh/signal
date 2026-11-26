#!/usr/bin/env node
// scripts/mistakes.js — append-only log of rules learned from corrections and failures.
// Project file: .pm/mistakes.md. Global file: $SIGNAL_HOME/mistakes.md (default ~/.signal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HEADER =
  '# Mistakes\n' +
  'Rules learned from corrections and failures. The Director passes the newest relevant rules to each agent.\n';
const SEP = ' · ';

export const signalHome = () => process.env.SIGNAL_HOME || path.join(os.homedir(), '.signal');
export const globalPath = () => path.join(signalHome(), 'mistakes.md');

// "name (role)" from $SIGNAL_HOME/identity.json, else "unknown".
export function whoAmI() {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(signalHome(), 'identity.json'), 'utf8'));
    if (id.name) return id.role ? `${id.name} (${id.role})` : String(id.name);
  } catch { /* no identity */ }
  return 'unknown';
}

// Create the file with the header if missing. Never overwrites.
export function ensureMistakesFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, HEADER, { flag: 'wx' }); return true; } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

export function addMistake({ text, rule, agent = 'general', source = 'user', file = '.pm/mistakes.md', date, who } = {}) {
  const what = oneLine(text);
  const r = oneLine(rule);
  if (!what) throw new Error('Empty text — say what went wrong.');
  if (!r) throw new Error('Empty rule — pass --rule "<the rule that prevents it>".');
  ensureMistakesFile(file);
  const day = date || new Date().toISOString().slice(0, 10);
  const heading = ['## ' + day, oneLine(agent) || 'general', who || whoAmI(), source].join(SEP);
  const body = `\n${heading}\n- **What went wrong:** ${what}\n- **Rule:** ${r}\n`;
  fs.appendFileSync(file, body);
  return { date: day, agent: oneLine(agent) || 'general', who: who || whoAmI(), source, what, rule: r };
}

// Entries oldest to newest, as written.
export function readMistakes(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const part of fs.readFileSync(file, 'utf8').split(/^## /m).slice(1)) {
    const [head, ...lines] = part.split('\n');
    const [date, agent, ...rest] = head.split(SEP).map(s => s.trim());
    const source = rest.pop();
    const who = rest.join(SEP);
    const field = (label) => {
      const l = lines.find(x => x.startsWith(`- **${label}:**`));
      return l ? l.slice(`- **${label}:**`.length).trim() : '';
    };
    if (!date || !agent) continue;
    out.push({ date, agent, who, source, what: field('What went wrong'), rule: field('Rule') });
  }
  return out;
}

const applies = (e, agent) => e.agent === 'general' || e.agent === agent;

// Newest rules for an agent: up to 5 from the project file, up to 3 from the global file.
export function rulesFor(agent, { project, global, projectMax = 5, globalMax = 3 } = {}) {
  const pick = (file, max) => (file ? readMistakes(file).filter(e => applies(e, agent)).slice(-max).reverse().map(e => e.rule).filter(Boolean) : []);
  return { project: pick(project, projectMax), global: pick(global, globalMax) };
}

function parseArgs(argv) {
  const o = { pos: [], global: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--global') o.global = true;
    else if (['--rule', '--agent', '--path'].includes(a)) o[a.slice(2)] = argv[++i];
    else o.pos.push(a);
  }
  return o;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  const file = o.global ? globalPath() : (o.path || '.pm/mistakes.md');
  try {
    if (cmd === 'add') {
      const e = addMistake({ text: o.pos[0], rule: o.rule, agent: o.agent || 'general', source: 'user', file });
      console.log(`Recorded in ${file}: ${e.rule}`);
      return 0;
    }
    if (cmd === 'list') {
      const n = Number(o.pos[0]) || 10;
      const rows = readMistakes(file).filter(e => !o.agent || e.agent === o.agent).slice(-n).reverse();
      if (!rows.length) { console.log('No mistakes recorded.'); return 0; }
      for (const e of rows) {
        console.log(`## ${[e.date, e.agent, e.who, e.source].join(SEP)}\n- **What went wrong:** ${e.what}\n- **Rule:** ${e.rule}\n`);
      }
      return 0;
    }
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  console.error('Usage: mistakes.js <add "<what went wrong>" --rule "<rule>" [--agent <name>] [--global] [--path <file>] | list [n] [--agent <name>] [--global]>');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exit(cli(process.argv.slice(2)));
}
