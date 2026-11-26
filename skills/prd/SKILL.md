---
name: prd
description: Drafts a PRD for a version (v0/v1/v2) section by section, writes BDD acceptance criteria via AC Agent, then versions all artifacts to .pm/prd/{version}/ at freeze. Review is a separate stage (see skills/pm/SKILL.md, Pipeline). Never overwrites a previous version — each version is frozen forever. Use when user says "write prd", "spec", "write acceptance criteria", or "version v0".
argument-hint: "[v0|v1|v2]"
---

# PRD

## Inputs

- `version=vN`: the Director always passes it. Default `v0` only when run standalone.

## Briefing

The Director gives you `phase`, `facts`, `decisions`, `glossary`, `openQuestions` and `artifacts`. Work from the briefing. Treat briefed Facts and Decisions as settled. Tag facts `[source: …]` and open questions `[asked-by: …]`.

Read files only for these:

- `.pm/concepts_brief.md`, first.
- N > 0: `.pm/prd/v{N-1}/prd.md`, for its Out of scope and Open questions.
- `.pm/backlog.md` when it exists, for the tasks bucketed to `vN`.

Standalone: run `node ~/.signal/root/scripts/state.js check`, read `.pm/state.md`, then read the files above.

The draft stage (Phases A to D) ends with a draft. Review runs after it, as the Director's `review` stage. Phase E freezes the draft, only after `state.js review-gate` passes and the Director records `decide … --at prd-freeze`. Standalone, ask the user "Freeze {vN}? (y/n)" instead. Auto mode never skips this yes.

## Process

### Phase A: Load context

1. Read the briefing: domain, north star, personas.
2. Read `.pm/concepts_brief.md`. Take the tasks bucketed to `vN` from `.pm/backlog.md` when it exists; otherwise take scope from the brief's recommended direction.
3. Run `node ~/.signal/root/scripts/state.js prd-status {vN}` and act on the first word:
   - `frozen`: stop with `[PRD] .pm/prd/{vN}/ already exists — versioned specs are frozen. Use /prd v{N+1} for the next version.`
   - `incomplete`: a freeze was interrupted. If the freeze decision is in the briefing's Decisions, go straight to Phase E. Otherwise tell the user and stop.
   - `draft`: do not redraft. Continue from Phase B, C or E, wherever the draft stands.
   - `none`: proceed.
4. If there is no brief and no tasks for `vN`, stop: `[PRD] No concepts brief or prioritised tasks for {vN}. Run the frame stage first.`
5. Announce: `[PRD] Drafting {vN} for {product}.`

### Phase B: Draft PRD, section by section

Before drafting, dispatch ground (`brief ground`) for every premise about the existing system. Its evidence feeds "Current state". A premise ground cannot confirm is marked unconfirmed.

Write the sections in this order into `.pm/prd-draft/prd.md`. After each one, show it and ask ONE question: approve or revise? In auto mode (`state.js mode`), approve it, log `state.js assume "<section> approved as drafted"`, and go on. Revise means rewrite that section and ask again. Do not start the next section before approval.

1. Overview and Goals: the problem, who has it, what we build, in one paragraph each. Put "Current state" first, one line per premise with its evidence id (E-nnn) or "unconfirmed".
2. Success metrics: a table of metric, baseline, target, how measured.
3. Stories: one per task or per direction in the brief.
   `**As** {persona}, **I want** {capability} **so that** {concrete outcome}.` then `**In scope:**` and `**Out of scope for this story:**`.
4. Out of scope: what is not built in this version, and why.
5. Open questions: anything unresolved that could change scope.

Title the file `# {Product} — {vN} PRD` with the date under it.

### Phase C: AC Agent, then stop

Run AC Agent (`skills/agents/ac-agent/SKILL.md`) with `.pm/prd-draft/prd.md`, the briefing and the target path `.pm/prd-draft/acceptance-criteria.md`. Then announce and end your run with the debrief:

`[PRD] Draft ready — awaiting review`

### Phase E: Freeze (one-way door)

Run only after the freeze decision is in the briefing's Decisions, or the user answered y standalone.

1. Run `state.js review-gate`; if it fails, stop and show its output. Run `prd-status {vN}`. Stop only on `frozen`. On `incomplete`, resume: the freeze writes only what is missing.
2. `mkdir -p .pm/prd/{vN}`, then move `.pm/prd-draft/prd.md` and `.pm/prd-draft/acceptance-criteria.md` into it, skipping any already there. Remove `.pm/prd-draft/` if it exists.
3. Write the files below that are missing, from the existing `.pm/prd/{vN}/prd.md`.

**`.pm/prd/{vN}/metrics.md`**:
```markdown
# Success Metrics — {vN}
_{date}_

## Primary Metric
{metric, baseline, target, tracking method}

## Supporting Metrics
{table from PRD}

## Measurement Plan
{how each metric is tracked in production — dashboard, query, or event}
```

**`.pm/prd/{vN}/CHANGELOG.md`**:
```markdown
# Changelog — {vN}
_{date}_

## What's in {vN}
{list of user stories shipped}

## What was cut (and why)
{everything from "Out of scope" — explicit reason for each}

## Decisions made this version
{decisions from the briefing, or "none"}
```

**`.pm/prd/{vN}/one-pager.md`**:
```markdown
# {Product} {vN} — One Pager
_{date}_

## Problem
{one sentence}

## Solution
{one sentence}

## Who it's for
{persona(s) from the Glossary/Facts}

## How we'll know it's working
{primary metric + target}

## What's in {vN}
{bullet list of stories — one line each}

## Key decisions made
{decisions from the briefing worth highlighting}
```

**`.pm/prd/{vN}/story-map.md`**:
```markdown
# Story Map — {product} {vN}
_{date}_

| Story | Persona | Blocked by |
|---|---|---|
| {story title} | {persona} | {dependency or "none"} |
```

Announce: `[PRD] {vN} versioned — {N} stories. .pm/prd/{vN}/ is now frozen. Run /gtm-check {vN} when ready to ship.`

## Rules

- The PRD is a product document: no implementation details, no architecture decisions.
- The primary metric must appear in Success metrics, or the PRD is incomplete.
- Open questions is required. If there are none, write "None — all ambiguities resolved in the brief."
- Assumptions: a default you chose is never written as a decision. Put it in the debrief Assumptions field.
- Write files before the debrief. Claim only paths you wrote.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.

## Debrief

End with this block, fields filled in. The `## Debrief` heading is required; `state.js merge` rejects output without it.

Draft: the Artifact is `.pm/prd-draft/prd.md`, and the caller's path overrides the briefing's Output line. Phase E: the Artifact is `.pm/prd/{vN}/prd.md`, and `**Files:**` lists the other five files. Omit `**Files:**` in the draft.

```markdown
## Debrief — prd
**Artifact:** {path you wrote, or "none"}
**Digest:** {one line — what this run produced}
**Learned:**
- {each distilled fact, with [source: …]}
**Files:**
bullets on the lines below, Phase E only; omit this line when empty
- {path — digest}
**Terms:**
bullets on the lines below, or `none`
- {TERM — definition}
**Assumptions (proposals):**
bullets on the lines below, or `none`
- {a default you chose without being told; one line each}
**Open questions for user:**
bullets on the lines below, or `none`
- {question [asked-by: …]}
**Suggested next:** {the single next step; after a freeze, name `tickets` to draft the backlog ticket}
```
