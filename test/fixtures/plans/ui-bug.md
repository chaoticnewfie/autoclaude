# Todo fixture plan (UI check)

## Goal

The todo page's Add form must create a todo that shows up in the list straight away. The store and the API already work and their unit tests pass; this step is about the page itself.

## Constraints & decisions

- Stack: Node 24 built-ins only, no dependencies. `server.js` serves `public/index.html` and a JSON API.
- When something is unclear: prefer the smallest change that makes the Accept lines true.

## Phase 1: Adding works

- [ ] **S1.1** Adding a todo from the page works
  - Accept: typing "Buy milk" in the input and pressing Add shows "Buy milk" as a new item in the list
  - Accept: the count line updates after the add
  - Accept: `POST /api/todos` still returns 201 with the new todo
  - Test: test/todos.test.js
  - Tags: ui
