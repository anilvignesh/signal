// scripts/verify-agents.js
// Layer 3 — dispatch every agent against a fixture product and check its real output.
// Pass --live to dispatch every agent for real (see classifyClaudeFailure below) — off by
// default because it burns real Claude quota and takes minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseState, composeBriefing, resolveOutputPath, mergeDebrief } from './state.js';
import { hasClaude, runAgent as runClaudeAgent } from './claude.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { skills } = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/registry.json'), 'utf8'));

const FIXTURE = `# Signal State — Fixture Payments Co
_Updated 2026-07-31 by verify_

## Phase
Design — merchant API key rotation

## Facts
- Merchants cannot rotate API secrets without contacting support [source: voc]
- A VAPT finding requires self-service rotation [source: security]

## Decisions
- 2026-07-31 — Maximum two active secret keys per merchant [at: design]

## Glossary
- PA-CB — Payment Aggregator Cross Border, the RBI licence class

## Open Questions
- Should rotation be allowed before account activation? [asked-by: discovery]

## Artifacts
| File | Digest | Updated |
|---|---|---|
| .pm/prd/v0.md | Key rotation PRD, 5 stories | 2026-07-31 |

## Next
Red-team the rotation design
`;

// Fixture values for every registry entry that declares `params`. If a future
// skill adds a `params` block without a matching entry here, that skill's
// output path would keep an unresolved {placeholder} — see the explicit check
// for that below, rather than silently letting it slip through unparameterised.
const PARAMS = { research: { lens: 'regulatory' }, prd: { version: 'v0' }, 'ac-agent': { version: 'v0' }, 'ux-review': { target: 'README.md' }, 'review-synthesizer': { stage: 'zoom-out' }, resolve: { stage: 'zoom-out' } };

function report(name, status, detail) {
  const mark = { PASS: '  ok  ', FAIL: ' FAIL ', SKIP: ' SKIP ' }[status];
  console.log(`${mark} ${name.padEnd(18)} ${detail}`);
}

// Environment-vs-defect line for a failed --live claude run. runAgent
// can return four reasons.
//
//   - 'claude-missing'     the binary isn't on PATH — environment
//   - 'timeout'            the CLI didn't respond in time — environment
//   - 'invocation-failed'  the binary ran but exited non-zero — environment (the agent
//                          never produced output for the debrief contract to judge)
//   - 'invalid-debrief'    the CLI ran, returned a response, and that response failed
//                          the debrief contract — the agent's own output being wrong —
//                          a real FAIL
function classifyClaudeFailure(r) {
  if (r.reason === 'invalid-debrief') {
    return { kind: 'FAIL', detail: `${r.errors.join('; ')} — raw at ${r.logPath}` };
  }
  if (r.reason === 'claude-missing') {
    return { kind: 'SKIP', detail: 'claude not installed — see https://docs.claude.com/en/docs/claude-code for setup' };
  }
  if (r.reason === 'timeout') {
    return { kind: 'SKIP', detail: `claude timed out — ${r.errors.join('; ')}` };
  }
  // 'invocation-failed', or any other reason we don't yet know about: still
  // environment, not a contract violation — the agent never got to run.
  return {
    kind: 'SKIP',
    detail: `claude invocation failed (${r.errors.join('; ') || 'no detail'}) — treating as environment, see ${r.logPath}`,
  };
}

async function main() {
  const LIVE = process.argv.includes('--live');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-verify-'));
  const statePath = path.join(dir, 'state.md');
  fs.writeFileSync(statePath, FIXTURE);
  const state = parseState(FIXTURE);
  const claude = LIVE ? hasClaude() : false;

  console.log(`\nSignal — Layer 3 agent verification${LIVE ? ' (--live)' : ''}`);
  console.log(`Fixture: ${statePath}`);
  console.log(LIVE
    ? `Claude:  ${claude ? 'available — dispatching agents for real' : 'NOT INSTALLED — agents will skip'}\n`
    : `Claude:  contract-only — pass --live to dispatch agents for real\n`);

  const results = [];
  for (const [name, entry] of Object.entries(skills)) {
    if (entry.kind === 'spine') continue;

    // Check 0 — the registry's declared path actually exists on disk. Layer 1
    // (registry.test.js) already asserts this for the checked-in registry,
    // but Layer 3 must not trust that it ran first, or crash the whole sweep
    // (an unguarded fs.readFileSync below) if a path is wrong — one bad
    // entry should FAIL that one agent and let the sweep continue.
    const skillPath = path.join(ROOT, entry.path);
    if (!fs.existsSync(skillPath)) {
      report(name, 'FAIL', `registry declares path "${entry.path}" which does not exist on disk`);
      results.push('FAIL'); continue;
    }

    // Params the registry requires for this skill must have a fixture value,
    // or the output path (and the briefing) would carry an unresolved param.
    // Checked explicitly, rather than assumed, in case a future skill adds
    // `params` without a matching PARAMS entry here.
    const params = PARAMS[name] || {};
    if (entry.params) {
      const missing = Object.keys(entry.params).filter(k => params[k] === undefined);
      if (missing.length) {
        report(name, 'FAIL', `no fixture value for required param(s) "${missing.join(', ')}" — add one to PARAMS in this script`);
        results.push('FAIL'); continue;
      }
    }

    // Check 1 — the briefing composes and contains only the declared sections.
    let briefing;
    try {
      briefing = composeBriefing(state, { ...entry, name }, params);
    } catch (err) {
      report(name, 'FAIL', `briefing failed to compose: ${err.message}`);
      results.push('FAIL'); continue;
    }
    if (!/## Briefing —/.test(briefing) || !/Debrief block/.test(briefing)) {
      report(name, 'FAIL', 'briefing is malformed');
      results.push('FAIL'); continue;
    }

    // Check 2 — the declared output path resolves with no leftover placeholders.
    const out = resolveOutputPath(entry, params);
    if (out && /\{/.test(out)) {
      report(name, 'FAIL', `unresolved placeholder in outputs: ${out}`);
      results.push('FAIL'); continue;
    }

    // Check 3 — live dispatch. Without --live this script only proves the contract
    // (briefing composes, output path resolves): the Director dispatches subagents inside a
    // live Claude Code session, which a plain script cannot do. --live trades that speed for
    // a real round trip via `claude -p`.
    if (!LIVE) {
      report(name, 'PASS', 'contract ok (dispatch verified by the Director; pass --live for a real dispatch)');
      results.push('PASS'); continue;
    }

    if (!claude) {
      report(name, 'SKIP', 'claude not installed — see https://docs.claude.com/en/docs/claude-code for setup');
      results.push('SKIP'); continue;
    }

    let skillText;
    try {
      skillText = fs.readFileSync(skillPath, 'utf8');
    } catch (err) {
      report(name, 'FAIL', `could not read ${entry.path}: ${err.message}`);
      results.push('FAIL'); continue;
    }

    // A framing line comes first: skillText opens with a SKILL.md's YAML frontmatter
    // "---", and a value starting with "-" risks being misread as a flag by the CLI.
    const prompt = `You are dispatched as the "${name}" agent. Follow the SKILL.md below, then the briefing.\n\n${skillText}\n\n---\n\n${briefing}`;
    // cwd: dir confines this real dispatch to the fixture's scratch directory. The
    // agent's SKILL.md instructs it to write into .pm/... — if it actually acts on
    // that (rather than just describing the write in its response), this keeps that
    // write inside the temp fixture rather than the real repo's .pm/.
    const r = await runClaudeAgent(name, prompt, { runDir: path.join(dir, 'runs'), cwd: dir });

    if (!r.ok) {
      const { kind, detail } = classifyClaudeFailure(r);
      report(name, kind, detail);
      results.push(kind); continue;
    }

    if (out && r.debrief.artifact !== out) {
      report(name, 'FAIL', `wrote "${r.debrief.artifact}", registry declares "${out}"`);
      results.push('FAIL'); continue;
    }
    const merged = mergeDebrief(state, r.debrief, { date: '2026-07-31' });
    if (merged.facts.length <= state.facts.length) {
      report(name, 'FAIL', 'debrief produced no new facts');
      results.push('FAIL'); continue;
    }
    report(name, 'PASS', `${r.debrief.learned.length} fact(s) · ${r.logPath}`);
    results.push('PASS'); continue;
  }

  const count = (s) => results.filter(r => r === s).length;
  console.log(`\n${count('PASS')} passed · ${count('FAIL')} failed · ${count('SKIP')} skipped\n`);
  process.exit(count('FAIL') > 0 ? 1 : 0);
}

main();
