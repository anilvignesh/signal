# Conventions

Rules this repo follows. Short. Each has a good and a bad example. Engineers edit this file.
Builders read it before they write code. Reviewers check the diff against it.

## Change as little existing code as possible

Prefer new code beside the old. Prefer a new optional input to changing what existing code does or needs.
Do not change what a widely used function or API does. If you must, say why a lighter way was not possible.

**Example: PAN check at order creation**

- Heavy: change the order creation API to validate the PAN inside it. Many callers are affected.
- Light: validate the PAN in its own call. Pass the result's reference into order creation as an optional field.

## Follow an existing pattern

Before you write a new helper or function, find the existing one that does the nearest job.
Name it in your commit message or PR: "Pattern copied from `path/to/file.py: function_name`".
If nothing similar exists, say so.

## Helper functions

(Fill in: where helpers live, how they are named, what they may and may not touch.)

## Errors

(Fill in: the error type to raise, where error text lives, how errors are logged.)

## Naming

(Fill in: names for booleans, services, tests.)

## Tests

(Fill in: where tests live, fixtures to reuse, what a good test checks.)
