#!/usr/bin/env node
// scripts/pr-size.js
// Release gate: a PR must be small enough for a person to read. Default limit: 20 changed files.
// Usage: node scripts/pr-size.js --repo <path> --base <ref> [--max <n>] [--max-lines <n>]
// Counts files changed in `<base>...HEAD`. The limit is `maxFiles` in config/pr-routing.json, or --max.
// Also limits changed lines (`maxLines`, default 600). Lockfiles, snapshots, minified and map files count toward neither limit.
// Read-only. No network. Exit: 0 within the limits, 1 too big, 2 bad input.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAX = 20;
export const DEFAULT_MAX_LINES = 600;
// Files nobody reads line by line.
export const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum)$|\.(lock|snap|map)$|\.min\.(js|css)$/;

const CONFIG = path.join(HERE, '..', 'config', 'pr-routing.json');
const readConfig = (configPath) => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; } };
export const maxFiles = (configPath = CONFIG) => readConfig(configPath).maxFiles || DEFAULT_MAX;
export const maxLines = (configPath = CONFIG) => readConfig(configPath).maxLines || DEFAULT_MAX_LINES;

// git: (args) => stdout. Returns { files, lines, max, maxLines, ok, why }.
export function prSize(git, base, max = maxFiles(), limitLines = maxLines()) {
  const rows = git(['diff', '--numstat', `${base}...HEAD`]).split('\n').filter(Boolean).map(l => l.split('\t'));
  const kept = rows.filter(r => !GENERATED.test(r[2]));
  const files = kept.map(r => r[2]);
  const lines = kept.reduce((n, r) => n + (Number(r[0]) || 0) + (Number(r[1]) || 0), 0); // binary files show '-'
  const why = [];
  if (files.length > max) why.push(`${files.length} files changed (limit ${max})`);
  if (lines > limitLines) why.push(`${lines} lines changed (limit ${limitLines})`);
  return { files, lines, max, maxLines: limitLines, ok: why.length === 0, why };
}

export function main(argv, out = console.log) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = flag('repo'), base = flag('base');
  if (!repo || !base) { out('usage: pr-size.js --repo <path> --base <ref> [--max <n>] [--max-lines <n>]'); return 2; }
  const git = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = prSize(git, base, flag('max') ? Number(flag('max')) : maxFiles(), flag('max-lines') ? Number(flag('max-lines')) : maxLines());
  if (r.ok) { out(`ok: ${r.files.length} files, ${r.lines} lines changed (limits ${r.max} files, ${r.maxLines} lines)`); return 0; }
  out(`too big: ${r.why.join('; ')}. Split the work into smaller PRs.`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
