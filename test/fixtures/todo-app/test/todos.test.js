import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/todos.js";

test("add, toggle, remove", () => {
  const s = createStore();
  const a = s.add("first");
  assert.equal(a.id, 1);
  assert.equal(a.done, false);
  assert.equal(s.toggle(1).done, true);
  assert.equal(s.list().length, 1);
  assert.equal(s.remove(1), true);
  assert.equal(s.list().length, 0);
});

test("rejects empty text and unknown ids", () => {
  const s = createStore();
  assert.throws(() => s.add("   "), /required/);
  assert.throws(() => s.toggle(9), /no todo/);
});
