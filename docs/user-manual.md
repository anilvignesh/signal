# Signal User Manual

How to install Signal, set it up once, and use it on a product or a repo.

For the full reference, see the README.

## 1. What you need

- Claude Code
- Node.js 20 or newer
- git
- the `gh` CLI, only for the PR stage (run `gh auth login` once)

## 2. Install (once per machine)

```bash
git clone <remote> ~/signal && cd ~/signal
sh scripts/install.sh
npm link
```

Then restart Claude Code.

Check it worked:

1. Run `ls -l ~/.signal/root`. It should point to your signal folder.
2. Open Claude Code and type `/signal`. It should be listed.

To remove Signal: `sh scripts/install.sh --uninstall`.

## 3. Set up a product (once per product)

Open a terminal in your product folder, start Claude Code, and run:

```
/setup
```

It asks 10 questions in one message:

1. What the product is
2. Who uses it
3. Geography and market
4. Product category
5. Domain terms an AI would misread
6. North star metric
7. Existing prototype or spec
8. Scope: what is in, what is out
9. Who reads the output, and how long it should be
10. Words never to print, and where existing work lives

Skip any you do not know. Signal leaves it out and never guesses.

It creates a `.pm/` folder:

| File | Holds |
|---|---|
| `state.md` | What Signal knows about the product |
| `style.json` | Banned words and document rules |
| `refs.json` | Your repos and the deployed code version |
| `mistakes.md` | Rules learned from corrections |

If you name a repo in question 10, Signal also asks for two things. One is the deployed branch. The other is the pinned commit. It needs both before it reads code.

## 4. Set up a repo (once per repo)

Do this for each code repo you want Signal to build in.

### 4.1 Add it to the PR routing

Open `~/signal/config/pr-routing.json` and add the repo:

```json
"my_repo": {
  "kind": "backend",
  "readyLabel": "ready-to-merge",
  "reviewers": [{ "name": "Name", "login": "github-login", "chat": "chat-id" }]
}
```

- `kind` is `backend` or `frontend`.
- `readyLabel` is the label that starts CI. Use `null` if the repo has none. The label must already exist on GitHub. Signal never creates labels.
- A repo missing from this file is refused at the PR stage.

### 4.2 Add the repo to the product

In Claude Code, in the product folder, give Signal four things. They are the repo name, its path, the deployed branch and the pinned commit. `/setup` does this, or ask `/pm` to add it to `refs.json`.

### 4.3 Write the repo's conventions

Signal builds in the style of your code. It needs the repo's rules written down.

```bash
node ~/.signal/root/scripts/conventions.js init --repo <path-to-repo>
```

This creates `.signal/conventions.md` and `.signal/rules.json` inside the repo.

1. Open `.signal/conventions.md`.
2. Fill in each section: helpers, errors, naming, tests. Use short rules and one real example from the code.
3. Add checks to `rules.json` for anything a pattern match can catch.
4. Commit the `.signal/` folder in the repo, so the whole team shares it.

What these do:

- Builders read the conventions before they write code.
- Reviewers check the diff against them.
- The release gate runs `rules.json` on every added line.

A repo with no `.signal/` folder is skipped by this check. Signal will suggest `init`.

### 4.4 Check your Git setup

- The repo needs an `origin` remote.
- Your default branch should be `main`.
- Builders work in separate folders next to the repo, named `<repo>-<task>`. Nothing in your main checkout changes.

## 5. Daily use

### Build a feature from one sentence

```
/signal Show the last-used date on each API key in the merchant app
```

1. Signal asks all its questions once: target repo, goal, limits. Skip any and it takes the recommended answer and tells you.
2. It frames the idea, drafts the PRD, and has it reviewed.
3. **Stop 1: PRD freeze.** You read the summary and the assumptions. Say yes to freeze it. A frozen PRD is never overwritten.
4. It plans tasks, builds each in its own folder, reviews, tests, and runs the release gate.
5. **Stop 2: PR plan.** You see the branch, title, label and reviewers for each repo. Say yes to push. Say no to keep everything local.

Nothing is pushed before the second yes.

### Steer it by hand

| You want | Type |
|---|---|
| Control each PM stage | `/pm <request>` |
| Run a goal through the PM stages | `/pm run <goal>` |
| Pick up where you left off | `/pm continue` |
| Build an already frozen PRD | `/eng v1` |
| Resume a build | `/eng continue` |
| Use the cheaper or stronger model for the whole run | add `--model fast` or `--model deep` |

In `/pm` and `/eng`, each stage asks you: proceed, edit it yourself, or pause.

### Watch a run

In a second terminal in the product folder:

```bash
signal watch
```

It follows the run log and shows a running token total.

For real token counts instead of estimates, run `signal setup-hooks` once in the product folder.

## 6. What the release gate checks

Before any PR, every repo must pass:

| Check | Fails when |
|---|---|
| No-Claude scan | Any text, commit, branch or PR names the tool or vendor |
| PR size | More than 20 files or 600 changed lines |
| Tests with code | Source changed and no test file changed |
| Blast radius | An existing function used in 5 or more files is changed in place |
| Conventions | A rule in `.signal/rules.json` is broken |
| Backend checklist | The backend checklist finds something (backend repos only) |

A failure goes back to the builder, then the gate runs again.

If a change must be wide, the Director can pass a reason with `--justified`. You will see it.

Big work is split into several PRs. Each one stands alone, and the later ones link to the earlier ones.

## 7. The PR stage

After your yes, Signal runs these steps in order:

1. Merge the latest `main` into the branch. It stops on a conflict.
2. Run the repo tests.
3. Open the PR with no reviewers.
4. Add the ready label, which starts CI.
5. Wait for checks.
6. Request reviewers, only when checks pass.
7. Show a chat message draft for each reviewer with no GitHub login. It sends nothing until you say yes.

## 8. When Signal stops and asks

In `/signal` mode it pauses once for:

- a Blocker or Major left after one fix and one re-review
- a failed QA
- a cost plan over 400,000 tokens
- a merge conflict it cannot fix
- any no-Claude scan hit
- a design that needs a new component, pattern, page or queue
- an agent that failed twice

Answer the question and it carries on.

## 9. It learns as you use it

Signal records every task and PR: what went well, what failed, and which way of splitting work gave better results.

- After every 5 runs it looks for patterns and proposes lessons.
- Nothing applies until you approve it. You see the lessons in the final report.
- An approved lesson is scored on the next runs. A lesson that does not help is retired.

To see them:

```bash
node ~/.signal/root/scripts/learn.js list
node ~/.signal/root/scripts/learn.js report
```

When you correct Signal, the correction goes into `.pm/mistakes.md`, so it is not repeated.

## 10. Common problems

| Problem | Fix |
|---|---|
| `/signal` not found | Run `sh scripts/install.sh`, then restart Claude Code |
| "state already exists" on `/setup` | The product is already set up. Use `/pm` |
| PR stage says the repo is not routed | Add it to `config/pr-routing.json` |
| Gate says "too many files" | Let the Director split the work, or raise `maxFiles` in `config/pr-routing.json` |
| Gate says "no tests" | Add a test file for the changed source |
| Gate says "wide change" | Add the new behaviour beside the old one, as an optional input or a new function |
| Conventions check skipped | Run `conventions.js init` in the repo |
| `gh` errors at the PR stage | Run `gh auth login` |
| Run stops waiting for background agents | Set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` |
| Facts over the 30 limit | Run `node ~/.signal/root/scripts/state.js archive` |

## 11. Quick start

1. `sh scripts/install.sh`, restart Claude Code.
2. In the product folder: `/setup`.
3. For each repo: add it to `pr-routing.json`, then run `conventions.js init` and fill in the conventions.
4. `/signal <what you want built>`.
5. Say yes at the PRD freeze.
6. Say yes at the PR plan.
