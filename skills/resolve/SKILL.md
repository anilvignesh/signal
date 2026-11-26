---
name: resolve
description: Resolve rules for a review report. Runs in the main thread. Sorts each finding into CONTEST, ESCALATE, PROPOSE FIX or DECLINE, then walks the user through the decisions one question at a time. Use after a review stage report exists.
---

# Resolve

Run in the main thread, in the session that wrote the document. You hold the author's context. That is also your bias: wanting to contest a finding is not evidence that the reviewer is wrong.

## Inputs

- The review report path, `.pm/review/<stage>.md`.
- The target document path.

## Process

1. Read the report and the target.
2. Give each finding exactly one category:
   - CONTEST: the finding is wrong. Cite evidence the reviewer could read: a file and symbol, an E-id in `.pm/evidence.md`, or a decision recorded in the document.
   - ESCALATE: the finding looks wrong, but the evidence is outside every file the reviewer could read (a team convention, a verbal decision). Say so. Do not fix it. Give it to the user.
   - PROPOSE FIX: the finding is right. Write the exact replacement text or structure change.
   - DECLINE: the finding is a Nit and not worth a change. Record it. A Nit may still get PROPOSE FIX if the fix is cheap.
3. Write the sorted list to `.pm/review/<stage>-resolve.md`. Per finding, one `### {finding title}` heading (the exact title from the report), then `Category:`, `Reason:`, `Edit:` and `Status: open`.
4. Ask the user, one question at a time, in this order: ESCALATE items first (they need the user's knowledge), then PROPOSE FIX, then CONTEST. Per item the choices are:
   - ESCALATE: add the fact to the document, or confirm no change.
   - PROPOSE FIX: accept, skip.
   - CONTEST: agree with the contest, or overrule it and apply a fix.
   Offer "accept all proposed fixes" once, before the item loop.
5. Apply only what the user accepted, in one batch, to the target. Then set each `Status:` to `fixed` (edit applied), `contested` (user agreed), `accepted` (user confirmed no change) or leave `open`.
6. Re-audit: run the same stage once more with the review-synthesizer. Stop after that one re-audit. Add each new finding to the resolve file as `Status: open`, and give it to the user as an open question. Do not loop again. `state.js review-gate` reads these statuses before the freeze.

## Rules

- A contest must be checkable. "This was intentional" is not evidence. With no readable evidence, use ESCALATE or PROPOSE FIX.
- Never contest a comprehension gap. If a fresh reader could not follow the document, the document lacks context.
- Do not add text only to satisfy a reviewer. Add context when a human reader needs it. If only a zero-context reviewer needs it, ESCALATE.
- Never change a severity. If you think a Blocker is a Nit, CONTEST it and state the reason.
- No file edits until the user has answered. One question per turn.
- One re-audit per stage, no more.
- End by stating the counts: accepted, contested, escalated, declined, left open.
