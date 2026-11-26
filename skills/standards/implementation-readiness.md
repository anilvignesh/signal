# Implementation readiness standard

A plan or spec passes if a competent engineer who does not know the codebase can build the correct change first time. No guessing, no questions, no design choices.

## Zero-decision rule

Every design choice is made in the document: schema, API shape, state names, dependencies, error handling, edge cases. If the builder must choose, it fails.

## Required parts

- Target scope: every file, screen, table or service to Create, Modify or Delete.
- Steps: the exact logic, data change or API change per target.
- Test plan: named cases for the happy path and each edge case. Acceptance criteria are testable as written.
- Phases: each phase leaves the system working and testable.
- Migration and rollback: existing data, old clients, how to undo.
