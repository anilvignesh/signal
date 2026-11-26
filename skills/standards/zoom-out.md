# Zoom-out standard

A design passes if it solves the root problem in the simplest way, reuses what exists, builds nothing speculative, and keeps each section at the right altitude.

## 0. Context

The document says what is being built and why. If a reader cannot tell, the review stops and asks for context.

## 1. Root problem

- Fixes the cause, not a symptom.
- Fits the product goals in the README or state facts.

## 2. Simplicity

- No feature, option or abstraction for a need nobody has stated.
- No cache, queue or partition before a measured need.
- Data passes through as few parts as possible.
- No dead end: clean boundaries so the next step is possible, without building it now.

## 3. Altitude

- Intent, interfaces and data flow in design sections. No helper names, loop variables or pseudocode.
- A structural fix at the root beats a local workaround.
- New logic sits in the layer where it belongs.

## 4. Reuse

- Existing utilities, modules and screens are reused when stable and in bounds.
- Follow the patterns already in the product.
- Use platform standards, not custom ones.
- Flag known anti-patterns, such as bypassing standard auth or hard-coding config.
