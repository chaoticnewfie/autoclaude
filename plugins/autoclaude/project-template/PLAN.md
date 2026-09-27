# {{PROJECT_NAME}} plan

| | |
|---|---|
| Last updated | {{DATE}} |
| Current phase | Phase 1, not yet planned |
| Next step | none. Run `/autoclaude:plan` to write the first steps |

What is being built and in what order. Rules live in `CLAUDE.md`; where things stand right now
lives in `CONTINUE_HERE.md`. AutoClaude reads only the step lines and their indented fields; the
rest of this file is context for Claude and the decider.

## Goal

Not written yet. `/autoclaude:plan` fills this in from the interview with the owner: what the
project is for, who uses it, and what "done" looks like for version 1.

## Constraints & decisions

Settled before the run, because nobody answers while AutoClaude builds. Every entry here is a
decision the run applies without asking. Changing one is a new entry in `docs/DECISIONS.md`.

### Stack

The fixed stack is listed in `CLAUDE.md` under "Tech stack". Anything stack-related that only
this plan needs (a version pin, a library chosen for one phase) goes here.

### Data

Nothing decided yet. `/autoclaude:plan` records the data model, where data is stored, what is
never stored (secrets, personal data the project does not need) and how migrations run.

### Out of scope

Nothing decided yet. `/autoclaude:plan` lists what version 1 deliberately does not do, so a step
is never widened to cover it. Ideas for later go in `docs/DEFERRED.md`.

### When something is unclear

Default answers the run applies without asking. Anything not covered here is a decider question:
routine ones are logged in `docs/DECISIONS.md`, critical ones stop the run.

- Prefer what the repo already has: the existing library, pattern, naming and folder layout.
- Prefer the simplest thing that satisfies the Accept lines. No extra features, no abstraction
  for a future that is not in this plan.
- Never add a paid service, an external account, a secret or a credential. That is a critical
  question: stop with `autoclaude blocked`.
- Never delete data, drop a table, rewrite git history or touch files outside the project.
- A new runtime dependency needs a decision in this file. Dev dependencies the stack already
  names (the test runner, the lint tool) are fine.
- Naming follows the nearest existing example. Without one: plain descriptive names, no
  abbreviations.
- UI details that are not stated: reuse the existing components and their default styling. No
  new design system.
- Tests: extend the nearest existing spec before creating a new one. Every Accept line gets a
  check, in a test or in the browser.
- When two readings of a step both satisfy the Accept lines, take the one with the smaller diff
  and log the choice in `docs/DECISIONS.md`.
- When an Accept line cannot be satisfied as written, do not rewrite it. Run `autoclaude blocked`
  with the options.

## Requested features intake

Everything the owner asks for that is not being built right now, with where it landed. Rows are
added, never removed. Nothing is built early unless the owner says so.

| Date | Request, in the owner's words | Slotted into | Status |
|---|---|---|---|

## Before the run

What the owner does before `autoclaude run`, because the run cannot: tools to install,
environment variables to set, local services or test databases to create, accounts to sign in
to. Plain bullets, not checkboxes. `/autoclaude:plan` fills this in.

- Nothing yet.

## Phases

Each phase is a `## Phase N: title` heading. Each step is one checkbox line with a bold ID,
followed by indented fields.

- Status markers: `[ ]` todo, `[x]` verified (written only by the gate), `[!]` failed and paused,
  `[?]` blocked.
- The ID is `S<phase>.<n>` and unique in the plan.
- `Accept:` is required, at least one per step, and must be observable in a browser, a test or a
  command.
- `Test:` (spec files to create or extend) and `Tags:` (`ui`, `no-ui`, `security`, `db`) are
  optional. `Depends:` is reserved for a later version.
- A step is 20 to 90 minutes of work. Split anything bigger.
- `autoclaude lint-plan` enforces this. `autoclaude start` refuses a plan that fails lint.

One example, inside a code fence so the parser ignores it:

```markdown
## Phase 1: Accounts
- [ ] **S1.1** User can sign up with email and password
  - Accept: /signup shows a form with email, password and confirm fields
  - Accept: a valid submit creates the user and lands on /dashboard showing the email
  - Accept: a duplicate email shows "Email already registered"
  - Test: e2e/signup.spec.ts
  - Tags: ui, security
```

## Phase 1: TODO

<!-- /autoclaude:plan fills this in. With no steps, lint-plan fails and a run cannot start. -->
