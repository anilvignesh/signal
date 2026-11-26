---
name: prioritize
description: Buckets open discovery tasks into v0/v1/v2 and writes .pm/backlog.md.
---

# Prioritize

Bucket the open tasks in `.pm/discovery.md` into v0/v1/v2. Output is `.pm/backlog.md`. Each run overwrites it.

## Briefing

Inputs: `phase`, `facts`, `decisions`, `glossary`, `openQuestions` and artifact digests. Treat briefed Facts and Decisions as settled. Work only from what you are given.

Standalone with no briefing: run `node ~/.signal/root/scripts/state.js check`, read `.pm/state.md`, and read `.pm/discovery.md`.

Pre-answer from the briefing, tagged `[from context: {source}]`. Ask only residual questions, in one message.

## Process

### Phase A: Load context

1. Read the north star and personas from the glossary and facts. Ask the user only if they are absent.
2. Read `.pm/discovery.md`. Collect every `- [ ]` task.
3. Apply each Decision tagged `[at: prioritisation]` as a fixed bucket.
4. Skip tasks already in a frozen `.pm/prd/*`.
5. Announce: `[Prioritize] Found {N} open tasks across {M} sessions.`

No open tasks: `[Prioritize] No open tasks found in .pm/discovery.md. Run /discovery first.`

### Phase B: Bucket

Priority tags from discovery (P0/P1/P2) are a hint only.

**v0: must ship for the north star**
- Directly enables the north star.
- Needed for the product to be usable at all.
- Needed for regulatory compliance, if it applies.
- Target 3–7 tasks. If more qualify, challenge each one.

**v1: important, not blocking**
- Improves the north star, or is P1 and reduces friction in the core flow.
- Signals from discovery (3+) are evidence. They are not required.

**v2: nice to have**
- Improves the experience beyond the north star. Low urgency.

Present:

```
v0 — Must ship ({N} tasks)
  • {task}

v1 — Important, not blocking ({N} tasks)
  • {task}

v2 — Nice to have ({N} tasks)
  • {task}
```

Ask: "Does this bucketing look right? Any tasks to move before I lock it?" Wait for the answer before Phase C.

### Phase C: Dependencies and write

1. For each v0 task, note which v1/v2 tasks it enables or is blocked by.
2. Warn about circular dependencies.
3. Write `.pm/backlog.md`:

```markdown
# Backlog — {product}
_{date}_

## v0 — Must ship for north star

| Task | Source session | Enables |
|---|---|---|
| {task} | {session date} | {v1/v2 tasks this unlocks} |

## v1 — Important, not blocking

| Task | Source session | Blocked by |
|---|---|---|
| {task} | {session date} | {v0 tasks required first, or "none"} |

## v2 — Nice to have

| Task | Source session | Notes |
|---|---|---|
| {task} | {session date} | {why deferred} |

## Cut line

{What is in v0 and what is out. For each task just below the line, one line on why it is out.}
```

## Rules

- If the north star is unclear, ask before bucketing.
- Keep v0 small enough to ship and test.
- Do not write Decisions. The Director records the lock with `state.js decide … --at prioritisation`.
- Write the backlog before the debrief. Claim only paths you wrote.
- Learned: one fact per bucket decision, plus the cut line. Tag `[source: …]`.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.

## Debrief

End with this block, fields filled in. The `## Debrief` heading is required; `state.js merge` rejects output without it.

```markdown
## Debrief — prioritize
**Artifact:** .pm/backlog.md
**Digest:** {one line — what this run produced}
**Learned:**
- {one fact per line, tagged [source: …]}
**Terms:**
- {TERM — definition, one bullet per term, or "none"}
**Assumptions (proposals):**
bullets on the lines below, or `none`
- {a default you chose without being told; one line each}
**Open questions for user:**
- {question [asked-by: prioritize], or "none"}
**Suggested next:** {the single next step}
```
