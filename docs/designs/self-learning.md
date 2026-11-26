# Self-learning loop

Signal learns from every run. It records what happened, finds patterns, proposes lessons, and applies only the ones you approve. It then checks whether each lesson helped.

## What it learns from

Both sides count: what went wrong and what went right.

- **Per task:** files, changed lines, criteria count, builder model, risk, fix rounds, QA result on the first try, review findings and their tags, re-dispatches, estimated and real tokens.
- **Per PR:** split strategy (`seam`, `slice`, `size` or `single`), number of parts, files, lines, CI on the first try, fix rounds, merge conflicts.
- **First pass** is the main good signal. A task is first pass when no fix round was needed and QA passed the first time. A PR is first pass when CI was green the first time and no fix round followed.

## Files

All under `.pm/learn/`.

- `runs.jsonl`: one line per run start, task, PR and run end. Append only.
- `lessons.json`: every lesson with its status, evidence and baseline.

## Commands (`scripts/learn.js`)

| Command | What it does |
|---|---|
| `start` | Opens a run. Later records use it by default. |
| `task ...` / `pr ...` | Records one task or one PR. |
| `finish` | Closes the run. After every 5 runs it runs `analyze` and says how many lessons are new. |
| `analyze` | Finds patterns and adds proposed lessons. |
| `list [status]` | Shows lessons in plain English. |
| `approve <id>` / `reject <id>` / `retire <id>` | You decide. Approve applies the lesson. |
| `score` | Checks approved lessons after 5 more runs. |
| `brief` | Prints approved lessons for the Director to read while planning. |
| `report` | Prints the efficiency numbers. |

## What it looks for

A pattern needs enough data: 4 tasks per group, 3 PRs per group. A gap of 25 points in first-pass rate between two groups makes a lesson.

- **Task size:** files per task, and criteria per task.
- **Task kind:** backend, frontend, migration and so on.
- **Model choice:** `fast` against `deep`, inside the same risk class.
- **Split strategy:** which way of splitting gave more first-pass PRs, and which PR size.
- **Repeat findings:** the same review finding tag in 3 or more tasks across 2 or more runs.

A lesson is one of two kinds. `better-way` compares two choices ("slice splits passed CI first time 9 of 10, seam splits 4 of 8"). `went-right` keeps a choice that works (first pass 9 of 10 at 6 to 12 files per task).

## Applying

Nothing changes without your yes.

- A lesson for the Director goes to `learn.js brief`. The Director reads it at Plan.
- A lesson for an agent is written to `.pm/mistakes.md` as a rule. `state.js brief` already hands those rules to that agent.

## Checking

Each approved lesson stores the first-pass rate when it was applied. After 5 more runs, `score` compares. Up 5 points or more: `helped`. Down 10 or more: `worse`, offered for retirement. Otherwise `no-effect`, offered for retirement. This shows correlation, not proof. The report says so.

## Limits

- Needs data. Under 5 runs, it proposes nothing.
- Per project. A lesson that holds in 3 or more projects can be copied to the global rules by hand with `mistakes.js add --global`.
- No agent tokens. All analysis is a script.
