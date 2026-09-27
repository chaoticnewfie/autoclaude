# DEFERRED

Work that was deliberately not built yet in {{PROJECT_NAME}}. Each entry says what it is, why it
waits, the trigger that would start it, the concrete path to build it, and why adding it later
costs no rework. Append-only: when an item gets built, its status changes to "done" with the step
ID and the entry stays. Anything the owner asked for goes first through the intake table in
`PLAN.md`; it lands here only once the plan decides it waits.

## Entry format

```markdown
### Short title
- What: the feature or change, in one line
- Why it waits: the reason it is not in the current plan
- Trigger: the event or need that would start it
- Path: the concrete steps to build it, so nobody has to rediscover them
- No rework because: what about the current design leaves room for it
- Status: waiting, or done in S2.3
```

## Entries

(none yet)
