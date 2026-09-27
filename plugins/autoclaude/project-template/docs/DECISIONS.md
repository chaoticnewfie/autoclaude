# DECISIONS

Dated, append-only log of every choice between real alternatives in {{PROJECT_NAME}}. A reversal
is a new entry that supersedes the old one, never an edit. Anything already answered here is not
asked again: the builder and the AutoClaude decider read this file before deciding anything.

Two kinds of entry, newest at the bottom:
- `D-###` is a decision: made while planning, applied during a run from the decider's routine
  answer, or the owner's answer to a blocked question (`autoclaude answer` writes that one, with
  `Answer:` and `Decided by:` lines).
- `N-###` records how an owner review note (`autoclaude note`, kept in `docs/REVIEW_NOTES.md`)
  was handled after a resume.

## Entry format

One heading per entry: the id, then the date and the step in brackets, then a short title. The
id is one above the highest of its kind already in this file, starting at 001. The step is
"planning" for a decision made outside a run.

```markdown
## D-### (YYYY-MM-DD, S1.2) Short title of the choice
- Question: what needed deciding
- Choice: what was chosen
- Why: the reason, in one or two sentences
- Rejected: the alternatives, and why not
- Reverse by: what it would take to undo this

## N-### (YYYY-MM-DD, S1.3) Short title of the note
- Note: the owner's words, copied from docs/REVIEW_NOTES.md
- Done: what changed because of it, with the step or commit
```

## Entries

(none yet)
