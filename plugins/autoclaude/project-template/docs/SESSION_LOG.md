# SESSION_LOG

One append-only entry per working session on {{PROJECT_NAME}}, newest at the bottom: the date,
the machine, what was done, the commits, and the SHA that is deployed at the end (or "not
deployed"). Written at the end of every prompt as part of the definition of done. During an
AutoClaude run it is one entry per step, written before `autoclaude ready`; the gate commits
afterwards, so "Commits" names the step instead of a SHA. Nothing here is edited or removed; a
correction is a new entry. `CONTINUE_HERE.md` says where things are now; this file says how
they got there.

## Entry format

```markdown
## YYYY-MM-DD, machine name
- Did: one line per thing done
- Commits: short SHA and subject, one per line
- Deployed: SHA, or "not deployed"
```

## Entries

(none yet)
