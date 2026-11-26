// tests/debrief.test.js
// Layer 2 — bus contract. Valid debriefs merge; malformed ones must fail loudly.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDebrief, validateDebrief } from '../scripts/state.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/debriefs');
const fx = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

test('valid-full parses every field including Terms', () => {
  const d = parseDebrief(fx('valid-full.md'));
  assert.equal(d.artifact, '.pm/research/regulatory.md');
  assert.equal(d.digest, 'RBI PA MD 2025 obligations mapped to key rotation');
  assert.equal(d.learned.length, 2);
  assert.equal(d.terms.length, 1);
  assert.match(d.terms[0], /^PA MD 2025 —/);
  assert.equal(d.openQuestions.length, 1);
  assert.match(d.next, /red-team/);
});

test('valid-minimal treats "none" as empty for Terms and Open questions', () => {
  const d = parseDebrief(fx('valid-minimal.md'));
  assert.equal(d.artifact, 'none');
  assert.equal(d.terms.length, 0);
  assert.equal(d.openQuestions.length, 0);
  assert.equal(d.learned.length, 1);
});

test('both valid fixtures pass validation', () => {
  for (const f of ['valid-full.md', 'valid-minimal.md']) {
    const v = validateDebrief(fx(f));
    assert.equal(v.ok, true, `${f} should validate, got: ${v.errors.join('; ')}`);
  }
});

test('prose with no Debrief block fails with a named reason', () => {
  const v = validateDebrief(fx('no-block.md'));
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /no "## Debrief" block/);
});

test('missing Artifact fails and names the field', () => {
  const v = validateDebrief(fx('missing-artifact.md'));
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Artifact/);
});

test('empty Learned list fails and names the field', () => {
  const v = validateDebrief(fx('missing-learned.md'));
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Learned/);
});

test('truncated block fails on the missing Suggested next', () => {
  const v = validateDebrief(fx('truncated.md'));
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Suggested next/);
});

test('empty and null input fail rather than throwing', () => {
  for (const input of ['', null, undefined]) {
    const v = validateDebrief(input);
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /no "## Debrief" block/);
  }
});

test('a field with no bullets does not inherit the next field\'s bullets', () => {
  const v = validateDebrief(fx('empty-learned-before-terms.md'));
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Learned/);
  const d = parseDebrief(fx('empty-learned-before-terms.md'));
  assert.deepEqual(d.learned, []);
  assert.deepEqual(d.terms, ['some term']);
});

test('empty Learned is accepted when Artifact is none', () => {
  const v = validateDebrief(`## Debrief — ac-agent
**Artifact:** none
**Digest:** Verdict: clean
**Learned:**
**Terms:** none
**Open questions for user:** none
**Suggested next:** freeze the PRD`);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(v.debrief.learned, []);
});

test('Learned with no Learned label at all is accepted when Artifact is none', () => {
  const v = validateDebrief(`## Debrief — ac-agent
**Artifact:** none
**Digest:** Verdict: clean
**Suggested next:** freeze the PRD`);
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('empty Learned is still rejected when a real Artifact is named', () => {
  const v = validateDebrief(`## Debrief — red-team
**Artifact:** .pm/red-team.md
**Digest:** nothing critical
**Learned:**
**Suggested next:** ship`);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Learned/);
});
