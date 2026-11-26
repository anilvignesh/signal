---
name: publish-clickup
description: Publishes a frozen PRD version to ClickUp as one PRD-style ticket in the Product and Business Backlog list, with the PRD as a linked ClickUp Doc. Always shows a dry run first and creates nothing without an explicit yes. Use when the user says "publish to clickup", "push this PRD to the backlog".
---

# publish-clickup

Optional add-on. Publishes one frozen PRD version to ClickUp as ONE ticket in Product and Business → Backlog.

**Confirmation rule:** Nothing is created until the user answers yes to "Create these in ClickUp now? (yes/no)" (or "Create these anyway? (yes/no)" when ticket.md is stale). It is asked once, after the dry run. No answer, or a non-interactive run, means stop and create nothing.

This skill orchestrates two existing skills: `clickup_prd` (the PRD as a ClickUp Doc shared with the workspace) and `clickup-backlog` (the Backlog ticket).

## Before you publish

Run this checklist before any write. If a step fails, stop and say which one. Create nothing.

1. Credential: the tracker key is set in the environment (the variable named in `.pm/refs.json` or the setup answers). Print only its length, never the value.
2. Cheap read: make one small read call (for example, list one page of the Backlog). It proves the tool works and shows the rate-limit headers.
3. Lint: `node ~/.signal/root/scripts/lint.js <file>` passes for the PRD and the ticket draft.
4. Duplicate check: compare the title and topic against `.pm/existing.md`. If an overlap or contradiction is listed, show it in the dry run and ask before going on.

## Publish rules

- ONE write call per page. Never append into a live page in chunks.
- If a page is too large for one call, stage it in a NEW doc first. Read it back and compare headings, row counts and links against the source. Only then switch the links to the new doc.
- On any rate-limit or error, stop. Leave the live page untouched. Report the exact error.
- Record every created id in `.pm/published.json` (`{"items":[{"kind":"doc|ticket","id":"...","url":"...","published":"<iso>","verified":true}]}`). Set `verified` true only after the read-back matches.
- Never delete anything.
- Create tickets only after the duplicate check.

## 1. Preconditions

Ask which version if unclear. Let `{vN}` be that version.

- Run `node ~/.signal/root/scripts/state.js prd-status {vN}`. It must print `frozen`. If it prints anything else, say what it printed and stop. `incomplete` means finish the freeze first via /pm continue.
- `.pm/prd/{vN}/ticket.md` must exist. If not, tell the user to run the tickets agent through /pm, then stop.

## 2. Dry run (always first)

Print:

- Ticket title.
- Target list: Product and Business → Backlog.
- The Doc it would create.
- Links the ticket will contain: PRD doc, acceptance criteria path, and every file found by listing `.pm/design/*/flow.md`, `.pm/red-team.md`, `.pm/data-model.md` and `.pm/metrics.md`. Show one link line per file found. Say `none found` only when the listing is empty. Do not rely on ticket.md alone for links.
- Stale check: if `.pm/prd/{vN}/ticket.md` is older than any of `.pm/red-team.md`, `.pm/data-model.md`, `.pm/metrics.md`, `.pm/design/*/flow.md`, `.pm/gtm-check.md`, show `ticket.md was drafted before <file> changed; re-run the tickets agent first`. Never regenerate the ticket in this skill.
- Open questions.
- What will be created: one Doc, one ticket.

Then ask: "Create these in ClickUp now? (yes/no)". If the stale warning was shown, ask "Create these anyway? (yes/no)" instead. Stop there.

## 3. Create (only after yes)

1. Run the `clickup_prd` skill for the PRD Doc.
2. Run the `clickup-backlog` skill for the ticket, with the Doc link.

Let both skills apply their own rules and confirmations. Never bypass their critic or review steps. Create nothing outside the Backlog list. Never delete or edit existing tickets.

## 4. Record

Write `.pm/prd/{vN}/published.md` with the ticket URL, Doc URL, date and who ran it.

Write `.pm/debrief.md` ending with this block, then merge it:

```markdown
## Debrief — publish-clickup
**Artifact:** .pm/prd/{vN}/published.md
**Digest:** {one line, e.g. "v1 PRD published as 1 Doc and 1 Backlog ticket"}
**Learned:**
- {each fact, e.g. "PRD v1 is tracked in ticket X [source: tracker: <url>]"}
**Terms:** none
**Open questions for user:**
- {each, or `none`}
**Suggested next:** {single next step}
```

```
node ~/.signal/root/scripts/state.js merge .pm/debrief.md --skill publish-clickup
```

## Failures

If a ClickUp tool is unavailable or errors, report the exact error. Say what exists and what does not. Never retry a create blindly: first search the Backlog for the ticket to avoid duplicates.
