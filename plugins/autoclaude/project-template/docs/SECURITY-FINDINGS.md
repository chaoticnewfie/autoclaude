# SECURITY-FINDINGS

Lower-severity findings from the AutoClaude security reviewer, which reviews each feature of
{{PROJECT_NAME}} when it is verified (and every step tagged `security` when steps are verified
one at a time). Findings the reviewer rates as blocking fail the feature and are fixed before it
passes; they are not filed here. Everything below that lands here as one row: severity, file,
issue, the suggested fix, and status. Rows are appended, never deleted; the status changes
instead:
- `open`: not handled yet.
- `fixed`, or `fixed in <step or commit>`: done.
- `left for the owner: <reason>`: the run did not fix it; the reason says why and what fixing it
  takes. The run's `HANDOFF.md` lists these rows.

Read this file before touching authentication, input handling or anything a row names.

| Date | Severity | File | Issue | Fix | Status |
|---|---|---|---|---|---|
