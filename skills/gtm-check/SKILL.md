---
name: gtm-check
description: GTM readiness gate before shipping a version. Checks 9 gates (pricing, distribution, support, metrics, legal, engineering sign-off, rollback plan, communication, UX quality). Writes .pm/gtm-check.md. Blocks ship if critical gates are missing. Use when user says "gtm", "ship check", "launch ready?", "are we ready to ship".
argument-hint: "[v0|v1|v2]"
---

# GTM Check

## Inputs

- `version=vN`: the version being shipped. The Director passes it in the briefing. Default `v0` only when run standalone.

## Briefing

The Director gives you `phase`, `facts`, `decisions`, `artifacts` and `openQuestions`. Work from the briefing. Treat briefed Facts and Decisions as settled. Tag facts `[source: …]` and open questions `[asked-by: …]`.

Pre-fill every gate you can, tagged `[from context: {source}]`:
- Gate 4 (Metrics) from `.pm/metrics.md`, else `.pm/prd/{vN}/metrics.md`.
- Gate 5 (Legal / compliance) from regulatory Facts or `.pm/research/regulatory.md`.
- Any gate a Decision already answers.

Ask only the gates you could not pre-fill, in one message. Show the pre-filled answers so the user can correct them. Standalone with no state, ask one gate at a time. The GTM verdict is checkpoint 4.

Standalone: run `node ~/.signal/root/scripts/state.js check`, then read `.pm/state.md`.

## Process

### Phase A: Load context

1. Read the briefing: domain, personas, north star.
2. Read `.pm/prd/{vN}/prd.md`. If it does not exist, stop: `[GTM] No PRD found for {vN}. Run /prd {vN} first.`
3. Read `.pm/ux-review.md`, `.pm/research/regulatory.md`, `.pm/red-team.md` and `.pm/data-model.md` if they exist.
4. Announce: `[GTM] Checking readiness for {product} {vN}`

### Phase B: Gate questions

Ask the gates below that are not pre-filled.

**Gate 1 — Pricing**
"Is the pricing model for {vN} confirmed? What's the value metric, price point, and free tier (if any)?"

**Gate 2 — Distribution**
"How are users finding out about this launch? What's the channel, who's responsible, and what's the timeline?"

**Gate 3 — Customer support**
"How do users get help when something goes wrong? (docs, in-app tooltip, support queue)"

**Gate 4 — Metrics**
If neither metrics file exists, ask: "No measurement plan on record — is there a dashboard tracking {north star metric} in production?" If none, the gate is ❌.

**Gate 5 — Legal / compliance**
"Is legal or compliance sign-off confirmed for all regulatory requirements identified in the PRD?"

**Gate 6 — Engineering sign-off**
"Have all acceptance criteria in `.pm/prd/{vN}/acceptance-criteria.md` been verified as passing?" Record ❌ only when the user answered it.

**Gate 7 — Rollback plan**
"If {vN} has a critical bug post-launch, what's the rollback procedure and who executes it?"

**Gate 8 — Communication plan**
"Who needs to be notified at launch? (internal: team, leadership; external: customers, partners)"

**Gate 9 — UX quality**
Pre-filled from `.pm/ux-review.md` when it exists. Count its findings as open unless the file is dated after the last change to the surface; if unsure, ask. Any open 🔴 → ❌. Only open 🟡 → ⚠️. None, or no user-facing surface → ✅. If the file is absent and {vN} ships a user-facing UI, ask: "No UX review on record — run /ux-review first, or ship without one?"

### Phase C: Assess and write

Classify each gate:

- ✅ **CONFIRMED** — answer was specific and complete
- ⚠️ **WEAK** — answer was vague, partial, or "we'll figure it out", or an unresolved Open Question bears on the gate
- ❌ **MISSING** — no plan exists, or an unresolved Open Question leaves the gate unanswerable

**Blocker gates** (any ❌ here = DO NOT SHIP):
- Pricing
- Legal / compliance
- Engineering sign-off
- Rollback plan

Write `.pm/gtm-check.md`. It overwrites the prior version's verdict.

```markdown
# GTM Plan — {product} {vN}
_{date}_

| Gate | Status | Detail |
|---|---|---|
| Pricing | ✅/⚠️/❌ | {answer summary or gap description} |
| Distribution | ✅/⚠️/❌ | {answer summary or gap description} |
| Customer support | ✅/⚠️/❌ | {answer summary or gap description} |
| Metrics | ✅/⚠️/❌ | {measurement plan summary, or "no .pm/metrics.md on record"} |
| Legal / compliance | ✅/⚠️/❌ | {answer summary or gap description} |
| Engineering sign-off | ✅/⚠️/❌ | {answer summary or gap description} |
| Rollback plan | ✅/⚠️/❌ | {answer summary or gap description} |
| Communication plan | ✅/⚠️/❌ | {answer summary or gap description} |
| UX quality | ✅/⚠️/❌ | {open 🔴/🟡 counts from .pm/ux-review.md, or "no user-facing surface"} |

## Verdict: {SHIP / SHIP WITH WARNINGS / DO NOT SHIP}

{If DO NOT SHIP: list the blocking gaps and what's needed to unblock each}
{If SHIP WITH WARNINGS: list the warnings and confirm the user acknowledges them}
```

**Verdict rules:**
- Any ❌ on a blocker gate → **DO NOT SHIP**
- Any ⚠️ on a blocker gate → **SHIP WITH WARNINGS**
- Any ❌ on a non-blocker gate (Distribution, Support, Metrics, Communication, UX quality) → **SHIP WITH WARNINGS**
- 3 or more ⚠️ on any gates → **SHIP WITH WARNINGS**
- All ✅, or 1–2 ⚠️ on non-blocker gates → **SHIP**

For SHIP WITH WARNINGS, list the ⚠️ and ❌ gates before writing and ask: "These warnings will be recorded in the GTM plan. Acknowledged? (y/n)". On y, write the file. On n, stop, write nothing, and list the gaps.

## Rules

- If Engineering sign-off is ❌, ask: `[GTM] No eng sign-off — acceptance criteria haven't been verified. Continue the GTM check anyway? (y/n)`
- DO NOT SHIP is non-negotiable. Do not soften it.
- Write the file before the debrief. Claim only paths you wrote.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.

## Debrief

End with this block, fields filled in. The `## Debrief` heading is required; `state.js merge` rejects output without it.

```markdown
## Debrief — gtm-check
**Artifact:** {path you wrote, or "none"}
**Digest:** {one line — what this run produced}
**Learned:**
- {each distilled fact, with [source: …]}
**Terms:**
bullets on the lines below, or `none`
- {TERM — definition}
**Assumptions (proposals):**
bullets on the lines below, or `none`
- {a default you chose without being told; one line each}
**Open questions for user:**
bullets on the lines below, or `none`
- {question [asked-by: …]}
**Suggested next:** {the single next step}
```
