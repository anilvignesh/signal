#!/usr/bin/env node
// bin/signal.js — `signal watch` follows the run log; `signal setup-hooks` and `signal mistakes` manage hooks and the mistakes log.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLines, formatEvent } from '../scripts/runlog.js';
import { summarize } from '../scripts/cost.js';
import { setupHooks } from '../scripts/setup-hooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PM = path.join(process.cwd(), '.pm');
const RUN_LOG = path.join(PM, 'run.log');
const COST_LOG = path.join(PM, 'cost.log');

const HELP = `signal — Signal from any project that has .pm/

  signal watch    follow the run log in this terminal, with a cost total
  signal setup-hooks [--remove]
                  add (or remove) the hooks that log real token counts in this project's .claude/settings.json
  signal mistakes ...
                  mistakes log commands (see scripts/mistakes.js)
  signal help     show this text

Run /setup in Claude Code first if the project has no .pm/state.md.`;

function costLine() {
  if (!fs.existsSync(COST_LOG)) return 'Cost: no runs logged yet.';
  const rows = parseLines(fs.readFileSync(COST_LOG, 'utf8'));
  if (!rows.length) return 'Cost: no runs logged yet.';
  const t = summarize(rows).total;
  return `Cost: ${t.runs} run${t.runs === 1 ? '' : 's'}  est ${t.est}  actual ${t.actual} tokens`;
}

function watch() {
  const lines = fs.existsSync(RUN_LOG) ? parseLines(fs.readFileSync(RUN_LOG, 'utf8')) : [];
  for (const ev of lines.slice(-20)) console.log(formatEvent(ev));
  let offset = fs.existsSync(RUN_LOG) ? fs.statSync(RUN_LOG).size : 0;
  let cost = costLine();
  console.log(cost);
  console.log('Watching .pm/run.log. Ctrl+C to stop.');

  fs.watchFile(RUN_LOG, { interval: 250 }, (cur) => {
    if (cur.size < offset) offset = 0; // file was replaced
    if (cur.size === offset) return;
    const fd = fs.openSync(RUN_LOG, 'r');
    const buf = Buffer.alloc(cur.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = cur.size;
    for (const ev of parseLines(buf.toString('utf8'))) console.log(formatEvent(ev));
  });
  fs.watchFile(COST_LOG, { interval: 250 }, () => {
    const next = costLine();
    if (next !== cost) { cost = next; console.log(cost); }
  });
}

const cmd = process.argv[2] || 'help';
if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
} else if (cmd === 'setup-hooks') {
  const rest = process.argv.slice(3);
  const bad = rest.filter(a => a !== '--remove');
  if (bad.length) { console.error(`Unknown option "${bad[0]}". Use: signal setup-hooks [--remove]`); process.exit(1); }
  try {
    const remove = rest.includes('--remove');
    const { file, changes } = setupHooks({ cwd: process.cwd(), remove });
    if (!changes.length) console.log(remove ? `No Signal hooks found in ${file}.` : `Hooks already set up in ${file}. Nothing changed.`);
    else {
      console.log(`${remove ? 'Removed Signal hooks from' : 'Updated'} ${file}:`);
      for (const c of changes) console.log(`  ${c}`);
      console.log('Restart or reload Claude Code in this project for the change to take effect.');
    }
  } catch (err) { console.error(err.message); process.exit(1); }
} else if (cmd === 'mistakes') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/mistakes.js'), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else if (cmd !== 'watch') {
  console.error(`Unknown command "${cmd}". Try: signal help`);
  process.exit(1);
} else if (!fs.existsSync(path.join(PM, 'state.md'))) {
  console.error('No Signal state here. Run /setup in Claude Code first.');
  process.exit(1);
} else {
  watch();
}
