#!/usr/bin/env node
// scripts/check-tests.js
// Release gate: tests ship in the same PR as the code they cover.
// Usage: node scripts/check-tests.js --repo <path> --base <ref>
// Fails when the diff changes source files but adds or changes no test file.
// A diff with no source files (docs, config, styles) passes.
// Read-only. No network. Exit: 0 ok, 1 no tests, 2 bad input.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GENERATED } from './pr-size.js';

export const SOURCE = /\.(py|js|jsx|ts|tsx|mjs|cjs|go|rb|java|kt|swift)$/;
export const TEST = /(^|\/)(tests?|__tests__|spec|e2e)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[a-z]+$|(^|\/)conftest\.py$/;
// Source that tests do not cover on their own: migrations, config, type stubs.
const EXEMPT = /(^|\/)(migrations|fixtures)\/|\.d\.ts$|(^|\/)[^/]*\.config\.[a-z]+$|(^|\/)(setup|manage|wsgi|asgi)\.py$/;

export function testCheck(git, base) {
  const all = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean).filter(f => !GENERATED.test(f));
  const tests = all.filter(f => TEST.test(f));
  const source = all.filter(f => SOURCE.test(f) && !TEST.test(f) && !EXEMPT.test(f));
  return { tests, source, ok: source.length === 0 || tests.length > 0 };
}

export function main(argv, out = console.log) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = flag('repo'), base = flag('base');
  if (!repo || !base) { out('usage: check-tests.js --repo <path> --base <ref>'); return 2; }
  const git = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = testCheck(git, base);
  if (r.ok) { out(`ok: ${r.source.length} source files, ${r.tests.length} test files`); return 0; }
  out(`no tests: ${r.source.length} source file(s) changed and no test file in the diff. Tests ship in the same PR as the code.`);
  for (const f of r.source.slice(0, 10)) out(`  ${f}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
