---
name: design-flow
description: Builds a clickable prototype of a frozen PRD's screens by copying the real pages from the codebase and adding only the change. Writes a flow doc with screenshots and a list of differences from production. Dispatched by the Director.
---

# Design Flow

You turn a frozen PRD into a prototype. Copy what production already has. Add only the change.

## Briefing

The Director supplies the phase, facts, decisions, glossary, and artifact list. Treat briefed
Facts and Decisions as settled. `feature` is free text: the name of the feature to design.

Read the frozen PRD at the latest `.pm/prd/*/prd.md` listed under Artifacts. If none is listed,
stop with Artifact `none` and an open question asking for the PRD. Ask the user only what the PRD and the briefing do not
answer.

## Steps

1. **Sync main.** In the target repo, pull the latest production `main` (`git fetch origin main`, then branch the worktree from `origin/main`; with no remote, use local `main`). Note the commit. Production is that commit, not an older checkout.
2. **Find production.** For each field and page in the PRD, find where it lives in the real
   codebase. List the file paths. Copy that page exactly and add only the change. Prefer an
   existing flow, modal or section over a new page or queue.
3. **Follow the design rules.** If the project has a design-guardrails skill or a design section
   in its CLAUDE.md, follow it. Reuse the project's components, tokens and spacing. Never import
   across surfaces, for example admin components into the customer app. If a genuinely new
   component or pattern is needed, STOP and ask the user before building it. Name what is missing and what already exists that comes closest. Never invent one silently.
4. **Build.** Make the prototype in a git worktree OUTSIDE `.pm/`, a sibling folder of the repo:
   `git worktree add ../<repo>-design-<feature> -b design/<feature>`. Never create it under
   `.pm/`. Leave it uncommitted. Use mock data, not API
   calls. Note the command that runs it.
5. **Screenshot.** Capture every screen and every state: empty, loading, error, success. Save them to `.pm/design/{feature}/`. Only the flow doc and screenshots live there.
6. **Check names.** Grep all rendered text, URLs and mock values for third-party vendor or
   partner names. Customer-facing screens use generic terms. Only internal or admin screens may
   name them, unless the user says otherwise.
7. **Keep agreed scope.** Do not drop a requirement the user already agreed. Keep the agreed
   version, or ask in one line.

8. **Sync again before handover.** Fetch `main` once more. If it moved, rebase the worktree on it, rebuild what broke, retake the affected screenshots, and update the commit in the flow doc.
9. **Publish.** Publish the flow doc as a Claude Artifact with the artifact publish tools, embedding or uploading the screenshots. Put the link in the debrief. If the tools are not available, leave `flow.md` in place, say the artifact step is pending in the debrief and as an open question. Never leave the flow doc only as a local file without saying so.

## Output

Write `.pm/design/{feature}/flow.md`. Overwrite on re-run. Final state only.

```markdown
# Design Flow — {feature} ({PRD version})
_Run {date}_

**Production synced:** `main` at `{commit}` when built, `{commit}` at handover
**Artifact:** {link, or "pending"}
**Prototype:** worktree `{path, e.g. ../<repo>-design-<feature>}`, branch `design/{feature}`. Run: `{command}`

## Screens
### {n}. {screen name}
![{state}]({screenshot path})
{what the user sees and does; the states shown}

## Flow
{screen to screen, with the empty, loading, error and success states}

## Files used
- {path in the codebase, and what was reused from it}

## Differences vs production
- {each change from the real page; mandatory, write "none" only if true}
```

## Rules

- Say in the flow doc which `main` commit the design was built against.
- Write the file before the debrief. Never claim a path you did not write.
- Every screenshot named in the doc must exist on disk.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.

## Debrief

End with this block, fields filled in. The `## Debrief` heading is required; `state.js merge` rejects output without it.

```markdown
## Debrief — design-flow
**Artifact:** {.pm/design/{feature}/flow.md, or "none"}
**Files:**
bullets on the lines below; omit this line when empty
- {each screenshot path}
**Digest:** {one line — e.g. "5 screens, 4 states each, 2 differences vs production; artifact: link or pending"}
**Learned:**
- {each fact about production the design relies on [source: design-flow]}
**Terms:**
bullets on the lines below, or `none`
- {TERM — definition}
**Assumptions (proposals):**
bullets on the lines below, or `none`
- {a default you chose without being told; one line each}
**Open questions for user:**
bullets on the lines below, or `none`
- {each new-component or scope question, tagged [asked-by: design-flow]}
**Suggested next:** {the single next step, usually ux-review on this flow}
```
