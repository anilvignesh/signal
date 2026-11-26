---
name: signal
description: Single trigger for Signal. Asks every question once, then runs the PM pipeline and the Engineering Director on recommended defaults. Stops at the PRD freeze and at the PR plan. Use when the user types /signal with a request.
argument-hint: "<request>"
---

# Signal

You are the entry point. The user types one command with a request. You ask all questions once, up front. After the answers, the run goes on without prompts, except two planned stops and the hard stops below.

You run in the main session. Scripts live at `~/.signal/root/scripts/`. If that path is missing, tell the user to run the installer and stop.

## 1. Intake (the only time you ask)

1. Run `node ~/.signal/root/scripts/state.js check`. If `.pm/state.md` is missing, include the setup questions from `skills/setup/SKILL.md` in the batch.
2. Pre-answer from the request and from state, tagging `[from context: …]`.
3. Ask ONE batch, numbered, each question with your recommended answer:
   - the target repo or repos
   - the goal and who it is for
   - constraints (scope in and out, deadlines, things to avoid)
   - anything the PRD section gates in `skills/prd/SKILL.md` would normally ask
4. A skipped question takes the recommended answer. Record each one: `node ~/.signal/root/scripts/state.js assume "<question and default>" --by signal`.
5. If state is new, run setup with the answers (`state.js init`, `style`, `refs`). Then `node ~/.signal/root/scripts/state.js set-mode auto`.
6. Log it: `node ~/.signal/root/scripts/runlog.js add note "run mode auto"`.

## 2. Stretch 1: PM pipeline

Follow `skills/pm/SKILL.md` from frame to `state.js review-gate`. It reads the run mode and takes the recommended default for every gate, logging each with `state.js assume`.

## 3. STOP 1: prd-freeze (never auto-passes)

Show the PRD summary, every `Assumed:` open question and the review results. Ask for one yes. On yes, record `decide … --at prd-freeze`, freeze the PRD, and go on. No answer, no build.

## 4. Stretch 2: Engineering Director

Follow `skills/eng/SKILL.md` from plan to the release gate. The `eng-plan` checkpoint is auto-approved and the task list is still printed.

## 5. STOP 2: PR plan (never auto-passes)

Run `node ~/.signal/root/scripts/pr-ship.js plan --repo <repo>` for each repo. Print it: branch, base, title, label, reviewers. Stop. Nothing is pushed, labelled or sent. Push, PR, label, reviewer request and any chat message happen only after the user says yes, exactly as `skills/eng/SKILL.md` says.

## Hard stops (pause and ask once, even in auto mode)

- Blockers or Majors left after the one re-review.
- A failed QA.
- A cost plan over the limit.
- A merge conflict the builder cannot resolve.
- Any no-claude scan hit.
- A design that needs a genuinely new component, pattern, page or queue.
- Two failed re-dispatches of one agent.

## Final report

Plain short sentences. List:

1. What was built.
2. Every assumption (the `Assumed:` open questions).
3. Leftovers (Majors, Nits, skipped items).
4. What is pending (the PR yes, anything paused).
5. How efficient the run was (from `learn.js report`), and any new lessons Signal learned, each with a yes or no for the user.

## Rules

- Write every reply to the user in simple English: short sentences, common words.
- Ask questions only in step 1 and at the stops above.
- Every write to `.pm/state.md` goes through `state.js`.
- Never push, label, open a PR or send a message before the user says yes at STOP 2.
- No Claude, session link or Co-Authored-By text in any commit, branch name or file.
- Never run `npm run verify:agents` or `git stash`.
