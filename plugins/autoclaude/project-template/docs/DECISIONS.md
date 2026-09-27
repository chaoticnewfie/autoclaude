# DECISIONS

Dated, append-only log of every choice between real alternatives in {{PROJECT_NAME}}. Two kinds
of entry. `D-###` is a decision: the choice, why, and what was rejected. A reversal is a new
entry that supersedes the old one, never an edit. `N-###` records how an owner review note from
`docs/REVIEW_NOTES.md` was handled after a resume: the note, what was done, and where. Each kind
is numbered in order across the whole file, newest at the bottom, under a dated heading. The
AutoClaude decider's routine answers land here as `D-###` entries with the step they came from;
anything already answered here is not asked again.

## Entry format

```markdown
## YYYY-MM-DD

### D-001 Short title of the choice
- Step: S1.1 (or "planning" when made outside a run)
- Question: what needed deciding
- Choice: what was chosen
- Why: the reason, in one or two sentences
- Rejected: the alternatives, and why not
- Reverse by: what it would take to undo this

### N-001 Short title of the note
- Note: the owner's words, copied from docs/REVIEW_NOTES.md
- Done: what changed because of it, with the step or commit
```

## Entries

(none yet)
