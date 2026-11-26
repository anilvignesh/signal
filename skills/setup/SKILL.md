---
name: setup
description: Creates .pm/state.md for a new product from 10 questions. Run once per product, before any other Signal skill.
---

# Setup

## What it creates

Creates `.pm/state.md`, `.pm/mistakes.md`, `.pm/style.json` and `.pm/refs.json`.

## Briefing

None. Nothing exists yet. Work from the user's answers.

## Process

In auto mode (`state.js mode` prints `auto`), `/signal` has already asked these questions in its one batch. Do not ask them again; use its answers.

Ask these 10 questions in one numbered message. Follow up only on skipped or unclear answers.

1. What is the product? One sentence: what it does and for whom.
2. Who are the primary users? Up to 3.
3. What geography and market? For example India, RBI-regulated, FEMA in scope.
4. What product category? For example fintech, SaaS, marketplace, internal tool.
5. Which 3–5 domain terms would an AI agent misunderstand without a definition? For example "IEC", "FIRA".
6. What is the north star metric? The one number that shows the product is working.
7. Is there an existing prototype, design or spec to load? Give a path, or say "no".
8. Scope: what is in and what is out? Name the entity, lane, market and product.
9. Who reads the output, at what reading level? What is the unit of any document (one row per what)? Follow the source's own structure, no internal codes. How long should it be?
10. Naming and where work lives. Which words must never be printed? Which code formats must be avoided? Where does existing work live (tracker, memory, wiki)? Which environment variable holds the credentials? Never ask for the secret itself.

Then:

1. Run `node ~/.signal/root/scripts/state.js init "<product name>"`. If it refuses because state already exists, stop and tell the user. Never pass `--force` unless the user asks.
2. Run `node ~/.signal/root/scripts/state.js phase "Setup complete — awaiting first goal"`.
3. Write the project files from answers 8 to 10. Skip a file when its answers are all skipped.
   - `node ~/.signal/root/scripts/state.js style init`, then `style merge '<json>'` with only the keys you have answers for: `banned_words`, `banned_patterns` (regex), `status_words`, `required_lines` (the scope line from Q8), `table_columns` (heading to column count).
   - `node ~/.signal/root/scripts/state.js refs init`, then `refs merge '<json>'` with `deployed_ref`, `pinned_commit`, `other_refs`, `open_changes`, `repos` (`{name, path}`) and `search_areas`. Code is in scope only if the user named a repo; then `deployed_ref` and `pinned_commit` are both required, so ask once for what is missing.
   - Both commands refuse unknown keys. Run `merge` again to change a value; lists add, they do not replace.
4. Standalone: write the debrief to `.pm/debrief.md` and run `node ~/.signal/root/scripts/state.js merge .pm/debrief.md --skill setup`. If it is rejected, fix the debrief and run it again. If the Director dispatched you, do not merge; it does.
5. Announce: "Signal is ready. Run /pm run <goal> to drive the lifecycle, or /pm to start."

## Rules

- Work from the answers. Skipped question: leave that fact or term out. Never invent.
- Write state only through `state.js`.
- Glossary holds domain terms only, never implementation detail.
- Write the debrief last. Claim only what the merge folds into state.
- Tag facts `[source: user]`.
- Q8 to Q10: each answer is one Fact tagged `[source: user]` (scope, reader and unit, naming rules, where work lives). Put the credential variable name in a Fact, never its value.
- Q7 with a path: add `- Prototype/spec at <path> [source: user]` to Learned.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.


## Debrief

End with this block, fields filled in. The `## Debrief` heading is required; `state.js merge` rejects output without it.

```markdown
## Debrief — setup
**Artifact:** none
**Digest:** {one line — what this run produced}
**Learned:**
- {one fact per line, with [source: …]}
**Terms:**
- {TERM — definition}
**Assumptions (proposals):**
- {a default you chose where the user did not answer}
**Open questions for user:**
- {question only the user can answer} [asked-by: setup]
**Suggested next:** {the single next step}
```

`Terms`, `Open questions for user` and `Assumptions (proposals)` take `none` when empty. An assumption is a proposal, never a decision: `state.js merge` turns each one into an open question the user must answer.
