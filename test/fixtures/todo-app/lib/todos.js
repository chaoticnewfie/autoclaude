// In-memory todo list. Pure functions over a plain array so the unit tests need no server.
export function createStore(initial = []) {
  let nextId = initial.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  const items = initial.map((t) => ({ ...t }));
  return {
    list() { return items.map((t) => ({ ...t })); },
    add(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed) throw new Error("todo text is required");
      const todo = { id: nextId++, text: trimmed, done: false };
      items.push(todo);
      return { ...todo };
    },
    toggle(id) {
      const t = items.find((x) => x.id === Number(id));
      if (!t) throw new Error(`no todo with id ${id}`);
      t.done = !t.done;
      return { ...t };
    },
    remove(id) {
      const i = items.findIndex((x) => x.id === Number(id));
      if (i < 0) throw new Error(`no todo with id ${id}`);
      items.splice(i, 1);
      return true;
    }
  };
}
