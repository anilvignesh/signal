import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lintText, main } from '../scripts/lint.js';

const FX = path.join(import.meta.dirname, 'fixtures', 'lint');
const f = (n) => path.join(FX, n);
const run = (...a) => { const out = [], err = []; const code = main(a, l => out.push(l), l => err.push(l)); return { code, out, err }; };

test('old failure fixture fails with every rule named', () => {
  const r = run(f('old-failure.md'), '--style', f('style.json'));
  assert.equal(r.code, 1);
  const text = r.out.join('\n');
  for (const rule of ['banned-word', 'banned-pattern', 'status', 'table-row', 'count', 'required-line', 'link']) {
    assert.match(text, new RegExp(` ${rule} `), rule);
  }
  assert.match(text, /old-failure\.md:3 banned-word banned word "AcmeBank"/);
  assert.match(text, /old-failure\.md:3 banned-word banned word "BetaBank"/);
  assert.match(text, /old-failure\.md:7 banned-pattern/);
  assert.match(text, /:9 table-row/);
  assert.match(text, /:12 count Total says 5, table above has 4 rows/);
  assert.doesNotMatch(text, /GammaBank/); // banned word inside a URL is skipped
  assert.match(r.out.at(-1), /findings in/);
});

test('clean fixture passes', () => {
  const r = run(f('clean.md'), '--style', f('style.json'));
  assert.equal(r.code, 0);
  assert.match(r.out.at(-1), /^clean:/);
});

test('--json output', () => {
  const r = run(f('old-failure.md'), '--style', f('style.json'), '--json');
  const j = JSON.parse(r.out[0]);
  assert.equal(j.clean, false);
  assert.ok(j.findings.every(x => x.file && 'line' in x && x.rule && x.message));
});

test('bad input exits 2', () => {
  assert.equal(run().code, 2);
  assert.equal(run(f('nope.md')).code, 2);
  assert.equal(run(f('clean.md'), '--style', f('nope.json')).code, 2);
  assert.equal(run(f('clean.md'), '--style', f('clean.md')).code, 2);
  assert.equal(run(f('clean.md'), '--style', f('style.json'), '--refs', f('nope.json')).code, 2);
});

test('banned words are whole words, case-insensitive', () => {
  assert.equal(lintText('Axiom and Taxis', { banned_words: ['GammaBank'] }).length, 0);
  assert.equal(lintText('say gammabank.', { banned_words: ['GammaBank'] }).length, 1);
});

test('table_columns and total on a table with the status column inside the table', () => {
  const t = '| Rule | Status |\n|---|---|\n| a | Built |\n| Total | 2 |\n';
  const r = lintText(t, { status_words: ['Built'], table_columns: { Rule: 3 } });
  assert.deepEqual(r.map(x => x.rule).sort(), ['count', 'table-columns']);
});

test('total is ignored when the table has no status column', () => {
  const t = '| A | B |\n|---|---|\n| 1 | 2 |\n\nTotal | 9\n';
  assert.equal(lintText(t, {}).length, 0);
});

test('no style file means no rules but links still checked', () => {
  const r = lintText('[x](~/a.md) [y](#anchor)', {});
  assert.equal(r.length, 1);
  assert.equal(r[0].rule, 'link');
});

test('cli runs as a script', () => {
  const p = spawnSync('node', [path.join(import.meta.dirname, '..', 'scripts', 'lint.js'), f('clean.md'), '--style', f('style.json')], { encoding: 'utf8' });
  assert.equal(p.status, 0);
});

const EV = path.join(FX, 'ev');
test('evidence: passing pair is clean', () => {
  const r = run(path.join(EV, 'pass.md'), '--evidence', path.join(EV, 'evidence.md'));
  assert.equal(r.code, 0, r.out.join('\n'));
});

test('evidence: failing pair reports unknown, missing and weak ids', () => {
  const r = run(path.join(EV, 'fail.md'), '--evidence', path.join(EV, 'evidence.md'));
  assert.equal(r.code, 1);
  const t = r.out.join('\n');
  assert.match(t, /:5 unknown-evidence-id E-009/);
  assert.match(t, /:6 missing-evidence-id/);
  assert.match(t, /:7 weak-evidence E-003 is PARTLY/);
});

test('evidence: explicit missing file is exit 2; default is picked up next to the style file', () => {
  const r = run(path.join(EV, 'pass.md'), '--evidence', path.join(EV, 'nope.md'));
  assert.equal(r.code, 2);
  assert.match(r.err.join(''), /evidence file not found/);
  const d = run(path.join(EV, 'fail.md'), '--style', path.join(EV, 'style.json'));
  assert.equal(d.code, 1);
  assert.match(d.out.join('\n'), /unknown-evidence-id/);
  // no evidence file next to the style file: rules are skipped
  assert.doesNotMatch(run(path.join(EV, 'fail.md'), '--style', f('style.json')).out.join('\n'), /evidence-id|weak-evidence/);
});

test('lint runs and fails through a symlinked path, as installed (no silent pass)', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const pathx = await import('node:path');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'lint-link-'));
  const link = pathx.join(dir, 'root');
  fsx.symlinkSync(pathx.resolve(new URL('..', import.meta.url).pathname), link);
  const bad = pathx.join(dir, 'bad.md');
  fsx.writeFileSync(bad, '| A | Status today |\n|---|---|\n| x | Banana |\n');
  const styleFile = pathx.join(dir, 'style.json');
  fsx.writeFileSync(styleFile, JSON.stringify({ status_words: ['Covered'] }));
  const r = spawnSync('node', [pathx.join(link, 'scripts', 'lint.js'), bad, '--style', styleFile], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'must exit 1 on a finding, got ' + r.status + ' stdout=' + r.stdout);
  assert.match(r.stdout, /status/i);
  const missing = spawnSync('node', [pathx.join(link, 'scripts', 'lint.js'), pathx.join(dir, 'nope.md')], { encoding: 'utf8' });
  assert.equal(missing.status, 2, 'missing file must exit 2 through the symlink');
});

const EC = path.join(FX, 'evcheck');
const ec = (d, ...x) => run('--check-evidence', path.join(EC, d, 'evidence.md'), ...x);

test('check-evidence: good file is clean, refs.json picked up next to it', () => {
  const r = ec('good');
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.match(r.out.at(-1), /^clean:/);
});

test('check-evidence: prose-only file gives no-evidence-blocks', () => {
  const r = ec('prose');
  assert.equal(r.code, 1);
  assert.match(r.out.join('\n'), /evidence\.md:1 no-evidence-blocks/);
});

test('check-evidence: NOT FOUND with a one-item Searched line', () => {
  const r = ec('thin');
  assert.equal(r.code, 1);
  assert.match(r.out.join('\n'), /evidence\.md:4 thin-searched/);
});

test('check-evidence: wrong sha gives ref-mismatch; --refs and --json work', () => {
  const r = ec('badsha', '--refs', path.join(EC, 'badsha', 'refs.json'), '--json');
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out[0]);
  assert.deepEqual(j.findings.map(x => x.rule), ['ref-mismatch']);
  assert.equal(ec('badsha').code, 1);
});

test('check-evidence: bad input exits 2', () => {
  assert.equal(run('--check-evidence', path.join(EC, 'nope.md')).code, 2);
  assert.equal(run('--check-evidence').code, 2);
  assert.equal(ec('good', '--refs', path.join(EC, 'nope.json')).code, 2);
});

test('check-evidence: runs through a symlinked path and exits 1 on findings', async () => {
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'lint-ev-link-'));
  const link = path.join(dir, 'root');
  fsx.symlinkSync(path.resolve(import.meta.dirname, '..'), link);
  const r = spawnSync('node', [path.join(link, 'scripts', 'lint.js'), '--check-evidence', path.join(EC, 'prose', 'evidence.md')], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no-evidence-blocks/);
});
