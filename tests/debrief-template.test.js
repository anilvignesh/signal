import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'SKILL.md' ? [path.join(d, e.name)] : []);
const withTemplate = walk(root).map((f) => [f, fs.readFileSync(f, 'utf8')])
  .filter(([, s]) => /^\*\*Terms:\*\*/m.test(s));

test('debrief templates exist', () => assert.ok(withTemplate.length >= 17));

for (const [f, s] of withTemplate) {
  test(`${path.relative(root, f)} has Assumptions field after Terms, before Open questions`, () => {
    const t = s.indexOf('**Terms:**');
    const a = s.indexOf('**Assumptions (proposals):**');
    const o = s.indexOf('**Open questions for user:**');
    assert.ok(t < a && a < o);
  });
  test(`${path.relative(root, f)} has the assumption rule`, () => {
    assert.ok(s.includes('Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.'));
  });
}
