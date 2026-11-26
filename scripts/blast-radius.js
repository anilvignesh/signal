#!/usr/bin/env node
// scripts/blast-radius.js
// Release gate: finds existing functions, classes and endpoints that the diff changes, and counts where else the repo uses them.
// A change to something used in `maxBlast` (default 5) or more places stops the release, unless the PR gives a reason.
// Usage: node scripts/blast-radius.js --repo <path> --base <ref> [--max <n>] [--justified "<why a lighter change was not possible>"]
// HEURISTIC: it matches names. A common name over-counts. A written reason clears the stop.
// Pure additions at the top level (new functions) are not counted. Changes that only add lines, or add an optional input, are noted and allowed. Read-only. No network.
// Exit: 0 ok, 1 wide change, 2 bad input.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BLAST = 5;
const CODE = /\.(py|js|jsx|ts|tsx|mjs|go|rb|java|kt)$/;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[a-z]+$|conftest\.py$/;
const DEF = /^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)|^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)/;
const SKIP_NAMES = new Set(['__init__', '__str__', '__repr__', 'constructor', 'render', 'setUp', 'tearDown', 'Meta']);

export const maxBlast = (cfg = path.join(HERE, '..', 'config', 'pr-routing.json')) => {
  try { return JSON.parse(fs.readFileSync(cfg, 'utf8')).maxBlast || DEFAULT_BLAST; } catch { return DEFAULT_BLAST; }
};

const nameOf = (line) => { const m = line.match(DEF); return m ? (m[1] || m[2] || m[3] || m[4]) : null; };
const indentOf = (line) => line.match(/^\s*/)[0].length;

// The def/class that holds line `n` (1-based) of `lines`, or null.
export function enclosing(lines, n) {
  const here = lines[n - 1] ?? '';
  let want = indentOf(here) + (here.trim() ? 1 : 0);
  for (let i = Math.min(n, lines.length) - 1; i >= 0; i--) {
    const name = nameOf(lines[i]);
    if (name && indentOf(lines[i]) < want) return name;
    if (name && i === n - 1) return name;
  }
  return null;
}

// A one-line signature change that only adds an optional input: `def f(a)` becomes `def f(a, ref=None)`.
export function optionalParamOnly(oldLine, newLine) {
  const strip = (l) => l.trim().replace(/\)\s*(->[^:]*)?:?\s*\{?$/, '');
  const o = strip(oldLine), n = strip(newLine);
  if (!nameOf(oldLine) || !n.startsWith(o) || n.length === o.length) return false;
  const extra = n.slice(o.length);
  return /^\s*,/.test(extra) && /=/.test(extra);
}

// Changed existing definitions: [{file, name, additive}]. `additive` means the diff only adds lines or an optional input.
export function changedDefs(git, base) {
  const out = new Map();
  const diff = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', `${base}...HEAD`]);
  let file = null, old = null, hunk = null;
  const flush = () => {
    if (!hunk) return;
    const { start, count, removed, added } = hunk; hunk = null;
    if (!old) return;
    const name = enclosing(old, count === 0 ? start : start);
    if (!name || SKIP_NAMES.has(name)) return;
    // A pure addition at the top level is a new definition, not a change to an old one.
    if (count === 0 && indentOf(old[start] ?? '') === 0 && indentOf(old[start - 1] ?? '') === 0) return;
    const additive = removed.length === 0 || (removed.length === 1 && added.length === 1 && optionalParamOnly(removed[0], added[0]));
    const key = `${file}:${name}`, prev = out.get(key);
    out.set(key, { file, name, additive: additive && (prev ? prev.additive : true) });
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) { flush(); const f = line.slice(4).replace(/^a\//, ''); file = f === '/dev/null' ? null : f; old = null; continue; }
    if (line.startsWith('+++ ')) continue;
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      flush();
      if (!file || !CODE.test(file) || TEST.test(file)) continue;
      if (old === null) { try { old = git(['show', `${base}:${file}`]).split('\n'); } catch { old = []; } }
      hunk = { start: Number(h[1]), count: h[2] === undefined ? 1 : Number(h[2]), removed: [], added: [] };
      continue;
    }
    if (hunk && line.startsWith('-')) hunk.removed.push(line.slice(1));
    else if (hunk && line.startsWith('+')) hunk.added.push(line.slice(1));
  }
  flush();
  return [...out.values()];
}

// Places that use `name` outside tests, not counting its own definition line.
export function uses(git, name, ref = 'HEAD') {
  let raw = '';
  try { raw = git(['grep', '-n', '-w', '-I', '-e', name, ref, '--']); } catch { return []; }
  return raw.split('\n').filter(Boolean)
    .map(l => { const m = l.replace(new RegExp(`^${ref}:`), '').match(/^([^:]+):(\d+):(.*)$/); return m && { file: m[1], line: Number(m[2]), text: m[3] }; })
    .filter(Boolean)
    .filter(u => CODE.test(u.file) && !TEST.test(u.file) && nameOf(u.text) !== name);
}

export function blast(git, base, max = maxBlast()) {
  const wide = [], notes = [];
  for (const d of changedDefs(git, base)) {
    const u = uses(git, d.name);
    const files = new Set(u.map(x => x.file)).size;
    if (files < max) continue;
    (d.additive ? notes : wide).push({ ...d, uses: u.length, files });
  }
  const by = (a, b) => b.files - a.files;
  return { wide: wide.sort(by), notes: notes.sort(by), max };
}

export function main(argv, out = console.log) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = flag('repo'), base = flag('base');
  if (!repo || !base) { out('usage: blast-radius.js --repo <path> --base <ref> [--max <n>] [--justified "<reason>"]'); return 2; }
  const git = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = blast(git, base, flag('max') ? Number(flag('max')) : maxBlast());
  for (const w of r.notes) out(`note: ${w.name} in ${w.file} is used in ${w.files} files. The change only adds, which is fine.`);
  if (!r.wide.length) { out(`ok: no changed definition is used in ${r.max} or more files`); return 0; }
  for (const w of r.wide) out(`wide: ${w.name} in ${w.file} is used in ${w.files} files (${w.uses} references), and the change alters existing lines`);
  if ((flag('justified') || '').trim()) { out(`allowed: reason given: ${flag('justified').trim()}`); return 0; }
  out(`stop: this change touches shared code. Use new code beside the old, or an optional input. If a lighter way is not possible, pass --justified "<why>".`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
