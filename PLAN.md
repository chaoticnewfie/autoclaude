# Claude Autopilot: build plan

**Owner:** Scott · **Drafted:** 2026-09-24 · **Status:** Ready to build
**Builds:** a portable Claude Code plugin that runs a project's `PLAN.md` step by step, unattended, and verifies every step before moving on.
**Primary machine:** a dedicated Debian LXC on the Proxmox server. The Windows/Mac PC is a secondary machine for supervised runs.

---

## 0. Instructions for Claude (read first)

You are building the tool this document describes. Scott will build it **with you, interactively, on the machine it will run on**. The autopilot doesn't exist yet, so it can't run this plan by itself.

1. Read the whole document before you write any code.
2. Work **one phase at a time**. Each phase ends with a **CHECKPOINT**. Stop there, show Scott the demo it describes, and wait for his go-ahead.
3. **Phase 0 is verification.** Several design choices depend on how Claude Code behaves today. If a Phase 0 finding contradicts this plan, update the affected sections of this plan, log the change in `DECISIONS.md`, and tell Scott before you continue.
4. Tick a step's checkbox (`- [x]`) only after its **Accept** lines are demonstrably true. Show the evidence: a command's output, a test run, or a screenshot.
5. The plugin's scripts use **only Node.js built-ins**: no npm dependencies, no bash, no jq. They must run on Linux, macOS and Windows.
6. Keep `PROGRESS.md` (what was done and when) and `DECISIONS.md` (choices made and why) up to date as you go.

---

## 1. What Scott wants

| # | Requirement (in Scott's words, where possible) |
|---|---|
| R1 | "Easily use it / move it / replicate it in different projects." |
| R2 | "Build the plan with Claude, then let the system run and build it." |
| R3 | "Run all day without my input… even running all night." |
| R4 | A bot that says "continue the plan" when Claude finishes a step. |
| R5 | A bot that answers questions when they come up. |
| R6 | A bot that tests features **in a browser** when Claude finishes something. |
| R7 | A bot that tests for bugs and security issues. |
| R8 | A bot that checks there are enough tokens to continue. |
| R9 | "Make sure we don't move on with broken features." Issues go back to Claude to fix. |
| R10 | Only interrupt Scott for "the most critical situations." |
| R11 | "Only pausing when low on tokens." |
| R12 | Works with his existing habit of large plan files in VS Code projects. |

### How each requirement is met

| # | Met by |
|---|---|
| R1 | A self-contained Claude Code **plugin** in its own git repo with a local marketplace. Install it once per machine and switch it on per project with `/autopilot:init`. Per-project differences live in `autopilot.config.json`. |
| R2 | The `/autopilot:plan` skill writes `PLAN.md` in the machine-readable step format. `autopilot run` starts the unattended loop. |
| R3 | An interactive Claude Code session in **tmux** on the LXC, with the built-in auto-continue after usage limits and an external **watchdog** that recovers stalls and crashes. |
| R4 | The **Stop gate** (a Stop hook). After a step passes verification, it tells Claude to start the next step. |
| R5 | `AskUserQuestion` is blocked while the autopilot runs. Claude settles open questions with the **decider** subagent against the plan's goals and constraints, and logs each one in `DECISIONS.md`. |
| R6 | The **browser tester**: a separate headless `claude -p` run using Playwright MCP that checks the step's acceptance criteria. Committed Playwright specs run too. |
| R7 | The full test suite runs on every step as regression checks. A **bug bash** runs at the end of each phase. The **security reviewer** runs at phase ends and on steps tagged `security`. |
| R8 | The **usage gate**. A statusline bridge records the 5-hour and weekly usage percentages, and the gate reads them. |
| R9 | The gate itself runs the checks and ticks `PLAN.md`. After 3 failed attempts it **pauses**. It never skips a failing step. |
| R10 | Notifications (ntfy or Discord) go out only for the critical events listed in §4.6. Everything else is decided and logged. |
| R11 | The built-in auto-continue waits out 5-hour limits. The gate pauses and notifies at the weekly threshold. |
| R12 | `PLAN.md` stays a normal Markdown file. The autopilot reads a light convention (§4.8.1) and still leaves room for prose. |

---

## 2. The goal

Scott spends an hour with Claude turning an idea into a solid `PLAN.md`, types `autopilot run`, and walks away. Claude works through the plan step by step for as long as usage allows. Each step is proven with automated tests and a real headless browser before it's committed. Failures go back to Claude with evidence until fixed, and after three tries the run stops rather than building on something broken. Scott's phone buzzes only when something needs him. In the morning he reads a summary, a clean git history of one commit per verified step, and a log of every decision Claude made on his behalf.

### Success criteria (v1.0)

- **Install:** set up on a new project in under 10 minutes with `/plugin install` and `/autopilot:init`.
- **Unattended:** completes a 12-step fixture plan with no human input, and each step produces exactly one commit.
- **Never advances on red:** in scenario tests, no step is ticked while any check or browser criterion fails.
- **Recovers on its own:** the fixture run survives a context compaction, a simulated API error, a killed `claude` process and a 5-hour usage reset.
- **Quiet:** the only notifications are those in §4.6. The dress rehearsal produces no false alarms.
- **Portable:** the same plugin repo works on the Linux LXC (full features) and on Windows/Mac (everything except the tmux-based watchdog nudges).

### Non-goals for v1

- Running several plan steps in parallel (worktrees or agent teams). This is a later idea.
- Deploying to production or pushing to remotes by default.
- Working without a Claude Pro/Max subscription. Usage percentages and auto-continue need one.
- A GUI or dashboard. The statusline, `autopilot status` and notifications are enough for v1.

---

## 3. Decisions

| ID | Decision | Why | Rejected alternatives |
|---|---|---|---|
| D1 | **Use Claude Code only.** Grok isn't needed. | Hooks, subagents, headless runs and usage data are all native. One subscription and one quota. | Grok Bot agents. They run on their own cloud VM and don't integrate with a local Claude Code session. |
| D2 | **Package as a Claude Code plugin** (`autopilot`) in its own git repo, with a **local-directory marketplace**. | One install per machine, and the plugin can be switched on or off per project. Loads in place, so edits apply on `/reload-plugins` without version bumps. Versioned in git. | Copying `.claude/` folders between projects, which drift apart. A global `~/.claude` setup, which affects every project. |
| D3 | **Run the build loop as an interactive session in tmux**, not as a `claude -p` loop. | Only interactive sessions automatically wait out the 5-hour limit and then carry on, and only they give the statusline the usage percentages. Scott can attach and watch at any time (VS Code Remote-SSH, then `tmux attach`). | An external driver calling `claude -p` per step: clean context per step, but no auto-wait and no usage data, so it would need an undocumented usage API. |
| D4 | **The gate is a deterministic Node Stop hook.** Claude signals "ready" and the gate verifies. | The builder can't skip tests or grade its own work. Only the gate ticks `PLAN.md` and commits. | `/goal` (its evaluator only reads the conversation and can't run tests). Agent-type hooks (experimental, 60 s default timeout). |
| D5 | **Browser testing runs in a separate headless `claude -p` process with Playwright MCP**, plus committed Playwright specs. | Needs no visible browser or logins, so it works on a headless LXC overnight. A separate process gives a fresh context and an independent verdict. Specs build a growing regression suite. | Claude in Chrome: needs a visible Chrome and pauses at logins. Fine for supervised sessions only. |
| D6 | **Failure policy: 3 attempts per step, then pause and notify.** Never advance past a failing step. | Directly satisfies R9. | Skipping failed steps and continuing with independent ones. This becomes a later option (`depends:`), off by default. |
| D7 | **Claude answers its own questions, and stops only for critical ones.** | Satisfies R5 and R10. Every decision is auditable in `DECISIONS.md`. | Waiting on `AskUserQuestion`, which would stall the run for hours. |
| D8 | **Usage handling:** the built-in auto-continue covers 5-hour limits. The gate pauses at a weekly threshold (default 85%). The watchdog is the fallback. | Satisfies R11 using built-in behaviour where possible. Keeping 15% of the week in reserve leaves Scott quota for daytime use. | Custom sleeping and retry logic for every limit. |
| D9 | **Permissions:** auto mode, a PermissionRequest hook that **denies** anything that would prompt (so the session never waits), a guard hook with a hard-deny list, and a dedicated LXC with no production credentials. | An unattended session must never block on a prompt. Auto mode falls back to prompting after 3 consecutive or 20 total classifier blocks, and the hook catches that. The LXC limits the blast radius. | `bypassPermissions` inside the LXC: simpler, but loses the classifier's protection. Kept as a documented fallback if Phase 0 shows the hook approach is unreliable. |
| D10 | **Notifications through ntfy**, self-hosted on Proxmox or ntfy.sh, **or a Discord webhook**. Both are configured per machine as plugin `userConfig`. | Deterministic, free, and works from the phone. Secrets stay out of project repos. | Relying on Claude app push notifications or Remote Control (see D14). |
| D11 | **All scripts are Node.js built-ins only.** | Cross-platform (Windows PC and Linux LXC), nothing to install, and the same runtime as the projects. | Bash plus jq, which breaks on Windows. |
| D12 | **Git: work on branch `autopilot/<plan-slug>`, one commit per verified step, a tag at each phase end, never push by default.** | Easy review and rollback. Morning review is a `git log`. | Committing directly to main. Auto-pushing. |
| D13 | **Security review at phase ends and on steps tagged `security`.** High-severity findings count as a failed attempt. Lower severities go to `SECURITY-FINDINGS.md`. | Catches issues without spending quota on every step. | Reviewing every step (too costly). Never reviewing. |
| D14 | **Remote Control stays disconnected during unattended runs** (to be verified in P0.7). | The docs say auto-continue doesn't start on its own in Remote Control sessions. Scott can still attach through VS Code/tmux, or connect Remote Control briefly to answer a blocker. | Leaving Remote Control connected all night. |
| D15 | **All state lives in files** (`PLAN.md`, `.autopilot/state.json`, `PROGRESS.md`, git). | Any crash, restart or compaction can resume exactly where it left off. | Keeping state in memory or in the conversation. |
| D16 | **Default models:** the builder uses the session model (Opus). The tester uses Sonnet. The security reviewer uses Opus. All three can be changed in config. | Balances quality against quota. The tester runs often, so it gets the cheaper model. | Opus everywhere, which burns quota. |

---

## 4. Architecture

### 4.1 Overview

```
 Scott ──(plans with Claude)──► PLAN.md + autopilot.config.json
                                        │
                        autopilot run   ▼
┌──────────────── tmux: ap-<project> ─────────────────────────────────────┐
│  claude --permission-mode auto   (interactive builder session)          │
│     │  works on step Sx.y …  runs `autopilot ready Sx.y` … tries to stop│
│     ▼                                                                   │
│  STOP GATE (Stop hook, Node)                                            │
│   1 integrity + progress checks                                         │
│   2 deterministic checks: lint / typecheck / unit / e2e (dev server up) │
│   3 browser tester: claude -p + Playwright MCP (headless) → verdict     │
│   4 security reviewer (phase end / tag:security) → verdict              │
│   5 usage gate (weekly threshold)                                       │
│     ├─ FAIL → block stop, send evidence back to Claude (≤3 attempts)    │
│     ├─ PASS → tick PLAN.md, commit, block stop with "start next step"   │
│     └─ PAUSE/COMPLETE → allow stop + notify                             │
└─────────────────────────────────────────────────────────────────────────┘
   ▲ statusline bridge writes usage.json      ▲ heartbeat on every tool call
   │                                          │
 WATCHDOG (systemd timer, every 5 min): stalled? crashed? reset passed?
   → nudge through tmux / relaunch with `claude --continue` / notify
 NOTIFY: ntfy or Discord → Scott's phone (critical events only)
```

### 4.2 Components

| Component | Kind | Job |
|---|---|---|
| `autopilot` CLI (`bin/autopilot`) | Node CLI, on Claude's PATH and symlinked into `~/.local/bin` | `init`, `run`, `start`, `ready`, `blocked`, `answer`, `status`, `pause`, `resume`, `lint-plan`, `usage`, `watchdog`, `notify-test`, `install-cli` |
| Session context | `SessionStart` hook (startup, resume, clear, compact) | While running, injects the autopilot rules, the current step's full text and the tail of `PROGRESS.md`. This re-grounds Claude after every compaction. |
| Stop gate | `Stop` hook | The core loop (§4.4) |
| Tool guard | `PreToolUse` hook | While running: denies `AskUserQuestion` and points Claude to the decider. Blocks edits to `PLAN.md`, `.autopilot/**` and `autopilot.config.json`. Hard-denies force pushes, `git reset --hard` on protected branches, and `rm -rf` outside the project. |
| Permission auto-deny | `PermissionRequest` hook | While running: denies anything that would prompt, with guidance ("no human is available; pick another approach or run `autopilot blocked`"). Logs the denial. |
| Heartbeat | `PostToolUse` hook (async) | Touches `.autopilot/heartbeat` and counts tool calls, which gives the gate and the watchdog a progress signal. |
| Failure handler | `StopFailure` hook | Logs API-error turn endings. Rate limits are left to auto-continue. For other errors it schedules a watchdog nudge. |
| Idle detector | `Notification` hook (`idle_prompt`, `permission_prompt`, `agent_needs_input`) | While running, any of these means the session is waiting on a human, which is critical. Notify. |
| Session end | `SessionEnd` hook | Records how the session ended. If the autopilot was still running, flags it for the watchdog. |
| Statusline bridge | Script at `~/.claude/autopilot/statusline.js`, registered in user settings | Writes `usage.json`. Shows `AP S2.3 ▸ running │ 5h 42% │ 7d 18%`. Chains any existing statusline. |
| Decider | Plugin subagent `autopilot:decider` | Answers Claude's open questions against the plan's goals and constraints. Classifies each as routine or critical. |
| Browser tester | Prompt plus headless `claude -p` run (Sonnet) | Checks acceptance criteria in a real browser and returns a JSON verdict. |
| Security reviewer | Prompt plus headless `claude -p` run (Opus) | Reviews the diff since the last phase tag and returns a JSON verdict. |
| Watchdog | `autopilot watchdog` on a systemd user timer (cron as an alternative) | Recovers stalls and crashes, and resumes after a weekly reset if enabled. |
| Notifier | `lib/notify.js` | ntfy / Discord / stdout |
| Planner | `/autopilot:plan` skill | Interviews Scott and writes `PLAN.md` in the step format |

> A plugin can't set `statusLine` itself: plugin `settings.json` only supports `agent` and `subagentStatusLine`. `init` therefore installs the bridge into user settings once per machine.
> Plugin subagents ignore the `hooks`, `mcpServers` and `permissionMode` fields, so the tester and security reviewer are run by the gate as `claude -p` processes rather than as plugin subagents.

### 4.3 States

```
idle ──start──► running ──(gate: step passes)──► running (next step)
                  │  ├─ step fails 3×            ──► paused(step-failed)
                  │  ├─ Claude runs `blocked`    ──► paused(blocked)
                  │  ├─ weekly usage ≥ limit     ──► paused(weekly-limit)
                  │  ├─ no progress 3 stops      ──► paused(stuck)
                  │  ├─ high security unresolved ──► paused(security)
                  │  └─ `autopilot pause`        ──► paused(manual)
                  └─ last step passes            ──► complete
paused ──`autopilot resume` / `answer` / watchdog (weekly reset, if enabled)──► running
```

When the state isn't `running`, **every hook exits straight away**, so normal interactive work in the project behaves exactly as it did without the plugin.

### 4.4 Stop gate algorithm

```
on Stop(input):
  if env.AUTOPILOT_ROLE is set            → allow        # nested tester/reviewer runs
  state = load(); if state.status != running → allow
  integrity: PLAN.md checkboxes match state.json record?
      if not → revert unauthorized ticks, block("Only the gate ticks PLAN.md…")
  step = state.currentStep

  if blocked marker for step:
      state → paused(blocked); notify(CRITICAL, question); allow

  if no ready marker for step:
      if no tool calls since last gate run and git tree unchanged:
          state.noProgress++
          if ≥ maxNoProgressStops → paused(stuck); notify; allow
      block("Continue {step}. When all Accept lines hold, run `autopilot ready {step}`.
             If you truly can't proceed, run `autopilot blocked {step} \"<reason>\"`.")

  # verify
  ensure dev server healthy (start it if needed)
  results = run checks in order (stop at first failure)
  if all pass and step not tagged no-ui   → results += browser tester(step)
  if phase end or step tagged security    → results += security review(diff)
  if phase end                            → results += bug bash(phase)

  if any failure:
      attempts[step]++ ; write full report to .autopilot/reports/{step}-{n}.md
      if attempts[step] ≥ maxAttempts:
          mark step [!] ; state → paused(step-failed) ; notify(CRITICAL) ; allow
      block("{step} attempt {n}/{max} failed:\n{≤4k-char summary}\nFull report: {path}\nFix the causes, then run `autopilot ready {step}` again.")

  # pass
  tick step [x] ; append PROGRESS.md ; git commit "autopilot({step}): {title}"
  if phase end: git tag ap-{phase}
  if usage.weekly ≥ weeklyPauseAt:
      state → paused(weekly-limit) ; notify ; allow
  next = next unchecked step
  if none: state → complete ; stop dev server ; notify(summary) ; allow
  state.currentStep = next ; reset counters
  block("{step} verified and committed. Next: {next.id} {next.title}\n{next full text}")
```

Notes for the implementation:
- **Don't** exit early on `stop_hook_active`. The loop is supposed to keep continuing. Stay under Claude Code's cap of 8 consecutive blocks without progress by using the gate's own no-progress counter (3). Raise `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` only if Phase 0 shows that tool use doesn't reset the cap.
- Keep the `reason` text short: hook output over 10,000 characters gets truncated to a file preview. Always write the full detail to a report file and give its path.
- Set the Stop hook `timeout` from config (default 1800 s) so the e2e suite, the tester and the reviewer can finish.

### 4.5 How Claude handles questions (R5)

While running, Claude follows this policy, injected through SessionStart:
1. Check whether the answer is already in `PLAN.md` (goals, constraints, decisions) or `DECISIONS.md`. If it is, use it.
2. If not, ask the **decider** subagent. It returns a recommendation, the reasoning, and a `routine` or `critical` classification.
3. **Routine:** apply the recommendation, append it to `DECISIONS.md` (`D-###`, step, question, choice, why, how to reverse it), and continue.
4. **Critical:** run `autopilot blocked <step> "<question with options>"` and stop.

**Critical** means any of these:
- needs a secret, credential, paid service or external account
- an irreversible or destructive action (dropping data, deleting files outside the project, rewriting git history)
- a security or privacy trade-off
- a change that contradicts the plan's stated goals or architecture
- a requirement ambiguous enough that either answer means significant rework

Everything else is routine: library choices within the stated constraints, naming, UI details, file layout, test design.

### 4.6 What wakes Scott up (R10)

| Event | Priority | Message includes |
|---|---|---|
| Step failed 3 times | High | Step, last failure summary, report path |
| Claude blocked on a critical question | High | The question and its options, plus how to answer (`autopilot answer "…"`) |
| Session waiting for input (idle or permission prompt) | High | Project and tmux target |
| Watchdog couldn't recover (2 nudges failed, or relaunch failed) | High | What it tried |
| High-severity security finding still unresolved after 3 attempts | High | Finding summary |
| Weekly usage threshold reached | Default | Usage %, reset time, whether it will auto-resume |
| Plan complete | Default | Summary: steps, commits, decisions, duration |
| Morning summary (optional, at a set time) | Low | Progress overnight |

Nothing else sends a notification: routine decisions, retries that later pass, 5-hour limit waits, compactions and successful watchdog nudges only go to the logs.

### 4.7 Safety

- The LXC runs as a **non-root user** and holds no production credentials, SSH keys to other hosts, or cloud admin tokens.
- Auto mode classifier, plus the guard hook's hard-deny list, plus the PermissionRequest auto-deny.
- Git: the autopilot branch only, a clean tree is required to start, no pushes by default, and every step is a separate commit (rollback is `git reset` to a tag).
- `PLAN.md`, `.autopilot/**` and `autopilot.config.json` can't be edited by Claude while running. The gate also checks the integrity of `PLAN.md` on every stop.
- Nested `claude -p` runs (tester and reviewer) use `--settings '{"disableAllHooks":true}'`, `AUTOPILOT_ROLE=…`, `--permission-mode dontAsk` and a narrow `--allowedTools` list (browser tools plus read-only file tools for the tester, read-only tools for the reviewer).

### 4.8 Contracts

#### 4.8.1 `PLAN.md` step format

A plan is normal Markdown. The autopilot only reads **step lines** and their indented fields. Everything else (goal, constraints, notes) is context for Claude and the decider.

```markdown
# <Project> plan

## Goal
…

## Constraints & decisions
- Stack: …
- Don't: …

## Phase 1: Accounts
- [ ] **S1.1** User can sign up with email and password
  - Accept: /signup shows a form with email, password, confirm
  - Accept: valid submit creates the user and lands on /dashboard showing the email
  - Accept: a duplicate email shows "Email already registered"
  - Test: e2e/signup.spec.ts
  - Tags: ui, security
- [ ] **S1.2** …
```

- Status markers: `[ ]` todo, `[x]` verified (written only by the gate), `[!]` failed and paused, `[?]` blocked.
- An ID is `S<phase>.<n>`, unique within the plan. A phase is an `## Phase N: …` heading.
- `Accept:` lines are required (at least one) and must be observable in a browser, a test or a command.
- Optional fields: `Test:` (spec files to create or extend), `Tags:` (`ui`, `no-ui`, `security`, `db`, …), `Depends:` (reserved for a later version).
- `autopilot lint-plan` enforces these rules. `start` refuses to run a plan that fails lint.
- Step size: aim for 20–90 minutes of work. The planner splits anything bigger.

#### 4.8.2 `autopilot.config.json` (committed, one per project)

```json
{
  "version": 1,
  "plan": "PLAN.md",
  "branch": "autopilot/{planSlug}",
  "devServer": { "command": "npm run dev", "url": "http://localhost:5173", "healthPath": "/", "startTimeoutSec": 90 },
  "checks": [
    { "name": "lint",      "command": "npm run lint",      "timeoutSec": 300 },
    { "name": "typecheck", "command": "npm run typecheck", "timeoutSec": 300 },
    { "name": "unit",      "command": "npm test",          "timeoutSec": 600 },
    { "name": "e2e",       "command": "npx playwright test", "timeoutSec": 900, "needsDevServer": true }
  ],
  "tester":   { "enabled": true, "model": "sonnet", "maxTurns": 40, "timeoutSec": 900 },
  "security": { "when": ["phase-end", "tag:security"], "blockOn": "high", "model": "opus", "timeoutSec": 900 },
  "bugBash":  { "atPhaseEnd": true },
  "retries":  { "maxAttemptsPerStep": 3, "maxNoProgressStops": 3, "maxMinutesPerStep": 120 },
  "usage":    { "weeklyPauseAtPct": 85, "autoResumeAfterWeeklyReset": false, "staleAfterMin": 30 },
  "git":      { "commitEachStep": true, "tagPhaseEnds": true, "push": false },
  "gate":     { "timeoutSec": 1800 },
  "notify":   { "morningSummaryAt": null }
}
```

Secrets such as the ntfy URL and token and the Discord webhook **never** go in this file. They're plugin `userConfig` values (sensitive ones are stored in the machine's keychain or credentials file) and reach hooks as `CLAUDE_PLUGIN_OPTION_*` environment variables.

#### 4.8.3 Runtime files (`.autopilot/`, gitignored)

- `state.json`: `{ status, pauseReason, currentStep, attempts{}, noProgress, toolCallsAtLastGate, headAtLastGate, stepStartedAt, startedAt, tmuxTarget, sessionId, tickedByGate[] }`
- `ready.json` and `blocked.json`: written by the CLI, consumed by the gate
- `heartbeat`: mtime plus tool-call counter
- `reports/<step>-<attempt>.md`: full check output, tester verdict and screenshots
- `logs/gate.log`, `logs/denials.log`, `logs/watchdog.log`

Per machine: `~/.claude/autopilot/usage.json` (written by the statusline bridge) and `~/.claude/autopilot/registry.json` (projects the watchdog should watch).

Committed per project: `PROGRESS.md` (the gate appends one line per verified step), `DECISIONS.md` (Claude appends), `BLOCKERS.md`, `SECURITY-FINDINGS.md`.

#### 4.8.4 Tester and reviewer verdicts (requested through `--json-schema`)

```json
{
  "verdict": "pass | fail",
  "criteria": [{ "text": "…", "result": "pass | fail", "evidence": "…" }],
  "bugs": [{ "severity": "high | medium | low", "title": "…", "repro": "…", "expected": "…", "actual": "…" }],
  "consoleErrors": ["…"],
  "notes": "…"
}
```

The security reviewer uses the same shape, with `findings[]` (`severity`, `file`, `line`, `issue`, `fix`) in place of `criteria`.

### 4.9 Plugin repo layout

```
claude-autopilot/
├── .claude-plugin/marketplace.json        # local marketplace "autopilot-local"
├── plugins/autopilot/
│   ├── .claude-plugin/plugin.json         # name, version, userConfig (ntfy_url, ntfy_token*, discord_webhook*)
│   ├── hooks/hooks.json                   # exec-form: node ${CLAUDE_PLUGIN_ROOT}/scripts/*.js
│   ├── scripts/                           # one file per hook
│   │   session-context.js  stop-gate.js  tool-guard.js  permission-deny.js
│   │   heartbeat.js  stop-failure.js  notify-idle.js  session-end.js
│   ├── lib/                               # plan, state, config, checks, devserver, tester,
│   │                                      # security, usage, git, notify, report, tmux, fsatomic
│   ├── bin/autopilot                      # CLI (Node, shebang)
│   ├── skills/{plan,init,start,status,pause,resume,answer}/SKILL.md
│   ├── agents/decider.md
│   ├── prompts/{context,tester,security,bugbash}.md
│   └── templates/{autopilot.config.json, PLAN.template.md, playwright.config.ts,
│                  mcp.playwright.json, statusline-bridge.js,
│                  autopilot-watchdog.service, autopilot-watchdog.timer}
├── test/
│   ├── unit/*.test.js                     # node --test
│   ├── scenarios/*.test.js                # feed fake hook JSON to scripts
│   └── fixtures/{todo-app, plans/}
├── docs/USAGE.md
├── PLAN.md  PROGRESS.md  DECISIONS.md  VERIFY.md
└── README.md
```

---

## 5. The plan

### Phase 0: Verify how Claude Code behaves today
*Each spike goes in `spikes/` (throwaway) and its result goes in `VERIFY.md`.*

- [ ] **P0.1** Record the environment
  - Accept: `VERIFY.md` lists the OS, Node version, `claude --version` (must be at least v2.1.260, otherwise update), plan type, git and tmux versions
- [ ] **P0.2** Spike the Stop-hook continue loop
  - Accept: a minimal Node Stop hook that returns `{"decision":"block","reason":…}` makes Claude continue with that reason, 3 times in a row, each with tool use in between
  - Accept: documented: the value of `stop_hook_active` on each call, whether tool use resets the 8-block cap, and whether `last_assistant_message` is present
  - Accept: a Stop hook with `"timeout": 1200` that sleeps 300 s isn't killed
- [ ] **P0.3** Spike the statusline bridge
  - Accept: a statusline script receives `rate_limits.five_hour` and `rate_limits.seven_day` (used_percentage and resets_at) and writes them to a file. Documented how soon after startup they appear.
- [ ] **P0.4** Spike a nested headless run from a hook
  - Accept: a Stop hook spawns `claude -p` with `--settings '{"disableAllHooks":true}' --output-format json --json-schema … --model sonnet` and parses `structured_output`
  - Accept: documented whether nested-session detection (`CLAUDECODE` env var) interferes, and the workaround (for example, stripping it from the child env)
  - Accept: the nested run uses Scott's subscription login, not an API key
- [ ] **P0.5** Spike headless browser testing
  - Accept: `npx playwright install --with-deps chromium` succeeds on this machine
  - Accept: `claude -p` with Playwright MCP (`npx @playwright/mcp@latest --headless`, passed through `--mcp-config` and `--strict-mcp-config`) opens a local page, clicks a button and reports the resulting text
- [ ] **P0.6** Spike the unattended permission behaviour
  - Accept: a `PermissionRequest` hook returning `decision.behavior: "deny"` with a message makes Claude carry on without a prompt appearing
  - Accept: a `PreToolUse` deny on `AskUserQuestion` returns the guidance text to Claude
  - Accept: documented what happens after repeated auto-mode classifier blocks (does the PermissionRequest hook catch the fallback prompts?)
- [ ] **P0.7** Confirm the usage-limit behaviour
  - Accept: `autoContinueAtUsageLimit` is on (check with `/config`)
  - Accept: documented from the current docs: auto-continue conditions, the "re-arms at most twice in a row" rule, the weekly exception (over 24 h), and whether a connected Remote Control session disables auto-continue (D14)
- [ ] **P0.8** Spike tmux control
  - Accept: `tmux send-keys -t <target> "<text>" Enter` submits a prompt into a running interactive `claude` session
  - Accept: `tmux capture-pane -p` can tell apart these states: working, idle prompt, usage-limit wait line, shell (claude exited)
- [ ] **P0.9** Reconcile
  - Accept: `VERIFY.md` has a Pass/Changed/Blocked row for every Phase 0 step
  - Accept: every "Changed" row is reflected in this plan and in `DECISIONS.md`

**CHECKPOINT 0:** Walk Scott through `VERIFY.md` and any changes to the plan.

### Phase 1: Plugin skeleton and core libraries

- [ ] **P1.1** Repo, local marketplace and an installable empty plugin
  - Accept: `/plugin marketplace add ~/code/claude-autopilot` then `/plugin install autopilot@autopilot-local` succeeds
  - Accept: `/autopilot:status` prints "autopilot: not initialized in this project"
  - Accept: `claude plugin validate plugins/autopilot --strict` passes
- [ ] **P1.2** `lib/plan.js`: parse, find the next step, set a marker, lint
  - Accept: unit tests cover the step format in §4.8.1, prose between steps, nested bullets, CRLF files, duplicate IDs, missing Accept lines and unknown markers
  - Accept: writes change only the marker characters and leave everything else byte-for-byte identical
- [ ] **P1.3** `lib/state.js`, `lib/config.js`, `lib/fsatomic.js`
  - Accept: state writes are atomic (temp file then rename) and survive a simulated crash mid-write
  - Accept: config merges defaults, validates types and gives clear errors, with no dependencies
- [ ] **P1.4** CLI skeleton `bin/autopilot` with `status`, `pause`, `resume`, `lint-plan`, `usage`, `install-cli`
  - Accept: `autopilot install-cli` symlinks into `~/.local/bin` (on Windows, prints a PATH hint)
  - Accept: `autopilot status` shows state, current step, attempts, usage and last progress time
- [ ] **P1.5** `lib/notify.js` and `userConfig`
  - Accept: `plugin.json` declares `ntfy_url`, `ntfy_token` (sensitive), `discord_webhook` (sensitive) and `notify_channel`
  - Accept: `autopilot notify-test` delivers a message to Scott's phone through the configured channel
  - Accept: with no channel configured, it falls back to stdout plus `logs/notify.log`

**CHECKPOINT 1:** Demo the install, `status` and a test notification on Scott's phone. `node --test` passes.

### Phase 2: Project init and context injection

- [ ] **P2.1** `/autopilot:init` skill and `autopilot init`
  - Accept: in a fresh project it detects `package.json` scripts and writes `autopilot.config.json` with the detected commands (asking Scott to confirm anything it's unsure of)
  - Accept: it creates `PROGRESS.md`, `DECISIONS.md`, `BLOCKERS.md` and `SECURITY-FINDINGS.md`, and adds `.autopilot/` to `.gitignore`
  - Accept: it offers to add Playwright (config plus one smoke spec) if missing, and writes the tester's MCP config into `.autopilot/mcp.playwright.json`
  - Accept: running it again is safe (idempotent) and never overwrites a filled-in config or plan
- [ ] **P2.2** Statusline bridge
  - Accept: `init` installs `~/.claude/autopilot/statusline.js` and registers it in `~/.claude/settings.json`, chaining any existing `statusLine` command and leaving its output intact
  - Accept: `usage.json` updates while a session runs. The statusline shows `AP <step> ▸ <status> │ 5h N% │ 7d N%` while running, and just the chained output otherwise.
- [ ] **P2.3** Context injection
  - Accept: while running, starting, resuming, `/clear` or `/compact` injects `prompts/context.md`, the current step's full text and the last 10 `PROGRESS.md` lines
  - Accept: when not running, nothing is injected
- [ ] **P2.4** Machine registry
  - Accept: `init` adds the project to `~/.claude/autopilot/registry.json`, and `autopilot status --all` lists every registered project

**CHECKPOINT 2:** Run `init` on the fixture app and show the generated config, the statusline and the injected context after `/compact`.

### Phase 3: The Stop gate (core loop)

- [ ] **P3.1** Fixture app and plans
  - Accept: `test/fixtures/todo-app`: a minimal web app (Vite or Express with static HTML) with a unit test, a Playwright spec and `npm run dev`
  - Accept: `test/fixtures/plans/` contains `happy.md` (3 steps), `broken.md` (one step whose test can't pass) and `ui-bug.md` (unit tests pass but the UI is broken)
- [ ] **P3.2** Ready/blocked protocol and gate skeleton
  - Accept: `autopilot ready <id>` and `autopilot blocked <id> "<reason>"` write the markers, and reject IDs that aren't the current step
  - Accept: gate behaviour follows §4.4 for not-running (allow), no ready marker (continue nudge) and no progress (counter then pause)
- [ ] **P3.3** `lib/devserver.js`
  - Accept: health-checks the URL, starts the command detached with logs in `.autopilot/logs/devserver.log`, reuses a running server, and stops it on complete or pause
- [ ] **P3.4** `lib/checks.js` and `lib/report.js`
  - Accept: runs the checks in order with per-check timeouts, stops at the first failure, and captures the last 150 lines of each failing check
  - Accept: the report file holds full output. The summary sent to Claude is ≤ 4,000 characters and names the report path.
- [ ] **P3.5** Pass path
  - Accept: ticks the step, appends `PROGRESS.md`, commits `autopilot(<id>): <title>`, tags phase ends, advances to the next step and sends Claude the next step's full text
  - Accept: the last step marks the plan complete and sends the summary notification
- [ ] **P3.6** Fail path
  - Accept: attempts increment. On the 3rd failure the step is marked `[!]`, the state pauses, a high-priority notification goes out and the stop is allowed.
- [ ] **P3.7** Integrity check
  - Accept: if a `PLAN.md` box was ticked by anything other than the gate, the gate reverts it and tells Claude why
- [ ] **P3.8** Scenario tests (no live Claude, fake hook stdin)
  - Accept: `node --test test/scenarios` covers pass, fail→retry→pass, fail×3→pause, blocked, no-progress→pause, integrity violation and complete

**CHECKPOINT 3 (first live run):** On the fixture, Scott runs `happy.md` with a real Claude session. All 3 steps are verified and committed with no input. `broken.md` pauses after 3 attempts and sends a notification.

### Phase 4: Browser tester

- [ ] **P4.1** `prompts/tester.md`
  - Accept: the tester only reads and browses (never edits code), checks every Accept line, runs a quick smoke check of neighbouring features, gives evidence for each criterion and collects console errors
- [ ] **P4.2** `lib/tester.js`
  - Accept: spawns `claude -p` with the config model, `--max-turns`, `--strict-mcp-config --mcp-config .autopilot/mcp.playwright.json`, `--permission-mode dontAsk`, a narrow `--allowedTools`, `--settings '{"disableAllHooks":true}'`, `--output-format json --json-schema <verdict>` and `AUTOPILOT_ROLE=tester`
  - Accept: timeouts or unparseable output count as an infrastructure failure: retried once, then reported, without using up one of the step's attempts
  - Accept: saves the verdict and any screenshots under `reports/`
- [ ] **P4.3** Wire into the gate
  - Accept: the tester runs only after the deterministic checks pass. Steps tagged `no-ui` skip it. Failing criteria and bugs become the failure summary with repro steps.
- [ ] **P4.4** Phase-end bug bash
  - Accept: at a phase's last step, `prompts/bugbash.md` explores every feature ticked in that phase. High-severity bugs fail the gate, others go to `BLOCKERS.md` as follow-ups.
- [ ] **P4.5** Scenario
  - Accept: on `ui-bug.md` the unit tests pass, the tester catches the UI bug, Claude fixes it on the next attempt and the step passes

**CHECKPOINT 4:** Live run of `ui-bug.md`, with the tester's verdict and screenshots shown.

### Phase 5: Guardrails for unattended runs

- [ ] **P5.1** Questions
  - Accept: while running, `AskUserQuestion` is denied with guidance to follow §4.5
  - Accept: `agents/decider.md` exists and returns `{recommendation, reasoning, classification}`. `DECISIONS.md` entries follow the format in §4.5.
- [ ] **P5.2** Critical blocker round-trip
  - Accept: `autopilot blocked` pauses the run and notifies with the question. `autopilot answer "<text>"` (from a shell, or `/autopilot:answer` in the session) records the answer in `DECISIONS.md`, resumes, and the answer reaches Claude through the next context injection or nudge.
- [ ] **P5.3** Permission handling and the tool guard
  - Accept: while running, anything that would prompt is denied with guidance and logged. If denials exceed 10 per hour, a notification goes out.
  - Accept: the hard-deny list (force push, `git reset --hard` on main or master, `rm -rf` outside the project, edits to protected autopilot files) is denied, and shell commands that write to `PLAN.md` are caught as well
- [ ] **P5.4** Security reviewer
  - Accept: runs at phase end and on `security`-tagged steps over `git diff <last ap tag>..HEAD`. High severity fails the gate, anything else is appended to `SECURITY-FINDINGS.md`.
  - Accept: a fixture step with an obvious flaw (for example SQL built by string concatenation, or a hardcoded secret) is caught
- [ ] **P5.5** Usage gate
  - Accept: with a fake `usage.json` showing weekly ≥ threshold, the gate pauses after the current step's commit and notifies with the reset time
  - Accept: usage data older than `staleAfterMin` produces one log warning, never a pause

**CHECKPOINT 5:** Demo a blocked question answered from Scott's phone or a shell, a caught security flaw, and a weekly-limit pause.

### Phase 6: Recovery, watchdog and notifications

- [ ] **P6.1** Idle and permission-prompt detector (`Notification` hook)
  - Accept: while running, `idle_prompt`, `permission_prompt` or `agent_needs_input` sends a high-priority notification (throttled to one per 30 minutes)
- [ ] **P6.2** `StopFailure` handling
  - Accept: `rate_limit` is only logged. Other error types are logged and flagged for the watchdog's next pass.
- [ ] **P6.3** `autopilot run`
  - Accept: from a shell in the project, it creates or attaches the tmux session `ap-<slug>` running `claude --permission-mode auto "/autopilot:start"`, records the tmux target in state, and prints how to attach and detach
  - Accept: `/autopilot:start` runs the preflight (clean tree, branch, config valid, plan lints, checks runnable, dev server healthy, Playwright installed, usage below threshold, notify channel configured), then sets running and starts on the first unchecked step
- [ ] **P6.4** `autopilot watchdog`
  - Accept: templates install a systemd **user** timer running every 5 minutes (`loginctl enable-linger` documented). Cron is documented as an alternative.
  - Accept: for each running project it decides from the heartbeat age, pane state (P0.8), usage reset times and state:
    - working → nothing
    - usage-limit wait → nothing
    - idle and stale over 15 min → nudge `/autopilot:resume`
    - shell showing (claude exited) → relaunch `claude --continue --permission-mode auto "/autopilot:resume"`
    - 2 recoveries in a row with no progress → pause and notify
  - Accept: if `autoResumeAfterWeeklyReset` is on, it resumes a weekly-limit pause after the reset time
- [ ] **P6.5** Summaries
  - Accept: plan-complete and optional morning summaries include steps done, attempts, decisions made, blockers, usage used and elapsed time
- [ ] **P6.6** Chaos tests (live, on the fixture)
  - Accept: the run recovers without Scott from each of: `kill` of the claude process mid-step, a forced `/compact` mid-step, a simulated stall (hook sleeps), and a dev server crash

**CHECKPOINT 6:** Show the chaos-test log and the notifications received.

### Phase 7: Planner, docs and an overnight dress rehearsal

- [ ] **P7.1** `/autopilot:plan` skill
  - Accept: interviews Scott (goal, users, stack, constraints, out of scope), proposes phases and 20–90 minute steps with browser-observable Accept lines, `Test:` files and tags, writes `PLAN.md` from `PLAN.template.md`, and runs `lint-plan`
  - Accept: the Constraints & decisions section is filled in, because the decider relies on it
- [ ] **P7.2** Docs
  - Accept: `README.md` (what it is, a 5-minute quickstart) and `docs/USAGE.md` (install, init, plan, run, watch, alerts, answering blockers, recovery, uninstall, troubleshooting, Windows notes)
- [ ] **P7.3** Overnight dress rehearsal
  - Accept: a 12-step, 3-phase fixture plan (use `/autopilot:plan` to write it) runs overnight on the LXC with no input
  - Accept: the morning review finds 12 commits, every step verified, no false alarms, and every issue found turned into a fix or a backlog item
- [ ] **P7.4** Release
  - Accept: `plugin.json` version `1.0.0`, git tag `v1.0.0`, `CHANGELOG.md`

**CHECKPOINT 7:** Morning-after review of the dress rehearsal with Scott.

### Phase 8: Rollout

- [ ] **P8.1** First real project on the LXC: `/autopilot:init`, `/autopilot:plan`, Scott reviews `PLAN.md`, a supervised run of 2–3 steps (watching in tmux), then unattended
- [ ] **P8.2** Optional: install on the Windows PC for supervised runs (the watchdog nudge needs tmux, so use WSL or skip it)
- [ ] **P8.3** Backlog of later ideas: `Depends:` with park-and-skip for failed steps, parallel steps in worktrees, a second-opinion reviewer through another provider's API, run windows (for example nights only), a progress dashboard page, and answering blockers through Remote Control

---

## 6. How to run this plan

### 6.1 Prepare the machine (once)

1. **Create the LXC** on Proxmox: Debian 13, unprivileged, about 4 vCPU, 8 GB RAM, 40 GB disk, static IP. Name it something like `claude-runner`.
2. Inside the LXC, as root:
   ```bash
   apt update && apt install -y git tmux curl ca-certificates build-essential sudo
   # Node 22 LTS (NodeSource, or nvm under the user below)
   adduser claude && usermod -aG sudo claude
   ```
3. As the `claude` user:
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash   # Claude Code native installer
   claude            # log in with your Claude subscription, then /exit
   sudo npx playwright install-deps chromium && npx playwright install chromium
   git config --global user.name "Scott" && git config --global user.email "<you>"
   ```
4. On your PC: VS Code, then the **Remote-SSH** extension, then connect to `claude@claude-runner`. You'll open folders and terminals on the LXC from here.
5. On your phone: install the **ntfy** app and subscribe to a hard-to-guess topic, either on ntfy.sh or a self-hosted ntfy LXC. A Discord webhook works too.

### 6.2 Bootstrap the repo

```bash
mkdir -p ~/code/claude-autopilot && cd ~/code/claude-autopilot
git init
# put this file here as PLAN.md
git add PLAN.md && git commit -m "Add build plan"
tmux new -s build          # so the session survives disconnects
claude --permission-mode auto
```

### 6.3 Kickoff prompt (paste into Claude)

> Read PLAN.md in full. We're building the Claude Autopilot plugin it describes, on this machine, which is where it will run. Follow section 0 exactly: one phase at a time, stop at every CHECKPOINT and show me the demo, and log decisions in DECISIONS.md and progress in PROGRESS.md. Start with Phase 0. Do each spike, record the results in VERIFY.md, and if anything contradicts the plan, propose the change to PLAN.md before continuing. Don't start Phase 1 until I approve CHECKPOINT 0.

### 6.4 Running each phase

After you approve a checkpoint, start the next phase with the built-in `/goal`, so Claude keeps going without per-turn prompting:

```
/goal Phase <N> in PLAN.md is complete: every Phase <N> checkbox is ticked with evidence shown, `node --test` exits 0, and you have stopped at CHECKPOINT <N> with the demo ready. Stop after 60 turns if not done and summarize what's left.
```

Phase 0 and Phase 3 onward involve live runs. Stay nearby for those, because Claude may ask you to watch or confirm something.

### 6.5 What to check at each checkpoint

- The demo in the checkpoint line actually works in front of you.
- `node --test` is green, and `git log` shows sensible commits.
- `DECISIONS.md`: do you agree with each choice Claude made?
- Anything in `VERIFY.md` marked Changed or Blocked.
- For CHECKPOINT 3 onward: read one gate report under `.autopilot/reports/` to confirm the feedback Claude gets is clear.

### 6.6 Daily use once it's built

```text
# once per machine
/plugin marketplace add ~/code/claude-autopilot
/plugin install autopilot@autopilot-local      # enter ntfy or Discord settings when prompted
autopilot install-cli                           # adds `autopilot` to your shell PATH

# per project
cd ~/code/my-app && claude
/autopilot:init          # config, logs, Playwright, statusline
/autopilot:plan          # talk it through; Claude writes PLAN.md
                         # read PLAN.md yourself and edit anything you disagree with
/exit
autopilot run            # starts tmux session ap-my-app and the loop
                         # Ctrl-b d to detach; go to bed

# when your phone buzzes
autopilot status                     # what happened
autopilot answer "Use Stripe test mode; no live keys"   # for a blocked question
tmux attach -t ap-my-app             # or look directly

# morning
autopilot status && git log --oneline autopilot/<plan>   # then skim PROGRESS.md and DECISIONS.md
```

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude Code behaviour differs from the docs this plan relies on | Phase 0 spikes every assumption before code depends on it. The plan gets updated. |
| The gate loops forever on an unfixable step | 3-attempt cap, no-progress counter, per-step time cap, Claude Code's own block cap |
| Claude games verification (weakens tests, ticks boxes) | Only the gate ticks. Protected files. Integrity check. An independent tester runs in a separate process. The reviewer checks the diff, test changes included (the tester prompt flags deleted or weakened assertions). |
| The session stalls on a prompt overnight | PermissionRequest auto-deny, `AskUserQuestion` deny, idle notification, watchdog nudge and relaunch |
| Usage burns through the week | Weekly pause threshold (85%). The tester runs on Sonnet. Security review only at phase ends and tagged steps. |
| Context bloat across a long run | Built-in auto-compaction. SessionStart re-injects the rules and the current step after each compaction. All state lives in files. |
| Something destructive happens | Dedicated LXC, non-root user, no production credentials, auto-mode classifier, hard-deny list, git on a branch with one commit per step |
| The dev server or tests are flaky | Infrastructure failures retry once without using up a step attempt. Flaky tests show up in reports, and fixing them becomes a follow-up step. |
| Plugin updates break a running project | Loads in place from the local repo. Change the plugin only between runs. Version tags. |

---

## 8. References

- Hooks reference: https://code.claude.com/docs/en/hooks
- Hooks guide (Stop-hook block cap, agent hooks): https://code.claude.com/docs/en/hooks-guide
- Plugins reference: https://code.claude.com/docs/en/plugins-reference
- Status line (rate_limits): https://code.claude.com/docs/en/statusline
- Waiting for a usage limit to reset: https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset
- Headless `claude -p`: https://code.claude.com/docs/en/headless
- Permission modes and auto mode: https://code.claude.com/docs/en/permission-modes
- `/goal`: https://code.claude.com/docs/en/goal
- Claude in Chrome (for supervised sessions): https://code.claude.com/docs/en/chrome
