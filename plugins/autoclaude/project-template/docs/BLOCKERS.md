# BLOCKERS

Follow-ups that the AutoClaude gate, the browser tester or the phase-end bug bash found in
{{PROJECT_NAME}} and that did not fail a step outright: a flaky test, a missing edge case, a
report that needs a human eye. One row each, appended, never deleted. The owner column names who
resolves it: "owner" when it needs a person, "Claude" when the next session should pick it up, or
a step ID once it has been folded into the plan. A row is closed by changing its status, not by
removing it. A question that stops the run is not a blocker row: it goes through
`autoclaude blocked` and is answered in `docs/DECISIONS.md`.

| Date | Found by | Step | What | Owner | Status |
|---|---|---|---|---|---|
