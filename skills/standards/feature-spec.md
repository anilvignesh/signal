# Feature spec standard

A spec passes if a competent engineer who does not know the codebase can understand the feature, the reason for it and the trade-offs, and can see that the major risks and alternatives were handled.

## Required sections

- Problem: who has it and what it costs them.
- Goals and non-goals.
- Proposed design: parts, data flow, how it fits what exists.
- Alternatives considered: each rejected option with a specific reason (complexity, cost, speed, scale).
- Risks and limits: failure modes, security, scale limits, and the mitigation for each.

## Alternatives rule

A spec that proposes one path and shows no rejected option fails.

## Risks rule

The spec names its own limits. A risk list with no mitigations fails.
