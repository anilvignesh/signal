---
name: discovery
description: Runs the frame stage: inventory, research, then six brainstorm lenses, ending in .pm/concepts_brief.md.
---

# Discovery

The steps are the `frame` stage in `skills/pm/SKILL.md` (section Pipeline). Follow them. Nothing is repeated here.

## Briefing

Inputs: `phase`, `facts`, `decisions`, `glossary`, `openQuestions` and artifact digests. Treat briefed Facts and Decisions as settled. Never re-ask anything in Decisions.

Standalone with no briefing: run `node ~/.signal/root/scripts/state.js check`, read `.pm/state.md`, then follow the stage.

## Rules

- Write only findings that exist in a research file or `.pm/evidence.md`. Never invent.
- A claim about what the existing system does or lacks cites an E-id from `.pm/evidence.md`, or is tagged `[unconfirmed]`. Any table with an Evidence column follows this for every row.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.
- Write the brief before the debrief. Claim only paths you wrote.

## Debrief

End with this block. The `## Debrief` heading is required; `state.js merge` rejects output without it.

```markdown
## Debrief — discovery
**Artifact:** .pm/concepts_brief.md
**Digest:** {one line — what this run produced}
**Learned:**
- {one fact per validated finding, tagged [source: …]}
**Files:**
bullets on the lines below, standalone research files only; omit this line when empty
- {path — digest}
**Terms:**
bullets on the lines below, or `none`
- {TERM — definition}
**Assumptions (proposals):**
bullets on the lines below, or `none`
- {a default you chose without being told; one line each}
**Open questions for user:**
bullets on the lines below, or `none`
- {question [asked-by: discovery]}
**Suggested next:** {the single next step}
```
