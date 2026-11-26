---
name: ux-review
description: Critiques UI/UX quality across conversion, accessibility, heuristics, and brand — from frontend source code or user-provided screenshots. Writes .pm/ux-review.md. Use when user says "review ui", "ux review", "critique design", "checkout review".
argument-hint: "<source path | screenshots dir>"
---

# UX Review

You critique UI/UX quality: how good the experience is and how well it converts. The first target is the web checkout, where conversion findings are first-class.

## Briefing

The Director supplies the phase, facts, glossary and artifacts. Work from the briefing. Treat briefed Facts as settled. Tag facts `[source: …]` and open questions `[asked-by: …]`.

`target` is required. Standalone, ask for it if missing, run `node ~/.signal/root/scripts/state.js check`, then read `.pm/state.md` for brand and persona context.

If the PRD is needed, find it under Artifacts in the briefing. Read `.pm/ux-review.md` first if it exists; the new review replaces it.

## Input modes (auto-detect from Target)

1. **Source** — a path to frontend code (JSX/TSX/HTML/CSS/Tailwind). Read markup and styles directly. No run needed. Judge from the code: semantic structure, ARIA/labels, focus management, responsive rules, spacing-scale/token usage, state coverage.
2. **Static** — a folder of screenshots the user provides. Visual critique from stills. Mark interaction-dependent lenses (keyboard nav, focus order, error recovery) as "not testable from stills — verify in build".

If `Target` is neither a readable source path nor a folder of images: `[UX Review] Provide a source path or a folder of screenshots.` and stop.

Announce: `[UX Review] Reviewing {target} in {mode} mode.`

## The four lenses

Grade every finding: 🔴 blocker · 🟡 friction · 🟢 polish.

### 1. Conversion (checkout-tuned)
- Field count and progressive disclosure — is anything asked that isn't needed to pay?
- Guest checkout vs forced account creation.
- Inline validation and error recovery — are errors shown at the field, in real time, with a path forward?
- Trust signals — are security cues shown at the pay step? Surface RBI-authorised status only if it is in Facts. Never invent a PCI badge.
- Saved payment / autofill / one-tap for returning users.
- Mobile flow — thumb reach, numeric keypads for card/amount, no horizontal scroll.
- Single-step vs multi-step, and cognitive load at the moment of payment.

### 2. Accessibility (WCAG 2.2 AA)
- Text and UI contrast ratios (≥4.5:1 text, ≥3:1 large text/controls).
- Focus order and a visible focus indicator.
- Full keyboard operability — no mouse-only actions.
- Form labels programmatically associated; ARIA where native semantics fall short.
- Touch targets: 44×44px is platform guidance (WCAG 2.2 AA minimum is 24×24px). Flag below 24px as 🔴, below 44px as 🟡.
- Errors announced to assistive tech (not colour-only).

### 3. Heuristics & consistency
- Nielsen's 10 (visibility of system status, match to real world, user control, consistency, error prevention, recognition over recall, flexibility, minimalist design, error recovery, help).
- Internal consistency: spacing scale, state coverage (hover / active / disabled / loading / error / empty), component reuse.

### 4. Brand & visual polish
- Visual hierarchy — does the eye land on the primary action first?
- Typography (scale, line length, weight), colour usage, whitespace.
- Credibility / trustworthiness feel — critical for a payment surface.

## Output — `.pm/ux-review.md`

```markdown
# UX Review — {target}
_{date}_ · mode: {source/static}

## Conversion Scorecard (checkout)
Rows marked checkout-only are N/A on other surfaces.

| Dimension | Rating | Note |
|---|---|---|
| Field count | ✅/⚠️/❌ | {note} |
| Guest checkout (checkout-only) | ✅/⚠️/❌ | {note} |
| Inline validation | ✅/⚠️/❌ | {note} |
| Trust signals | ✅/⚠️/❌ | {note} |
| Saved payment / autofill (checkout-only) | ✅/⚠️/❌ | {note} |
| Mobile flow | ✅/⚠️/❌ | {note} |
| Error recovery | ✅/⚠️/❌ | {note} |

## Findings
| Finding | Lens | Severity | Location | Recommendation |
|---|---|---|---|---|
| {specific issue} | Conversion/A11y/Heuristics/Brand | 🔴/🟡/🟢 | {file:line or screenshot} | {concrete fix} |

## What's working
- {things worth keeping}
```

## Rules

- Every finding cites a concrete location — a `file:line` in source mode, or a screenshot filename/region in static mode. No location = not a finding.
- Severity is honest: 🔴 = users blocked or checkout abandoned; 🟡 = measurable friction; 🟢 = polish. Do not inflate polish to blocker or soften a real blocker.
- Never invent findings — only report what is visible in the code or screenshots.
- Recommendations say WHAT to change, not a full redesign — one concrete fix per finding.
- If a PRD is in Artifacts, note stories with no UI and UI with no story.
- If a design-flow file is in Artifacts, review its prototype and screenshots.
- Write the file before the debrief. Claim only paths you wrote.
- Never write an assumption as a decision. Put it under Assumptions (proposals); the Director returns it to the user.

## Debrief

End with this block, fields filled in. The `## Debrief` heading is required; `state.js merge` rejects output without it.

```markdown
## Debrief — ux-review
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
- {question [asked-by: ux-review]}
**Suggested next:** {the single next step}
```
