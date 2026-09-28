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

Settled with the owner before the run, because nobody answers while AutoClaude builds. Every
entry here is the owner's answer, never an assumption, and a decision the run applies without
asking. Changing one is a new entry in `docs/DECISIONS.md`.

### Stack

The fixed stack is listed in `CLAUDE.md` under "Tech stack". Only what this plan alone needs goes
here: a version pin, a library chosen for one phase.

### Data

Nothing decided yet. The data model, where data is stored, what is never stored (secrets,
personal data the project does not need), how migrations run, and how a test database is made
on this machine.

### Security

Nothing decided yet. Authentication (or why there is none, for example "no login: listens on
127.0.0.1 only"), who may do what, which input is validated, where secrets come from, and what
the run does with a choice that would accept a security risk (decide, log it for the owner's
review and keep going, or stop and ask). The security reviewer reads this section: a choice not
written here looks like a missing defence.

### Scope

Nothing decided yet. What the run may do outside this project folder, item by item, as the owner
chose it: "the run does it" (with the machines, addresses, sign-in method and IDs it needs),
"written for the owner" (the run writes the script or config and a test against a local
stand-in; running it is listed under "After the run") or left out. Whether a snapshot is taken
before the run changes an existing machine. What the run must never touch. Unless this section
says otherwise, the run may install tools and packages, use Docker and create GitHub
repositories, and it generates the secrets it needs into the gitignored `secrets/` folder.

### Out of scope

Nothing decided yet. What this plan deliberately does not do, so a step is never widened to
cover it. Ideas for later go in `docs/DEFERRED.md`.

### When something is unclear

Default answers the run applies without asking. Anything not covered here is a decider question
(`autoclaude decide`): routine answers are applied and logged in `docs/DECISIONS.md`, critical
ones stop the run.

- Stay within what the plan allows. Work outside this folder that the Scope section gives to the
  run is part of the job; anything else outside the folder is a decider question, and what Scope
  lists as never to be touched is never touched.
- Prefer what the repo already has: the existing library, pattern, naming and folder layout.
- Prefer the simplest thing that satisfies the Accept lines. No extra features, no abstraction
  for a future that is not in this plan.
- A secret the run needs (a database password, a signing key) is generated into the gitignored
  `secrets/` folder, one file each, and never committed, printed or copied into a doc. A paid
  service, an external account or a secret this machine cannot generate is a critical question:
  stop with `autoclaude blocked`.
- Never delete data the plan does not say to delete, drop a table outside a migration the plan
  asks for, or rewrite git history.
- A new runtime dependency is a decider question, logged in `docs/DECISIONS.md`. Dev dependencies
  the stack already names (the test runner, the lint tool) are fine.
- A choice that accepts a security risk (a weaker default, an open port, a skipped check) follows
  the policy in the Security section; logged, it carries `- Owner review: yes`.
- Something left for the owner (a manual action, a finding not fixed) gets a row in
  `docs/BLOCKERS.md` with the owner as its owner and the status `left for the owner: <reason>`.
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
  databases to create, accounts to sign in to, secrets this machine cannot generate.

## After the run

What the owner does once the run is complete, because the plan leaves it to them. Plain bullets,
each with the exact command or place. The run's `HANDOFF.md` repeats this list and adds what the
run itself left for the owner.

- Not written yet. Scripts the run wrote for the owner to run ("write it for me" in Scope),
  sign-ins or settings only a person can make, what to review before merging the run branch.
  "Nothing: the run does all of this plan" when that is the case.

## Phases

Each phase is one feature, a `## Phase N: title` heading, and ends with something that works end
to end. Each step is one checkbox line with a bold ID, followed by indented fields.

- Status markers: `[ ]` todo, `[~]` built and committed, waiting for its feature's verification,
  `[x]` verified, `[!]` failed and paused, `[?]` blocked. During a run only the gate changes a
  marker. Between runs the owner may tick one (accepted as done) or untick one (built again), and
  `autoclaude resume` honours it.
- With `gate.verifyAt: "phase"` (the default) the gate commits each step as it is built (`[~]`)
  and verifies the feature once, at the phase's last step: every check, the browser tester over
  every Accept line of the phase, the bug bash and the security review. The phase's boxes turn
  `[x]` together when it passes. With `"step"` every step is verified on its own.
- The ID is `S<phase>.<n>`, unique and in order. New steps get new IDs; an ID is never reused.
- `Accept:` is required, at least one per step, and must still hold when the feature is verified.
  Unless a step is tagged `no-ui`, the browser tester checks every Accept line in the browser, so
  each one must be visible there: page content, the URL, a fetch from the page, or a file it can
  read. What only a test can prove goes in a `no-ui` step.
- `Test:` names the spec files the step creates or extends; the checks must run them. A `no-ui`
  step must have one: its tests are all that verify it.
- `Tags:` `no-ui` (no browser check), `security` (for steps whose main work is authentication,
  permissions or secrets; with `"step"` verification the security review also runs on this
  step). `ui` and `db` are labels only; an untagged step is checked in the browser.
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
