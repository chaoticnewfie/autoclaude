# Todo fixture plan (UI bug)

## Goal

One UI step whose unit tests can pass while the page is still wrong, so only the browser tester can catch it. The fixture ships with the bug: the "Add" form's input has `id="txt"` in the page while the script reads `#text`, so adding a todo does nothing in the browser even though the store and the API work.

## Constraints & decisions

- Stack: Node 24 built-ins only, no dependencies.
- When something is unclear: prefer the smallest change that makes the Accept lines true.

## Phase 1: Adding works

- [ ] **S1.1** Adding a todo from the page works
  - Accept: typing "Buy milk" in the input and pressing Add shows "Buy milk" as a new item in the list
  - Accept: the count line updates after the add
  - Accept: `POST /api/todos` still returns 201 with the new todo
  - Test: test/todos.test.js
  - Tags: ui
