# Todo fixture plan

## Goal

A tiny todo web app (already running at `npm run dev`, http://127.0.0.1:4173/) gains three small features. Every step is meant to pass first time, so the whole plan proves the loop end to end.

## Constraints & decisions

- Stack: Node 24 built-ins only, no dependencies. `server.js` serves `public/index.html` and a JSON API; `lib/todos.js` holds the store.
- Tests: `node --test test/` for unit tests. Add a test for every new store function.
- Don't: add a framework, a database, or a build step.
- When something is unclear: prefer the smallest change that makes the Accept lines true.

## Requested features intake

| Date | Request | Slotted into | Status |
|---|---|---|---|
| 2026-09-27 | Three features for the loop demo | Phase 1 | Planned |

## Phase 1: Three features

- [ ] **S1.1** Clear completed todos
  - Accept: the page shows a button labelled "Clear completed" under the list
  - Accept: clicking it removes every done todo and leaves the others; the count line updates
  - Accept: `DELETE /api/todos/completed` removes done todos and returns `{ removed: <n> }`
  - Test: test/todos.test.js
  - Tags: ui
- [ ] **S1.2** Show how many are done
  - Accept: the count line reads "<open> left, <done> done", for example "1 left, 1 done" on the seeded data
  - Accept: adding a todo and marking it done updates both numbers without a reload
  - Tags: ui
- [ ] **S1.3** Edit a todo's text
  - Accept: each todo has an "Edit" button that turns the text into an input; pressing Enter saves it
  - Accept: `PATCH /api/todos/:id` with `{ text }` updates the text and rejects empty text with 400
  - Accept: the saved text is what the list shows after a reload
  - Test: test/todos.test.js
  - Tags: ui
