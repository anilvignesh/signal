# Signal

Signal is a set of Claude Code skills and small Node scripts for product teams that build software. You give it a request. It frames the idea, drafts a PRD, reviews it with fresh-context reviewers, plans tasks, builds them in separate git worktrees, reviews and tests each task, runs a release gate, and prepares a pull request. You approve twice: at the PRD freeze and at the PR plan. Nothing is pushed before you say yes.

New here? Read the [user manual](docs/user-manual.md).

Requirements: Claude Code, Node.js 20 or newer, git. The PR stage also needs the `gh` CLI.

## Install and first run

```bash
git clone <remote> ~/signal && cd ~/signal
sh scripts/install.sh
npm link          # optional: puts the `signal` command on your PATH
```

The installer:

- links every skill in `skills/registry.json` into `~/.claude/skills/<name>`;
- links this repo at `~/.signal/root`, so skills can call `node ~/.signal/root/scripts/...`;
- removes stale links from earlier installs.

`sh scripts/install.sh --uninstall` removes all of it. Restart Claude Code after installing.

Then, from your product folder:

| Step | Command | What it does |
|---|---|---|
| Once per product | `/setup` | Asks 10 questions. Creates `.pm/state.md`, `.pm/mistakes.md`, `.pm/style.json`, `.pm/refs.json`. |
| Whole run | `/signal <request>` | Asks every question once, then runs the PM stages and the Engineering Director. |
| PM only | `/pm <request>`, `/pm run <goal>`, `/pm continue` | You steer the PM stages by hand. |
| Engineering only | `/eng <version>`, `/eng continue` | Builds a frozen PRD, for example `/eng v1`. |

Example:

```
/signal Show the last-used date on each API key in the merchant app
```

1. Signal asks one numbered batch: target repo, goal, constraints. Skip a question and it takes the recommended answer and records it.
2. It runs the frame, draft and review stages on its own, then stops at the PRD freeze. You read the summary and the assumptions and say yes.
3. It plans tasks, builds, reviews and tests each one, runs the release gate, then stops at the PR plan. You say yes to push, or no to keep everything local.

## How a run works

```
intake            /signal asks all questions in one batch
frame             inventory, research, ground, six brainstorm lenses -> concepts brief
draft             PRD section by section, then acceptance criteria
review            zoom-out, comprehension, critic, readiness (staged, each followed by resolve)
review-gate       no open Blocker, a resolve report for every stage
STOP 1            prd-freeze: you say yes, the PRD is frozen
eng plan          tasks in .pm/eng/tasks.json
build             one builder per task, own worktree, local commits
task review       fresh-context reviewer per task
fix               builder fixes Blockers and Majors, one re-review
QA                separate agent tests each task against its criteria
release gate      no-Claude scan, backend check (backend only)
STOP 2            PR plan: branch, base, title, label, reviewers
PR stage          after your yes: sync, open, label, checks, reviewers, notify
```

### Run modes

The run mode lives in `.pm/state.md` and is read with `state.js mode`.

| Mode | Set by | Behaviour |
|---|---|---|
| `manual` | default; `/pm` and `/eng` | Each stage gate asks you: proceed, edit myself, or pause. |
| `auto` | `/signal` | Each gate takes its recommended default. The default is logged with `state.js assume` and shows up as an `Assumed:` open question. |

### Planned stops

Two stops never auto-pass, even in `auto` mode:

1. **STOP 1, `prd-freeze`.** You see the PRD summary, every assumption and the review results. One yes freezes the PRD. It is a one-way door: a frozen version is never overwritten.
2. **STOP 2, PR plan.** You see the branch, base, title, label and reviewers for each repo. One yes covers the push, the PR, the label and the reviewer request for that plan.

### Hard stops

In `auto` mode the run also pauses and asks once on:

- Blockers or Majors left after the one re-review
- a failed QA
- a cost plan over the limit
- a merge conflict the builder cannot resolve
- any no-Claude scan hit
- a design that needs a genuinely new component, pattern, page or queue
- two failed re-dispatches of one agent

In `manual` mode the checkpoints are `discovery-synthesis`, `prioritisation`, `prd-freeze`, `eng-plan` and `gtm-verdict`. In `auto` mode `discovery-synthesis`, `prioritisation` and `eng-plan` are recorded without a pause.

## Directors and the state bus

Signal has three entry skills. You talk to them, never to agents.

- `/signal` asks every question once, sets `auto` mode, then runs the PM Director and the Engineering Director.
- `/pm` is the PM Director. It reads state, announces a route, picks the fewest agents whose `use_when` is met, briefs each one and merges each debrief.
- `/eng` is the Engineering Director. It plans tasks from a frozen PRD and runs build, review, fix, QA, the release gate and the PR stage. It never writes product code.

Every Director announces its route, including what it skips and why:

```
[Director] State: Draft — v1 · 12 facts · 1 open question
[Director] Request: "spec out key rotation"
[Director] Route: red-team → data-model → metrics
[Director] Skipping: research (facts already carry the regulatory driver)
```

### `.pm/state.md`

The product's living context. Eight sections, always in this order: `Phase`, `Run Mode`, `Facts` (30 at most, each tagged `[source: ...]`), `Decisions`, `Glossary`, `Open Questions`, `Artifacts`, `Next`. Nobody edits it by hand. Every read and write goes through `scripts/state.js`.

### Briefings

`state.js brief <skill> [param=value]` builds the `## Briefing` block for one agent. It carries only the sections the registry says that skill `needs`, a trimmed set of Facts, and the relevant rules from the mistakes log.

### Debrief

Every agent ends with a `## Debrief` block. The Director saves it and runs `state.js merge`.

```markdown
## Debrief
**Artifact:** .pm/red-team.md
**Digest:** 3 attack paths: 1 CRITICAL, 2 HIGH
**Learned:**
- Idempotency key is missing on the retry path [source: red-team]
**Terms:** none
**Open questions for user:** none
**Suggested next:** Fix the CRITICAL path before PRD freeze
```

`Artifact`, `Digest`, `Learned` and `Suggested next` are required. `Terms`, `Open questions for user` and `Files` are optional. A debrief missing a required field is rejected: `merge` exits non-zero and leaves `state.md` unchanged. The Director re-dispatches the agent once. A second failure stops the run.

## Skills and agents

`skills/registry.json` is the source of truth. Tier is `fast` or `deep` (see Models). Agents are dispatched by a Director, never called by hand.

### Entry and directors

| Name | Tier | What it does | When it runs |
|---|---|---|---|
| `signal` | fast | Asks every question once, then runs the PM stages and the Engineering Director on recommended defaults. Stops at the PRD freeze and the PR plan. | You type `/signal <request>`. |
| `pm` | fast | PM Director. Routes each request to the fewest agents, owns `.pm/state.md`, runs the checkpoints. | `/pm`, or inside `/signal`. |
| `eng` | fast | Engineering Director. Plans tasks, runs build, review, fix, QA, release gate and PR stage. | A PRD is frozen. `/eng`, or inside `/signal`. |

### PM stages

| Name | Tier | What it does | When it runs |
|---|---|---|---|
| `setup` | fast | Creates `.pm/state.md` and the other project files. Records product, users, market and north star as Facts, domain terms as Glossary entries. | No `.pm/state.md` exists. |
| `discovery` | fast | Frame stage: inventory, research, then six brainstorm lenses. Writes `.pm/concepts_brief.md`. | A new idea has no concepts brief, or the brief has no evidence. |
| `prioritize` | fast | Buckets tasks into v0, v1, v2 with a cut line. Writes `.pm/backlog.md`. | A task list needs a scope decision. |
| `prd` | fast | Drafts the PRD section by section, then freezes it into `.pm/prd/{version}/` once review passes. | Scope is locked and needs a spec. |
| `ac-agent` | fast | Writes testable acceptance criteria. | Right after the PRD draft, and for any approved PRD that lacks criteria. |
| `maintain-context` | fast | Archives the oldest Facts past the limit. Writes `.pm/handoff.md` at session end. | `state.js check` reports over the fact limit, or the session ends. |
| `gtm-check` | deep | Ship gate. Returns SHIP or DO NOT SHIP with the unmet condition. | A PRD is frozen and launch is close. |
| `ux-review` | fast | Critiques UI on conversion, accessibility, heuristics and brand, from source or screenshots. | There is a UI to critique. |

### Research and evidence

| Name | Tier | What it does | When it runs |
|---|---|---|---|
| `inventory` | fast | Scans existing docs, tickets, memory and wiki on a topic and classifies how each relates. Writes `.pm/existing.md`. | Before discovery or tickets, when `existing.md` is missing or stale. |
| `research` | fast | Facts from outside the building through one lens: regulatory, competitive, industry or voc. Uses web search. | A question cannot be answered from state, the repo or the user. |
| `ground` | fast | Checks claims about the existing system against the deployed code. Writes `.pm/evidence.md` with ref and commit. | A PRD or discovery claims what the system does or lacks. |

### Review layer

Six reviewers and the codebase reviewer run fresh, read-only, without the author's context. The synthesizer runs one stage at a time. `resolve` settles the findings in the main thread.

| Name | Tier | What it does | When it runs |
|---|---|---|---|
| `review-zoom-out` | deep | Simplicity and scope: over-engineering, YAGNI, reinvention, wrong altitude. | Stage `zoom-out`. |
| `review-comprehension` | fast | Reads as a newcomer: undefined terms, assumed steps, vague claims. | Stage `comprehension`. |
| `review-design` | deep | Architecture, scale, failure modes, security, unproven assumptions. | Stage `critic`. |
| `review-structural` | fast | Required sections, heading order, formatting, links. | Stage `critic`. |
| `review-style` | fast | Plain words, no fluff, no opinion, final state only. | Stage `critic`. |
| `review-codebase` | deep | Checks the document against `.pm/evidence.md` and read-only git: false statements, missing references, missed reuse. | Stages `critic` and `readiness`, when `evidence.md` exists. |
| `review-readiness` | deep | Whether an engineer can build from the document with no further design choices. | Stage `readiness`. |
| `review-synthesizer` | fast | Runs the reviewers of one stage in parallel, dedupes, triages Blocker, Major and Nit, writes `.pm/review/{stage}.md`. In stage `brainstorm` it runs the idea lenses and writes the concepts brief. | Every review stage, and the frame stage. |
| `resolve` | fast | Sorts each finding into CONTEST, ESCALATE, PROPOSE FIX or DECLINE, then asks you one question at a time. Runs one re-audit. | After each review report. |

### Design and data

| Name | Tier | What it does | When it runs |
|---|---|---|---|
| `design-flow` | fast | Builds a mock-data prototype from a frozen PRD by copying real production pages and adding only the change. Writes `.pm/design/{feature}/flow.md` with screenshots and a differences-vs-production list. | A frozen PRD adds or changes screens. |
| `data-model` | deep | Turns a PRD into entities, state machines, invariants, migration and backfill notes. Writes `.pm/data-model.md`. | The feature adds entities or new states. |
| `red-team` | deep | Attacks the design: money-loss paths, fraud, races, partial failure, reconciliation holes, regulatory exposure. Writes `.pm/red-team.md`. | A design touches money, identity, state transitions or an external provider. |
| `metrics` | fast | Defines success, the events that must fire and the query that answers whether it worked. Writes `.pm/metrics.md`. | A PRD has no measurement plan. |
| `tickets` | fast | Turns a frozen PRD version into one backlog ticket draft. Runs after `red-team`, `data-model`, `metrics` and `design-flow` when they are in the route. | A PRD version is frozen and needs a ticket. |

### Engineering

| Name | Tier | What it does | When it runs |
|---|---|---|---|
| `builder` | fast | Implements one task in its own worktree, tests first when the repo has tests, commits locally, never pushes. | An approved task is ready, or findings need fixing. |
| `task-reviewer` | deep | Read-only review of one task's diff against the task, its criteria and the latest `main`. Blocker, Major, Nit with file and line. | A task is built. |
| `qa` | fast | Runs the repo tests and exercises each acceptance criterion. Reports pass or fail with commands and output. Never edits code. | A task passed review. |
| `backend-review` | deep | Judgement review of a backend diff against the backend checklist items the script cannot test. | Release gate for `acme_backend`, after `backend-check` passes. |
| `pr-split` | fast | Groups planned tasks into ordered PRs of at most 20 files and 600 changed lines, each a complete step. | Engineering Director, right after the task list is planned. |

## Models

Two tiers, set per skill in the registry:

| Tier | Model alias | Output allowance in estimates |
|---|---|---|
| `fast` | `sonnet` | 4k tokens |
| `deep` | `opus` | 6k tokens |

- Directors pass the alias only, never a dated model id, so each run uses the latest release.
- `deep` agents: `gtm-check`, `red-team`, `data-model`, `review-zoom-out`, `review-design`, `review-readiness`, `review-codebase`, `task-reviewer`, `backend-review`. Everything else is `fast`.
- `--model fast|deep` on `/pm`, `/eng` or `/signal` overrides the tier of every dispatch for that run.
- Each engineering task carries its own model: `eng.js add ... --model fast|deep`. Default `fast`. The Director sets `deep` for money paths, migrations, auth, permissions, concurrency and other risky work. This sets the builder's model. Reviewers and QA use the registry tier.

## Engineering loop

- **Tasks.** The Director splits the PRD into tasks and stores them in `.pm/eng/tasks.json` through `eng.js`. Each has an id, title, files, criteria, dependencies, repo, model and status. Every acceptance criterion belongs to at least one task.
- **Status flow.** `planned` to `building` to `built` to `reviewing`, then `changes-requested` (back to `building`) or `reviewed`, then `qa`, then `qa-failed` (back to `building`) or `done`. Other transitions are refused.
- **Build.** Ready tasks (`eng.js next`) run in parallel when their files do not overlap. Each builder gets a worktree next to the repo, created from the latest `origin/main`: `git worktree add ../<repo>-<id> -b eng/<id> origin/main`. Builders commit locally. Nobody pushes.
- **Review.** A fresh `task-reviewer` sees the task, the worktree and the latest `main`, and nothing from the builder. The report goes to `.pm/eng/reviews/<id>.md`.
- **Fix.** The builder fixes Blockers and Majors only. One re-review. What is left goes to you. Nits are listed in the final report.
- **QA.** A separate `qa` agent tests each reviewed task and writes `.pm/eng/qa/<id>.md`. A failed QA asks you once how to proceed. QA is never the builder.

## Release gate and PR stage

The gate runs once per repo, after `eng.js gate` shows every task `done`. Base is `origin/main`.

1. `no-claude-scan.js` checks added diff lines, new file paths, every commit message, trailer, author and committer, the branch name, and the PR title and body. It looks for the tool name, the vendor name, AI co-author trailers, session links and ids, and generated-with footers. Any hit stops the release. Legitimate mentions go in `.signal-scan-allow` in the repo root: one regex per line, matched against `<where><TAB><text>`, where `<where>` is `file:line`, `path:file`, `commit:sha`, `branch`, `pr-title` or `pr-body:n`. Allowed hits print as notes.
2. `pr-size.js` fails a PR over 20 files or 600 changed lines. Lockfiles, snapshots and minified files do not count. Limits are `maxFiles` and `maxLines` in `config/pr-routing.json`.
3. `check-tests.js` fails a PR that changes source files and has no test file. Docs, config and migrations are exempt.
4. `blast-radius.js` finds existing functions the diff changes and counts the files that use them. A change that alters existing lines of something used in 5 or more files stops the release. Changes that only add, or add an optional input, are allowed. A written reason clears the stop.
5. `conventions.js check` runs the repo's own `.signal/rules.json` on the added lines. Conventions live in each product repo (`.signal/conventions.md`). Builders read them, reviewers check them. `conventions.js init` writes a starter. Design: `docs/designs/light-changes-and-conventions.md`.
6. `backend-check.js` runs regex checks on the added lines against `~/.claude/backend-checklist.md`. It applies only to the `acme_backend` repo and prints `skipped` for any other.
7. `backend-review` covers the judgement items, backend only. Report: `.pm/eng/reviews/backend.md`.

A script failure or a Blocker sends the findings back to the builder, then the gate runs again.

### PR stage

After the gate passes, the Director runs `pr-ship.js plan` for each repo and stops. A change in two repos is two PRs. Nothing is pushed, labelled or sent before your yes. After the yes the Director sets `SIGNAL_PR_CONFIRMED=1`. Without it every step except `plan` refuses.

| Step | What it does |
|---|---|
| `plan` | Prints branch, base, title, label, reviewers. Changes nothing. Warns about reviewers with no login. |
| `sync` | Merges the latest `origin/main` into the branch. Aborts on conflict and lists the files. |
| (local tests) | The Director runs the repo tests. A failure goes back to the builder. |
| `open` | Scans title, body, diff and commits, pushes, opens the PR with no reviewers. |
| `label` | Adds the repo's ready label, only when the branch is current. This starts CI. Skipped for a repo with no label. |
| `checks` | `--wait <seconds>`, `--interval <seconds>`. Exit 0 all pass, 1 any fail, 2 pending. |
| `reviewers` | Requests reviewers, only when checks pass and the branch is current. |
| `notify` | Prints chat drafts for reviewers with no GitHub login (`--all` for everyone). Sends nothing. The Director shows each draft and sends it with the chat tool only after a yes. |

`pr-ship.js` never creates labels and never runs tests. Exit codes: 0 ok, 1 refused or failed, 2 checks pending, 64 bad usage.

### Routing

`config/pr-routing.json` sets the base branch and, per repo, its kind, ready label and reviewers (name, GitHub login, chat id).

| Repo | Kind | Ready label | Reviewers |
|---|---|---|---|
| `acme_backend` | backend | `ready for merge` | Alex, Sam, Jordan (all three, always) |
| `acme_web` | frontend | `ready-to-merge` | Riya, Sid |
| `acme_admin` | frontend | none | Riya, Sid |

A repo missing from the file is refused. Add it there first.

## Cost and observability

- **`learn.js`.** The self-learning loop. The Engineering Director records every task and PR, good and bad: first pass or not, split strategy, model, task size, repeated review findings. After every 5 runs it finds patterns and proposes plain-English lessons, such as "tasks of 6-12 files passed first time more often" or "split by slice gave more green PRs". Nothing is applied without the user's yes. Approved lessons for agents become rules in `.pm/mistakes.md`; lessons for the Director are read at Plan with `learn.js brief`. After 5 more runs each lesson is scored `helped`, `no-effect` or `worse`. `learn.js report` prints the efficiency numbers. Design: `docs/designs/self-learning.md`. Data: `.pm/learn/`.
- **`cost.js`.** `plan <agent[:param=value,...]> ...` prints a low-to-high range per agent, a raw total and an expected total. It exits 2 when the expected total passes the threshold (400000, or `SIGNAL_COST_CONFIRM`). The Directors run it before dispatching and ask you once on exit 2. `log` records each dispatch in `.pm/cost.log` with the raw estimate. Estimates are `ceil(chars / 4)` of skill text plus briefing plus the output allowance. After 3 logged runs per agent, the expected total is calibrated from real counts.
- **Hooks.** `signal setup-hooks` adds Claude Code hooks to the project's `.claude/settings.json`. When an agent finishes, `hook.js` reads its transcript and adds the real token count (input, output and cache writes) to `.pm/cost.log`. It also appends one line per event to `.pm/activity.jsonl`. Tool output is never stored. Restart Claude Code in the project afterwards. Token counts appear when an agent finishes, not while it runs.
- **`runlog.js`.** The Directors append one JSON line per step to `.pm/run.log`. Kinds: `route`, `skip`, `brief`, `dispatch`, `merge`, `decide`, `note`.
- **`signal watch`.** Follows `.pm/run.log` live with a running cost total.
- **`mistakes.js`.** `.pm/mistakes.md` lists things agents got wrong and the rule that prevents each. Rejected debriefs are logged automatically. The Director logs your corrections. `state.js brief` passes the relevant rules to each agent. `--global` also writes `~/.signal/mistakes.md`, which applies to every product.
- **`lint.js`.** Checks a document against `.pm/style.json` (banned words and patterns, required lines, table columns). `--check-evidence` rejects evidence files that lack the required blocks, or whose sha does not match the pinned commit in `.pm/refs.json`.

## Project files

What Signal writes in your product folder:

```
.pm/
  state.md                  living context, written only through state.js
  style.json                banned words, required lines, table columns
  refs.json                 deployed ref, pinned commit, repos, search areas
  mistakes.md               rules learned from corrections
  existing.md               inventory of existing work
  evidence.md               claims checked against code
  research/{lens}.md        research findings
  concepts_brief.md         output of the frame stage
  backlog.md                v0/v1/v2 buckets
  prd-draft/                PRD and criteria while in draft
  review/
    {stage}.md              review report per stage
    {stage}-resolve.md      sorted findings and their status
  prd/{version}/            frozen: prd.md, acceptance-criteria.md, metrics.md,
                            CHANGELOG.md, one-pager.md, story-map.md, ticket.md
  design/{feature}/flow.md  prototype flow doc
  data-model.md
  red-team.md
  metrics.md
  gtm-check.md
  ux-review.md
  eng/
    tasks.json              task list and status
    reviews/{id}.md         task review reports; backend.md for the Backend review
    qa/{id}.md              QA reports
  context/archive.md        Facts moved out by maintain-context
  handoff.md                session handoff
  debrief.md                the debrief being merged
  run.log                   Director step log
  cost.log                  token estimates and actual counts
  activity.jsonl            hook events
```

## CLI reference

Scripts live at `~/.signal/root/scripts/`. Run them from your product folder. Each accepts `--path <file>` to use another state or log file.

### `signal`

| Command | Does |
|---|---|
| `signal watch` | Follows the run log with a cost total. Needs `.pm/state.md`. |
| `signal setup-hooks [--remove]` | Adds or removes Signal's hooks in this project's `.claude/settings.json`. Refuses in your home folder. |
| `signal mistakes ...` | Runs `mistakes.js` with the same arguments. |
| `signal help` | Prints usage. |

### `state.js`

| Command | Does |
|---|---|
| `init "<product>" [--force]` | Creates `.pm/` and a blank `state.md`. |
| `check` | Section counts. Exit 1 when Facts pass 30. |
| `brief <skill> [param=value] [target=<path>] [--full]` | Builds a briefing. |
| `merge <debrief-file> [--skill <name>]` | Validates a debrief and folds it into state. |
| `decide "<text>" --at <slug> [--phase "<text>"] [--resolves "<substring>"]` | Writes a Decision. The only writer of that section. Slugs: `discovery-synthesis`, `prioritisation`, `prd-freeze`, `eng-plan`, `gtm-verdict`. |
| `assume "<default taken>" [--by <name>]` | Records an assumed default as an open question. |
| `resolve "<substring>"` | Clears an open question. |
| `phase "<text>"` | Sets Phase. |
| `mode` / `set-mode <manual\|auto>` | Reads or sets the run mode. |
| `review-gate` | `ok` when every stage has a report and a resolve report and no Blocker is open. Otherwise `blocked` with reasons. |
| `prd-status <vN>` | `none`, `draft`, `incomplete` or `frozen`, plus missing files. |
| `archive [--archive <path>]` | Trims Facts to 30. |
| `style init\|merge\|show` | Manages `.pm/style.json`. |
| `refs init\|merge\|show` | Manages `.pm/refs.json`. |

### Other scripts

| Command | Does |
|---|---|
| `eng.js add <id> --title <t> [--files a,b] [--criteria "x;y"] [--deps T1,T2] [--repo <path>] [--model fast\|deep]` | Adds a task. |
| `eng.js list` / `next` | All tasks / tasks ready to build. |
| `eng.js set <id> <status>` | Moves a task along a legal transition. |
| `eng.js gate` | Exit 0 only when every task is `done`. |
| `cost.js estimate <agent> [param=value]` | Token estimate for one agent. |
| `cost.js plan <agent[:param=value]> ...` | Estimate for several agents. Exit 2 over the threshold. |
| `cost.js log <agent> --tier <t> --est <n> [--actual <n>]` | Appends to `.pm/cost.log`. |
| `cost.js summary` | Runs, estimated and actual tokens per agent. |
| `runlog.js add <kind> "<text>" [--agent <name>]` / `tail [n]` | Writes or reads the run log. |
| `mistakes.js add "<what>" --rule "<rule>" [--agent <name>] [--global]` / `list [n]` | Writes or reads the mistakes log. |
| `lint.js <file> [--style <path>] [--refs <path>] [--evidence <path>] [--json]` | Lints a document. Exit 0 clean, 1 findings, 2 bad input. |
| `lint.js --check-evidence <path> [--refs <path>]` | Checks an evidence file. |
| `no-claude-scan.js --repo <path> --base <ref> [--pr-title <t>] [--pr-body-file <f>]` | Release scan. Exit 0 clean, 1 hits, 2 bad input. |
| `pr-size.js --repo <path> --base <ref> [--max <n>] [--max-lines <n>]` | PR size gate. Exit 0 ok, 1 too big. |
| `check-tests.js --repo <path> --base <ref>` | Tests-with-code gate. Exit 0 ok, 1 no tests. |
| `learn.js start\|task\|pr\|finish\|analyze\|list\|approve\|reject\|retire\|score\|brief\|report` | Self-learning loop. See `docs/designs/self-learning.md`. |
| `blast-radius.js --repo <path> --base <ref> [--max <n>] [--justified "<why>"]` | Wide-change gate. Exit 0 ok, 1 wide change. |
| `conventions.js init\|brief\|check --repo <path> [--base <ref>]` | Per-repo conventions. Exit 0 ok, 1 findings. |
| `plain-english.js <file> [--max-words <n>]` | Flags long sentences and fancy words. Exit 0 clean, 1 findings. |
| `backend-check.js --repo <path> --base <ref>` | Backend checklist pre-check. Exit 0 clean or skipped, 1 findings. |
| `pr-ship.js plan\|sync\|open\|label\|checks\|reviewers\|notify --repo <path>` | The PR stage, one step per call. |
| `setup-hooks.js`, `hook.js` | Used by `signal setup-hooks` and by the hooks. Not run by hand. |
| `claude.js` | Runs one agent headless with `claude -p`. Used by `verify-agents.js`. |
| `install.sh [--with-extras] [--uninstall]` | Links skills and the root link. |

### npm scripts

| Script | Does |
|---|---|
| `npm test` | Runs all tests. |
| `npm run watch` | Same as `signal watch`. |
| `npm run verify:agents` | Contract sweep of every agent. |
| `npm run verify:agents:live` | Dispatches every agent for real through `claude -p`. Uses quota. |

Long headless runs stop waiting for background agents after 600 seconds. Set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` to wait.

## Development

### Repo layout

```
skills/         every skill; registry.json is the source of truth
  agents/       agents the Directors dispatch
  standards/    review standards and the Apache-2.0 notice
scripts/        Node scripts and install.sh
bin/            the signal command
config/         pr-routing.json
extras/         optional adapters, off by default
tests/          node:test suites
tasks/          plans and notes for this repo
```

### Tests

```bash
npm test          # about 30 seconds on an idle machine
```

The tests check that:

- every registry entry has a `SKILL.md`, and every `SKILL.md` has a registry entry;
- every agent documents `## Briefing` and `## Debrief` with all four required debrief fields;
- no skill, script or this README names a tool or vendor from a deny list, such as issue trackers, chat tools, analytics products, design tools and scraping services. Say "the tracker" or "the chat tool" instead. The exact list is in `tests/registry.test.js`;
- the Directors, scripts, installer and release gate behave as documented.

Adapters for outside tools live in `extras/`. They are outside the registry, off by default, and installed only with `sh scripts/install.sh --with-extras`. See `extras/README.md`.

To add a skill:

1. Create `skills/<path>/SKILL.md` with front matter, `## Briefing` and `## Debrief` (agents) and the four debrief fields.
2. Add an entry to `skills/registry.json`: `kind`, `tier`, `path`, `purpose`, `needs`, `outputs`, `use_when`, and `params` if any.
3. List it in `CLAUDE.md`.
4. Run `sh scripts/install.sh` to link it, and `npm test`.

## Credits

The review layer is adapted from [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) under the Apache-2.0 license. The `review-*` agents, the `resolve` rules and the files in `skills/standards/` are reworded for PRDs and specs and run as native Signal agents. See `skills/standards/NOTICE.md`.
