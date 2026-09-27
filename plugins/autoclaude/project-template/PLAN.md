# {{PROJECT_NAME}} plan

What is being built and in what order. Rules live in `CLAUDE.md`; where things stand right now
lives in `CONTINUE_HERE.md`. AutoClaude reads only the step lines and their indented fields; the
rest of this file is context for Claude, the decider and the security reviewer. The H1 above
names the run branch (by default `autoclaude/<the H1 without "plan">`). `/autoclaude:plan`
replaces every placeholder below with the owner's answers; `autoclaude lint-plan` fails while
one is left.

## Goal

Not written yet. What the project is for, who uses it, and what "done" looks like for this plan.

## Constraints & decisions

Settled before the run, because nobody answers while AutoClaude builds. Every entry here is a
decision the run applies without asking. Changing one is a new entry in `docs/DECISIONS.md`.

### Stack

The fixed stack is listed in `CLAUDE.md` under "Tech stack". Only what this plan alone needs goes
here: a version pin, a library chosen for one phase.

### Data

Nothing decided yet. The data model, where data is stored, what is never stored (secrets,
personal data the project does not need), how migrations run, and how a test database is made
on this machine.

### Security

Nothing decided yet. Authentication (or why there is none, for example "no login: listens on
127.0.0.1 only"), who may do what, which input is validated, and where secrets come from. The
security reviewer reads this section: a choice not written here looks like a missing defence.

### Out of scope

Nothing decided yet. What this plan deliberately does not do, so a step is never widened to
cover it, and the files and systems the run must never touch. Ideas for later go in
`docs/DEFERRED.md`.

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

What the owner does before `autoclaude run`, because the run cannot. Plain bullets, not
checkboxes.

- Not written yet. Tools to install, environment variables to set, local services or test
  databases to create, accounts to sign in to.

## Phases

Each phase is a `## Phase N: title` heading and ends with something that works end to end. Each
step is one checkbox line with a bold ID, followed by indented fields.

- Status markers: `[ ]` todo, `[x]` verified, `[!]` failed and paused, `[?]` blocked. During a
  run only the gate ticks a box. Between runs the owner may tick one (accepted as done) or untick
  one (built again), and `autoclaude resume` honours it.
- The ID is `S<phase>.<n>`, unique and in order. New steps get new IDs; an ID is never reused.
- `Accept:` is required, at least one per step. The gate runs the checks on every step; unless a
  step is tagged `no-ui`, the browser tester then checks every Accept line in the browser, so
  each one must be visible there: page content, the URL, a fetch from the page, or a file it can
  read. What only a test can prove goes in a `no-ui` step.
- `Test:` names the spec files the step creates or extends; the checks must run them. A `no-ui`
  step must have one: its tests are all that verify it.
- `Tags:` `no-ui` (no browser check), `security` (the security review also runs on this step;
  for steps whose main work is authentication, permissions or secrets). `ui` and `db` are
  labels only; an untagged step is checked in the browser.
- `Note:` lines are free text kept with the step, for the builder and the browser tester: a
  dev-only login, how to create test data.
- A step is 20 to 90 minutes of work. Split anything bigger.
- `autoclaude lint-plan` checks the structure (phases, IDs and their order), the tags, a
  `Test:` line on `no-ui` steps and leftover placeholders; it cannot judge whether an Accept
  line is observable or a step too big. `autoclaude run` refuses a plan that fails lint.

One example, inside a code fence so the parser ignores it:

```markdown
## Phase 1: Accounts
- [ ] **S1.1** User can sign up with email and password
  - Accept: /signup shows a form with email, password and confirm fields
  - Accept: a valid submit lands on /dashboard showing the email
  - Accept: signing up twice with one email shows "Email already registered"
  - Test: e2e/signup.spec.ts
  - Tags: security
  - Note: every sign-up is new data; use a fresh email such as test-<time>@example.com
- [ ] **S1.2** Passwords are stored hashed
  - Accept: test/users.test.js shows the stored password is an argon2 hash, never the plain text
  - Test: test/users.test.js
  - Tags: no-ui, security
```

## Phase 1: TODO

<!-- /autoclaude:plan replaces this heading with the real phases. -->
