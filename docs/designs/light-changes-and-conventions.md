# Light changes and codebase conventions

Two rules for every build. Change as little existing code as possible. Write code the way the repo already does.

## Light changes

- **Two approaches.** In Plan, each task names two ways to do it and picks the one that changes the least existing code. New code beside the old, and a new optional input, are preferred. Changing what a widely used function or API does, or what it needs, is avoided.
- **Blast radius.** `blast-radius.js` finds each existing function, class or endpoint the diff changes, and counts the files that use it. A change to something used in 5 or more files stops the release, unless the PR gives a written reason. A change that only adds lines, or adds an optional input, is noted and allowed. The limit is `maxBlast` in `config/pr-routing.json`.
- **Review.** The task reviewer asks: could new code beside the old have done this? A yes is a Major.
- **Worked example.** PAN check at order creation. Heavy way: change the order creation API. Light way: check the PAN in a separate call and pass an optional reference into order creation. The template carries this example. Findings of this kind are tagged `wide-change` so the learning loop sees them.

The count is a heuristic. It matches names, so a common name over-counts. The written reason clears it.

## Conventions in each repo

Each product repo holds its own rules in `.signal/`:

- `conventions.md`: short rules with a good and a bad example each. Engineers edit it. It versions with the code.
- `rules.json`: regex checks on added lines, same shape as the `backend-check.js` checks.

How they are used:

1. **Builder briefing.** The Director passes `conventions.js brief --repo <path>` into the builder's prompt.
2. **Precedent.** Any new helper or function names the existing one whose pattern it copies, or says there is none. The reviewer checks the cited one exists.
3. **Mechanical check.** `conventions.js check --repo <path> --base <ref>` runs `rules.json` against the added lines at the release gate.
4. **Review.** The task reviewer checks the diff against `conventions.md`.
5. **Start.** `conventions.js init --repo <path>` writes a starter `conventions.md` and an empty `rules.json`.

A repo with no `.signal/` folder is not checked. The Director tells the user once and suggests `init`.
