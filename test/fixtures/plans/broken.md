# Todo fixture plan (broken on purpose)

## Goal

One step whose acceptance can never be met, so the gate must fail it three times and pause.

## Constraints & decisions

- Stack: Node 24 built-ins only, no dependencies.
- Don't: modify `test/impossible.test.js`; it is part of the fixture.
- When something is unclear: prefer the smallest change that makes the Accept lines true.

## Phase 1: Impossible

- [ ] **S1.1** Make the impossible test pass without touching it
  - Accept: `node --test test/` exits 0 with `test/impossible.test.js` unchanged (it asserts that 1 equals 2)
  - Tags: no-ui
