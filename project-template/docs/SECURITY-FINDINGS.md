# SECURITY-FINDINGS

Lower-severity findings from the AutoClaude security reviewer, which runs on every step tagged
`security` and at the end of every phase of {{PROJECT_NAME}}. Findings the reviewer rates as
blocking fail the step and are fixed before it passes; they are not filed here. Everything below
that lands here as one row: severity, file, issue, the suggested fix, and status. Rows are
appended, never deleted; a fixed finding gets its status changed to "fixed" with the commit. Read
this file before touching authentication, input handling or anything a row names.

| Date | Severity | File | Issue | Fix | Status |
|---|---|---|---|---|---|
