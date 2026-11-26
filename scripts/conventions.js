#!/usr/bin/env node
// scripts/conventions.js — per-repo coding conventions. They live in the repo, in `.signal/`.
//   conventions.js init  --repo <path>               write a starter conventions.md and an empty rules.json
//   conventions.js brief --repo <path>               print conventions.md for the builder's prompt
//   conventions.js check --repo <path> --base <ref>  run rules.json against the added lines
// rules.json: [{ "id", "section", "files": "regex", "skip": "regex", "line": "regex", "unless": "regex", "msg" }]
// Read-only except `init`. No network. Exit: 0 ok or no .signal folder, 1 findings, 2 bad input.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addedLines } from './no-claude-scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIR = '.signal';

export function loadRules(repo) {
  const f = path.join(repo, DIR, 'rules.json');
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  return raw.map(r => ({ ...r, files: new RegExp(r.files || '.'), skip: r.skip ? new RegExp(r.skip) : null,
    line: new RegExp(r.line), unless: r.unless ? new RegExp(r.unless) : null }));
}

// added: [{file, line, text}]
export function checkAdded(added, rules) {
  const hits = [];
  for (const a of added) for (const r of rules) {
    if (!r.files.test(a.file) || (r.skip && r.skip.test(a.file))) continue;
    if (r.line.test(a.text) && !(r.unless && r.unless.test(a.text))) hits.push({ id: r.id, section: r.section, where: `${a.file}:${a.line}`, msg: r.msg });
  }
  return hits;
}

export function main(argv, out = console.log) {
  const [cmd, ...rest] = argv;
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const repo = flag('repo');
  if (!['init', 'brief', 'check'].includes(cmd) || !repo) { out('usage: conventions.js init|brief|check --repo <path> [--base <ref>]'); return 2; }
  const dir = path.join(repo, DIR);
  if (cmd === 'init') {
    fs.mkdirSync(dir, { recursive: true });
    const md = path.join(dir, 'conventions.md'), rj = path.join(dir, 'rules.json');
    if (!fs.existsSync(md)) fs.writeFileSync(md, fs.readFileSync(path.join(HERE, '..', 'extras', 'conventions-template.md'), 'utf8'));
    if (!fs.existsSync(rj)) fs.writeFileSync(rj, '[]\n');
    out(`wrote ${DIR}/conventions.md and ${DIR}/rules.json (existing files are never overwritten). Edit them, then commit.`);
    return 0;
  }
  if (!fs.existsSync(path.join(dir, 'conventions.md')) && !fs.existsSync(path.join(dir, 'rules.json'))) {
    out(`no ${DIR}/ folder in this repo. Run: conventions.js init --repo ${repo}`);
    return 0;
  }
  if (cmd === 'brief') { try { out(fs.readFileSync(path.join(dir, 'conventions.md'), 'utf8')); } catch { out('(no conventions.md)'); } return 0; }
  const base = flag('base');
  if (!base) { out('usage: conventions.js check --repo <path> --base <ref>'); return 2; }
  const git = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const hits = checkAdded(addedLines(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', `${base}...HEAD`])), loadRules(repo));
  if (!hits.length) { out('ok: added lines follow the repo rules'); return 0; }
  for (const h of hits) out(`${h.where} [${h.section || h.id}] ${h.msg}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
