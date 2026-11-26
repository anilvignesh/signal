---
name: maintain-context
description: Trims .pm/state.md Facts to 30 when over the limit and writes .pm/handoff.md when a session ends.
---

# Maintain Context

## When to run

- `node ~/.signal/root/scripts/state.js check` reports Facts over the 30-bullet limit.
- The session is ending.

## Briefing

Inputs: `phase`, `facts`, `decisions`, `glossary`, `openQuestions` and `next`. Treat briefed Facts and Decisions as settled. Work only from what you are given.

## Process

### Facts over limit

1. Run `node ~/.signal/root/scripts/state.js check`.
2. If over the limit, run `node ~/.signal/root/scripts/state.js archive`. It trims the oldest Facts to 30 and writes them to `.pm/context/archive.md` under a dated header.
3. Report the line `archive` printed, verbatim.

### Session ending

Write `.pm/handoff.md`. Overwrite it each time. It describes the current pause point only.

```markdown
# Handoff — {date}

## Phase
{phase from state.md}

## Key decisions
{2–4 bullets from Decisions dated today, or "none today"}

## Open questions
{bullets from Open Questions, or "none"}

## Next
{the Next step from state.md}
```

Report: "Handoff written to .pm/handoff.md. Next session resumes from: {next step}."

## Rules

- Only `state.js archive` trims Facts. Never edit the Facts list by hand.
- Write the handoff before the debrief. Claim only paths you wrote.
- Learned needs at least one fact whenever Artifact is `.pm/handoff.md`, for example the pause point you recorded.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.

## Debrief

End with this block, fields filled in. The `## Debrief` heading is required; `state.js merge` rejects output without it.

```markdown
## Debrief — maintain-context
**Artifact:** {`.pm/handoff.md` if you wrote it, else "none"}
**Digest:** {one line — what this run produced}
**Learned:**
- {one fact per line, tagged [source: …]; at least one when Artifact is `.pm/handoff.md`}
**Terms:**
bullets on the lines below, or `none`
- {TERM — definition}
**Assumptions (proposals):**
bullets on the lines below, or `none`
- {a default you chose without being told; one line each}
**Open questions for user:**
bullets on the lines below, or `none`
- {question [asked-by: maintain-context]}
**Suggested next:** {the single next step}
```
