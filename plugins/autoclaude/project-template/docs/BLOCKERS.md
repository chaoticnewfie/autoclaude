# BLOCKERS

Follow-ups that the AutoClaude gate, the browser tester or the bug bash found in
{{PROJECT_NAME}} and that did not fail a feature outright, and anything the run left for the
owner: a flaky test, a missing edge case, a report that needs a human eye, a manual action. One
row each, appended, never deleted. The owner column names who resolves it: "owner" when it needs
a person, "Claude" when the run or the next session should pick it up, or a step ID once it has
been folded into the plan. A row is closed by changing its status, not by removing it:
- `open`: not handled yet.
- `fixed`, or `fixed in <step or commit>`: done.
- `left for the owner: <reason>`: the run did not fix it; the reason says why and what fixing it
  takes. The run's `HANDOFF.md` lists these rows.

A question that stops the run is not a blocker row: it goes through `autoclaude blocked` and is
answered in `docs/DECISIONS.md`.

| Date | Found by | Step | What | Owner | Status |
|---|---|---|---|---|---|
