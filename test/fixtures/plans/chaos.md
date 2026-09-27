# Todo fixture plan (chaos run)

## Goal

Five small features for the todo page, long enough that the supervisor's recovery can be tested
while the run is working: a killed session, a killed supervisor, a forced compaction, a stalled
tool call and a crashed dev server.

## Constraints & decisions

- Stack: Node 24 built-ins only, no dependencies. `server.js` serves `public/index.html` and a JSON API.
- `tools/stall-hook.js` and `.claude/settings.json` belong to the test harness, not the app: leave them alone.
- Tests: `npm test` runs `node --test test/*.test.js`. Add a test for every new store or API function.
- When something is unclear: prefer the smallest change that makes the Accept lines true.

## Phase 1: Five features

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
  - Test: test/todos.test.js
  - Tags: ui
- [ ] **S1.4** Filter the list
  - Accept: three buttons "All", "Open" and "Done" sit above the list; "Open" shows only todos not done, "Done" only done ones, "All" everything
  - Accept: the active filter button looks pressed (`aria-pressed="true"`)
  - Tags: ui
- [ ] **S1.5** Keep the filter across a reload
  - Accept: choosing "Open" sets the address to end in `#open` (and `#done`, `#all` for the others)
  - Accept: reloading the page with `#open` shows the Open filter active and only open todos
  - Tags: ui
