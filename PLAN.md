# AutoClaude: build plan

**Owner:** Scott · **Drafted:** 2026-09-24 · **Revised:** 2026-09-26 (pure Windows, pause for review, shareable) · **Status:** Phase 0 complete (2026-09-27), waiting on CHECKPOINT 0. Findings: `VERIFY.md`.
**Builds:** a portable Claude Code plugin that runs a project's `PLAN.md` step by step, unattended, and verifies every step before moving on.
**Primary machines:** Windows, with no WSL: Scott's `Code` VM (Windows Server 2025) and Windows 11 desktops. Linux and macOS run the same code; nothing requires tmux or systemd.
**Repo:** `github.com/chaoticnewfie/autoclaude`. Decisions made after the draft: `docs/DECISIONS.md` (D17 onward). Rules for working in this repo: `CLAUDE.md`.

---

## 0. Instructions for Claude (read first)

You are building the tool this document describes. Scott will build it **with you, interactively, on the machine it will run on**. AutoClaude doesn't exist yet, so it can't run this plan by itself.

1. Read the whole document before you write any code.
2. Work **one phase at a time**. Each phase ends with a **CHECKPOINT**. Stop there, show Scott the demo it describes, and wait for his go-ahead.
3. **Phase 0 is verification.** Several design choices depend on how Claude Code behaves today. If a Phase 0 finding contradicts this plan, update the affected sections of this plan, log the change in `docs/DECISIONS.md`, and tell Scott before you continue.
4. Tick a step's checkbox (`- [x]`) only after its **Accept** lines are demonstrably true. Show the evidence: a command's output, a test run, or a screenshot.
5. The plugin's scripts use **only Node.js built-ins**: no npm dependencies, no bash, no jq, no PowerShell at runtime. Windows without WSL is the first target; Linux and macOS must keep working through the same code.
6. Keep `CONTINUE_HERE.md`, `docs/SESSION_LOG.md` and `docs/DECISIONS.md` up to date as you go, as `CLAUDE.md` requires.
7. This repo will be shared with other people and used on other machines. Nothing personal (homelab addresses, user-profile paths, Scott's machine names) goes into plugin code, templates, `README.md` or `docs/USAGE.md`.

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
| R13 | "Would it be possible to build this to work in pure windows? Windows server for this VM and often windows 11 as well." (2026-09-26) |
| R14 | "It may be used on other devices, and likely by other people by sharing the github so make sure you factor that into the build too." (2026-09-26) |
| R15 | "A way to pause the automated work so I could review the progress and give notes or changes along the way, but that is optional, only if I want to do it." (2026-09-26) |
| R16 | "I'd like a way to start using it with my existing projects", as well as using this repo as the starting point for new ones. (2026-09-26) |
| R17 | "If you're making a plan in plan mode, make it in a way decisions are made ahead of time as much as possible since we won't be able to answer while building. If the project was already started, recommend reviewing the plan to make sure it will work as well as possible with autoclaude now that it has been added to the project." (2026-09-27) |

### Requested since the draft

Everything Scott has asked for after 2026-09-24, with where it landed. Nothing is dropped, and nothing is built early unless he says so.

| Date | Request (his words, condensed) | Slotted into | Status |
|---|---|---|---|
| 2026-09-26 | Pure Windows, no WSL (R13) | D18, P0.8, P0.10, P1.6, P6.3, P6.4 | Planned |
| 2026-09-26 | Shareable with other people and devices (R14) | D20, P7.2 | Planned |
| 2026-09-26 | Optional pause to review and leave notes (R15) | D19, section 4.10, P5.6 | Planned |
| 2026-09-26 | Works with existing projects and as the starting point for new ones (R16) | D23, P2.1, P2.5 | Planned |
| 2026-09-26 | "Keep agents small means don't make 70... make sure that they are stopped when they aren't needed anymore" | `CLAUDE.md` rule 10 (a rule for building this, not a feature) | Done |
| 2026-09-27 | Plans made in plan mode must settle decisions ahead of time, since nobody answers during a run; an existing project gets a plan review once autoclaude is added (R17) | P2.1 (init message), P2.5 (template `CLAUDE.md`), P7.1 (plan skill) | Planned |

### How each requirement is met

| # | Met by |
|---|---|
| R1 | A self-contained Claude Code **plugin** in its own git repo with a local marketplace. Install it once per machine and switch it on per project with `/autoclaude:init`. Per-project differences live in `autoclaude.config.json`. |
| R2 | The `/autoclaude:plan` skill writes `PLAN.md` in the machine-readable step format. `autoclaude run` starts the unattended loop. |
| R3 | An interactive Claude Code session in its own console window, started and watched by a Node **supervisor** (D18), with the built-in auto-continue after usage limits. The supervisor recovers stalls and crashes by relaunching `claude --continue`. |
| R4 | The **Stop gate** (a Stop hook). After a step passes verification, it tells Claude to start the next step. |
| R5 | `AskUserQuestion` is blocked while AutoClaude runs. Claude settles open questions with the **decider** subagent against the plan's goals and constraints, and logs each one in `docs/DECISIONS.md`. |
| R6 | The **browser tester**: a separate headless `claude -p` run using Playwright MCP that checks the step's acceptance criteria. Committed Playwright specs run too. |
| R7 | The full test suite runs on every step as regression checks. A **bug bash** runs at the end of each phase. The **security reviewer** runs at phase ends and on steps tagged `security`. |
| R8 | The **usage gate**. A statusline bridge records the 5-hour and weekly usage percentages, and the gate reads them. |
| R9 | The gate itself runs the checks and ticks `PLAN.md`. After 3 failed attempts it **pauses**. It never skips a failing step. |
| R10 | Notifications (ntfy or Discord) go out only for the critical events listed in §4.6. Everything else is decided and logged. |
| R11 | The built-in auto-continue waits out 5-hour limits. The gate pauses and notifies at the weekly threshold. |
| R12 | `PLAN.md` stays a normal Markdown file. AutoClaude reads a light convention (§4.8.1) and still leaves room for prose. |
| R13 | Everything is Node built-ins. The runner is a Node supervisor in a console window, not tmux; the backstop is a Task Scheduler entry, not systemd. Process trees, paths and line endings are handled the Windows way first (P1.6). |
| R14 | No personal facts in the plugin, templates or user docs; per-machine values in plugin `userConfig`; docs written for a stranger; one `init` that works in any project (D20, D23). |
| R15 | `autoclaude pause` stops at the next clean point (or now), `autoclaude note` leaves notes, `resume` injects them. Optional automatic stops at phase ends or every step (§4.10). |
| R16 | `autoclaude init` writes only what is missing from `project-template/` into any folder, empty or not, and the plan skill writes a new plan or converts an existing one into the step format (D23, P2.5, P7.1). |
| R17 | The template `CLAUDE.md` carries a "planning for an unattended run" rule for any planner, plan mode included: settle stack, naming, scope and what-to-do-when-unsure up front, and write Accept lines a test or browser can check. `init` on a project that already has code or a plan ends by recommending a plan review, and `/autoclaude:plan` performs that review (P2.1, P2.5, P7.1). |

---

## 2. The goal

Scott spends an hour with Claude turning an idea into a solid `PLAN.md`, types `autoclaude run`, and walks away. Claude works through the plan step by step for as long as usage allows. Each step is proven with automated tests and a real headless browser before it's committed. Failures go back to Claude with evidence until fixed, and after three tries the run stops rather than building on something broken. Scott's phone buzzes only when something needs him. In the morning he reads a summary, a clean git history of one commit per verified step, and a log of every decision Claude made on his behalf.

### Success criteria (v1.0)

- **Install:** set up on a new project in under 10 minutes with `/plugin install` and `/autoclaude:init`.
- **Unattended:** completes a 12-step fixture plan with no human input, and each step produces exactly one commit.
- **Never advances on red:** in scenario tests, no step is ticked while any check or browser criterion fails.
- **Recovers on its own:** the fixture run survives a context compaction, a simulated API error, a killed `claude` process and a 5-hour usage reset.
- **Quiet:** the only notifications are those in §4.6. The dress rehearsal produces no false alarms.
- **Portable:** the same plugin repo works with every feature on Windows Server 2025 and Windows 11 without WSL, and on Linux and macOS.
- **Reviewable:** `autoclaude pause` stops at the next verified commit, notes left while paused reach Claude on resume, and a run with `review.pauseAt: phase-end` stops at every phase end and continues on `resume`.
- **Shareable:** a stranger can install and run it on a fresh Windows machine from `README.md` and `docs/USAGE.md` alone, and nothing in the plugin, templates or user docs refers to Scott's machines.

### Non-goals for v1

- Running several plan steps in parallel (worktrees or agent teams). This is a later idea.
- Deploying to production or pushing to remotes by default.
- Working without a Claude Pro/Max subscription. Usage percentages and auto-continue need one.
- A GUI or dashboard. The statusline, `autoclaude status` and notifications are enough for v1.

---

## 3. Decisions

| ID | Decision | Why | Rejected alternatives |
|---|---|---|---|
| D1 | **Use Claude Code only.** Grok isn't needed. | Hooks, subagents, headless runs and usage data are all native. One subscription and one quota. | Grok Bot agents. They run on their own cloud VM and don't integrate with a local Claude Code session. |
| D2 | **Package as a Claude Code plugin** (`autoclaude`) in its own git repo, with a **local-directory marketplace**. | One install per machine, and the plugin can be switched on or off per project. Loads in place, so edits apply on `/reload-plugins` without version bumps. Versioned in git. | Copying `.claude/` folders between projects, which drift apart. A global `~/.claude` setup, which affects every project. |
| D3 | **Run the build loop as an interactive session under a Node supervisor in its own console window**, not as a `claude -p` loop and not in tmux (revised 2026-09-26, D18). | Only interactive sessions automatically wait out the 5-hour limit and then carry on, and only they give the statusline the usage percentages. A supervisor built from Node built-ins can spawn, end and relaunch `claude --continue "<prompt>"` on every OS, which replaces the tmux nudge. Scott watches by looking at the window or running `autoclaude status`. | tmux (Linux only; console scraping for state). An external driver calling `claude -p` per step (no auto-wait, no usage data). node-pty (a native dependency). Claude Code's own background sessions (`claude --bg`, D26): Stop hooks do not run in them and usage limits are not auto-continued there, and the gate is a Stop hook. |
| D4 | **The gate is a deterministic Node Stop hook.** Claude signals "ready" and the gate verifies. | The builder can't skip tests or grade its own work. Only the gate ticks `PLAN.md` and commits. | `/goal` (its evaluator only reads the conversation and can't run tests). Agent-type hooks (experimental, 60 s default timeout). |
| D5 | **Browser testing runs in a separate headless `claude -p` process with Playwright MCP**, plus committed Playwright specs. | Needs no visible browser or logins, so it works on an unattended machine overnight. A separate process gives a fresh context and an independent verdict. Specs build a growing regression suite. | Claude in Chrome: needs a visible Chrome and pauses at logins. Fine for supervised sessions only. |
| D6 | **Failure policy: 3 attempts per step, then pause and notify.** Never advance past a failing step. | Directly satisfies R9. | Skipping failed steps and continuing with independent ones. This becomes a later option (`depends:`), off by default. |
| D7 | **Claude answers its own questions, and stops only for critical ones.** | Satisfies R5 and R10. Every decision is auditable in `docs/DECISIONS.md`. | Waiting on `AskUserQuestion`, which would stall the run for hours. |
| D8 | **Usage handling:** the built-in auto-continue covers 5-hour limits. The gate pauses at a weekly threshold (default 85%). The supervisor is the fallback. | Satisfies R11 using built-in behaviour where possible. Keeping 15% of the week in reserve leaves Scott quota for daytime use. | Custom sleeping and retry logic for every limit. |
| D9 | **Permissions:** auto mode, a PermissionRequest hook that **denies** anything that would prompt (so the session never waits), a guard hook with a hard-deny list, and a dedicated machine or VM with no production credentials. | An unattended session must never block on a prompt. Auto mode falls back to prompting after 3 consecutive or 20 total classifier blocks, and the hook catches that. A dedicated VM (Scott's `Code` VM) limits the blast radius; a standard user account rather than Administrator is recommended and documented. | `bypassPermissions`: simpler, but loses the classifier's protection. Kept as a documented fallback if Phase 0 shows the hook approach is unreliable. |
| D10 | **Notifications through ntfy**, self-hosted on Proxmox or ntfy.sh, **or a Discord webhook**. Both are configured per machine as plugin `userConfig`. | Deterministic, free, and works from the phone. Secrets stay out of project repos. | Relying on Claude app push notifications or Remote Control (see D14). |
| D11 | **All scripts are Node.js built-ins only.** | Cross-platform (Windows first, then Linux and macOS), nothing to install, and the same runtime as the projects. | Bash plus jq, which breaks on Windows. PowerShell, which is absent on Linux and macOS. |
| D12 | **Git: work on branch `autoclaude/<plan-slug>`, one commit per verified step, a tag at each phase end, never push by default.** | Easy review and rollback. Morning review is a `git log`. | Committing directly to main. Auto-pushing. |
| D13 | **Security review at phase ends and on steps tagged `security`.** High-severity findings count as a failed attempt. Lower severities go to `docs/SECURITY-FINDINGS.md`. | Catches issues without spending quota on every step. | Reviewing every step (too costly). Never reviewing. |
| D14 | **Remote Control stays disconnected during unattended runs** (to be verified in P0.7). | The docs say auto-continue doesn't start on its own in Remote Control sessions. Scott can still look at the console window, or connect Remote Control briefly to answer a blocker. | Leaving Remote Control connected all night. |
| D15 | **All state lives in files** (`PLAN.md`, `.autoclaude/state.json`, `PROGRESS.md`, git). | Any crash, restart or compaction can resume exactly where it left off. | Keeping state in memory or in the conversation. |
| D16 | **Default models:** the builder uses the session model. The tester uses the `sonnet` alias and the security reviewer the `opus` alias; Claude Code resolves aliases to the current model of each tier (D22). All three can be changed in config. | Balances quality against quota. The tester runs often, so it gets the cheaper tier. Aliases follow model releases with no code change. | Pinning dated model ids. The top tier everywhere, which burns quota. |
| D17 to D25 | Decisions made after the draft: naming, the supervisor, pause for review, shareability, conventions, models, one `init`, doc paths, `CONTINUE_HERE.md`. | See `docs/DECISIONS.md`. | |

---

## 4. Architecture

### 4.1 Overview

```
 Scott ──(plans with Claude)──► PLAN.md + autoclaude.config.json
                                        │
                        autoclaude run   ▼
┌────────── console window ac-<project>: autoclaude supervisor (Node, D18) ─────────┐
│  spawns and watches ▼                                                              │
│  claude --permission-mode auto   (interactive builder session)                     │
│     │  works on step Sx.y …  runs `autoclaude ready Sx.y` … tries to stop          │
│     ▼                                                                              │
│  STOP GATE (Stop hook, Node)                                                       │
│   1 integrity + progress checks                                                    │
│   2 deterministic checks: lint / typecheck / unit / e2e (dev server up)            │
│   3 browser tester: claude -p + Playwright MCP (headless) → verdict                │
│   4 security reviewer (phase end / tag:security) → verdict                         │
│   5 usage gate (weekly threshold), review pause (requested or scheduled, §4.10)    │
│     ├─ FAIL → block stop, send evidence back to Claude (≤3 attempts)               │
│     ├─ PASS → tick PLAN.md, commit, block stop with "start next step"              │
│     └─ PAUSE/COMPLETE → allow stop + notify                                        │
│                                                                                    │
│  SUPERVISOR loop, every 60 s: heartbeat age, idle marker, failure.json, usage.json │
│   working → nothing │ usage-limit wait → nothing │ idle and stale, or exited →     │
│   end the child, relaunch `claude --continue "/autoclaude:resume"` │               │
│   2 relaunches with no progress → pause(stuck) + notify                            │
└────────────────────────────────────────────────────────────────────────────────────┘
   ▲ statusline bridge writes usage.json      ▲ heartbeat on every tool call
 BACKSTOP: `autoclaude watchdog` on a scheduled task every 5 min (Task Scheduler,
   cron or systemd timer): relaunches a dead supervisor for any registered running project
 NOTIFY: ntfy or Discord → Scott's phone (critical events only)
```

### 4.2 Components

| Component | Kind | Job |
|---|---|---|
| `autoclaude` CLI (`bin/autoclaude.js`) | Node CLI, reached through a shim in a per-user bin directory (`%LOCALAPPDATA%\autoclaude\bin` on Windows, `~/.local/bin` elsewhere) | `init`, `run`, `supervise`, `start`, `ready`, `blocked`, `answer`, `status`, `pause`, `note`, `resume`, `lint-plan`, `usage`, `watchdog`, `notify-test`, `install-cli` |
| Session context | `SessionStart` hook (startup, resume, clear, compact) | While running, injects AutoClaude rules, the current step's full text and the tail of `PROGRESS.md`. This re-grounds Claude after every compaction. |
| Stop gate | `Stop` hook | The core loop (§4.4) |
| Tool guard | `PreToolUse` hook | While running: denies `AskUserQuestion` and points Claude to the decider. Blocks edits to `PLAN.md`, `.autoclaude/**` and `autoclaude.config.json`. Hard-denies force pushes, `git reset --hard` on protected branches, and `rm -rf` outside the project. |
| Permission auto-deny | `PermissionRequest` hook | While running: denies anything that would prompt, with guidance ("no human is available; pick another approach or run `autoclaude blocked`"). Logs the denial. |
| Heartbeat | `PostToolUse` hook (async) | Touches `.autoclaude/heartbeat` and counts tool calls, which gives the gate and the supervisor a progress signal. |
| Failure handler | `StopFailure` hook | Logs API-error turn endings. Rate limits are left to auto-continue. For other errors it writes `failure.json`, which the supervisor acts on within a minute. |
| Idle detector | `Notification` hook (`idle_prompt`, `permission_prompt`, `agent_needs_input`) | While running, any of these means the session is waiting on a human, which is critical. Notify, and touch the `idle` marker the supervisor reads. |
| Session end | `SessionEnd` hook | Records how the session ended. If AutoClaude was still running, flags it for the supervisor. |
| Statusline bridge | Script at `~/.claude/autoclaude/statusline.js`, registered in user settings | Writes `usage.json`. Shows `AC S2.3 ▸ running │ 5h 42% │ 7d 18%`. Chains any existing statusline. Fallback source when no statusline has run yet: `~/.claude.json` -> `cachedUsageUtilization` (read-only, D27). |
| Decider | Plugin subagent `autoclaude:decider` | Answers Claude's open questions against the plan's goals and constraints. Classifies each as routine or critical. |
| Browser tester | Prompt plus headless `claude -p` run (Sonnet) | Checks acceptance criteria in a real browser and returns a JSON verdict. |
| Security reviewer | Prompt plus headless `claude -p` run (Opus) | Reviews the diff since the last phase tag and returns a JSON verdict. |
| Supervisor | `autoclaude supervise`, started by `autoclaude run` in its own console window | Spawns the interactive `claude` session with inherited stdio and polls every 60 s. Recovers stalls and crashes by ending the child and relaunching `claude --continue "/autoclaude:resume"`. Resumes after a weekly reset if enabled. Writes `supervisor.pid`. |
| Backstop watchdog | `autoclaude watchdog` on a scheduled task (Windows Task Scheduler; cron or a systemd user timer elsewhere), every 5 minutes | For every registered project whose state is running, relaunches the supervisor if its pid is dead. Nothing else. |
| Review notes | `autoclaude note` and `/autoclaude:note` | Appends a dated entry to `docs/REVIEW_NOTES.md` and marks it pending in state. Pending notes are injected on resume (§4.10). |
| Notifier | `lib/notify.js` | ntfy / Discord / stdout |
| Planner | `/autoclaude:plan` skill | Interviews Scott and writes `PLAN.md` in the step format |

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
                  │  ├─ `autoclaude pause --now`  ──► paused(review)
                  │  ├─ pause requested, or review.pauseAt reached, after a verified commit ──► paused(review)
                  │  └─ supervisor: 2 relaunches, no progress ──► paused(stuck)
                  └─ last step passes            ──► complete
paused ──`autoclaude resume` / `answer` / supervisor (weekly reset, if enabled)──► running
```

When the state isn't `running`, **every hook exits straight away**, so normal interactive work in the project behaves exactly as it did without the plugin.

### 4.4 Stop gate algorithm

```
on Stop(input):
  if env.AUTOCLAUDE_ROLE is set            → allow        # nested tester/reviewer runs
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
      block("Continue {step}. When all Accept lines hold, run `autoclaude ready {step}`.
             If you truly can't proceed, run `autoclaude blocked {step} \"<reason>\"`.")

  # verify
  ensure dev server healthy (start it if needed)
  results = run checks in order (stop at first failure)
  if all pass and step not tagged no-ui   → results += browser tester(step)
  if phase end or step tagged security    → results += security review(diff)
  if phase end                            → results += bug bash(phase)

  if any failure:
      attempts[step]++ ; write full report to .autoclaude/reports/{step}-{n}.md
      if attempts[step] ≥ maxAttempts:
          mark step [!] ; state → paused(step-failed) ; notify(CRITICAL) ; allow
      block("{step} attempt {n}/{max} failed:\n{≤4k-char summary}\nFull report: {path}\nFix the causes, then run `autoclaude ready {step}` again.")

  # pass
  tick step [x] ; append PROGRESS.md ; git commit "autoclaude({step}): {title}"
  if phase end: git tag ac-{phase}
  if usage.weekly ≥ weeklyPauseAt:
      state → paused(weekly-limit) ; notify ; allow
  next = next unchecked step
  if none: state → complete ; stop dev server ; notify(summary) ; allow
  if state.pauseRequested or review.pauseAt == every-step or (phase end and review.pauseAt == phase-end):
      state.currentStep = next ; state → paused(review) ; stop dev server
      notify(DEFAULT, "paused for review after {step}; next is {next.id}; resume with `autoclaude resume`") ; allow
  state.currentStep = next ; reset counters
  block("{step} verified and committed. Next: {next.id} {next.title}\n{next full text}")
```

Notes for the implementation:
- **Don't** exit early on `stop_hook_active`. The loop is supposed to keep continuing. Phase 0 showed that tool use resets Claude Code's cap of 8 consecutive blocks (10 blocks with tool calls were honored, 8 without), so the gate's own no-progress counter (3) is the real guard and `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` stays unset. The top-level `{"decision":"block","reason":"..."}` output is what 2.1.283 honors.
- Keep the `reason` text short: hook output over 10,000 characters gets truncated to a file preview. Always write the full detail to a report file and give its path.
- Set the Stop hook `timeout` from config (default 1800 s) so the e2e suite, the tester and the reviewer can finish.

### 4.5 How Claude handles questions (R5)

While running, Claude follows this policy, injected through SessionStart:
1. Check whether the answer is already in `PLAN.md` (goals, constraints, decisions) or `docs/DECISIONS.md`. If it is, use it.
2. If not, ask the **decider** subagent. It returns a recommendation, the reasoning, and a `routine` or `critical` classification.
3. **Routine:** apply the recommendation, append it to `docs/DECISIONS.md` (`D-###`, step, question, choice, why, how to reverse it), and continue.
4. **Critical:** run `autoclaude blocked <step> "<question with options>"` and stop.

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
| Claude blocked on a critical question | High | The question and its options, plus how to answer (`autoclaude answer "…"`) |
| Session waiting for input (idle or permission prompt) | High | Project and console window title |
| Supervisor couldn't recover (2 relaunches with no progress, or `claude` failed to start) | High | What it tried |
| High-severity security finding still unresolved after 3 attempts | High | Finding summary |
| Weekly usage threshold reached | Default | Usage %, reset time, whether it will auto-resume |
| Paused for review (requested, or scheduled by `review.pauseAt`) | Default | Last verified step, next step, the resume command |
| Plan complete | Default | Summary: steps, commits, decisions, duration |
| Morning summary (optional, at a set time) | Low | Progress overnight |

Nothing else sends a notification: routine decisions, retries that later pass, 5-hour limit waits, compactions and successful supervisor relaunches only go to the logs.

### 4.7 Safety

- The machine that runs unattended holds no production credentials, SSH keys to other hosts, or cloud admin tokens. On Windows, a standard user account rather than Administrator where possible; on Linux, a non-root user. A dedicated VM is the blast radius.
- Windows: the run lives in a console window inside the interactive session. An RDP **disconnect** keeps it alive; a **log-off**, a reboot or sleep ends it. `docs/USAGE.md` documents the disconnected-session time limit and the power settings to check.
- Auto mode classifier, plus the guard hook's hard-deny list, plus the PermissionRequest auto-deny.
- Git: AutoClaude branch only, a clean tree is required to start, no pushes by default, and every step is a separate commit (rollback is `git reset` to a tag).
- `PLAN.md`, `.autoclaude/**` and `autoclaude.config.json` can't be edited by Claude while running. The gate also checks the integrity of `PLAN.md` on every stop.
- Nested `claude -p` runs (tester and reviewer) use `--settings '{"disableAllHooks":true}'`, `AUTOCLAUDE_ROLE=…`, `--permission-mode dontAsk` and a narrow `--allowedTools` list (browser tools plus read-only file tools for the tester, read-only tools for the reviewer).

### 4.8 Contracts

#### 4.8.1 `PLAN.md` step format

A plan is normal Markdown. AutoClaude only reads **step lines** and their indented fields. Everything else (goal, constraints, notes) is context for Claude and the decider.

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
- An ID is `S<phase>.<n>`, unique within the plan (any letters before the digits are accepted, so this repo's own `P0.1` style works). A phase is a `## Phase N: …` heading; `###` and `####` are accepted too, because real plans nest phases under a numbered section. Anything inside a fenced code block is ignored, so a plan can show examples.
- `Accept:` lines are required (at least one) and must be observable in a browser, a test or a command.
- Optional fields: `Test:` (spec files to create or extend), `Tags:` (`ui`, `no-ui`, `security`, `db`, …), `Depends:` (reserved for a later version).
- `autoclaude lint-plan` enforces these rules. `start` refuses to run a plan that fails lint.
- Step size: aim for 20–90 minutes of work. The planner splits anything bigger.

#### 4.8.2 `autoclaude.config.json` (committed, one per project)

```json
{
  "version": 1,
  "plan": "PLAN.md",
  "branch": "autoclaude/{planSlug}",
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
  "notify":   { "morningSummaryAt": null },
  "review":   { "pauseAt": "never" },
  "docs":     { "progress": "PROGRESS.md", "continueHere": "CONTINUE_HERE.md", "decisions": "docs/DECISIONS.md",
                "blockers": "docs/BLOCKERS.md", "security": "docs/SECURITY-FINDINGS.md",
                "reviewNotes": "docs/REVIEW_NOTES.md", "sessionLog": "docs/SESSION_LOG.md" }
}
```

`review.pauseAt` is `never`, `phase-end` or `every-step` (§4.10). The `docs` paths follow Scott's repo convention (D24) and can be changed per project.

Secrets such as the ntfy URL and token and the Discord webhook **never** go in this file. They're plugin `userConfig` values (sensitive ones are stored in the machine's keychain or credentials file) and reach hooks as `CLAUDE_PLUGIN_OPTION_*` environment variables.

#### 4.8.3 Runtime files (`.autoclaude/`, gitignored)

- `state.json`: `{ status, pauseReason, pauseRequested, pendingNotes[], currentStep, attempts{}, noProgress, recoveries, toolCallsAtLastGate, headAtLastGate, stepStartedAt, startedAt, windowTitle, supervisorPid, sessionId, tickedByGate[] }`
- `ready.json` and `blocked.json`: written by the CLI, consumed by the gate
- `heartbeat`: mtime plus tool-call counter
- `idle` (mtime) and `failure.json`: written by the Notification and StopFailure hooks, read by the supervisor
- `supervisor.pid`: the live supervisor, checked by the backstop watchdog
- `reports/<step>-<attempt>.md`: full check output, tester verdict and screenshots
- `logs/gate.log`, `logs/denials.log`, `logs/supervisor.log`, `logs/watchdog.log`

Per machine, under `~/.claude/autoclaude/` (`%USERPROFILE%\.claude\autoclaude\` on Windows): `usage.json` (written by the statusline bridge) and `registry.json` (projects the backstop watchdog checks).

Committed per project (paths from `docs` in the config, D24): `PROGRESS.md` (the gate appends one line per verified step), `CONTINUE_HERE.md` (Claude rewrites it before each `ready`, D25), `docs/DECISIONS.md` (Claude appends), `docs/BLOCKERS.md`, `docs/SECURITY-FINDINGS.md`, `docs/REVIEW_NOTES.md` (Scott's notes while paused), `docs/SESSION_LOG.md`.

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
autoclaude/
├── .claude-plugin/marketplace.json        # local marketplace "autoclaude-local"
├── plugins/autoclaude/
│   ├── .claude-plugin/plugin.json         # name, version, userConfig (ntfy_url, ntfy_token*, discord_webhook*)
│   ├── hooks/hooks.json                   # exec form only: {"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/x.js"]} (D29)
│   ├── scripts/                           # one file per hook
│   │   session-context.js  stop-gate.js  tool-guard.js  permission-deny.js
│   │   heartbeat.js  stop-failure.js  notify-idle.js  session-end.js
│   ├── lib/                               # plan, state, config, checks, devserver, tester, security,
│   │                                      # usage, git, notify, report, supervisor, proc (spawn and
│   │                                      # kill per OS), paths, fsatomic
│   ├── bin/autoclaude.js                  # CLI (Node). install-cli writes a .cmd or sh shim for it
│   ├── skills/{plan,init,start,status,pause,note,resume,answer}/SKILL.md
│   ├── agents/decider.md
│   ├── prompts/{context,tester,security,bugbash}.md
│   └── templates/{autoclaude.config.json, PLAN.template.md, playwright.config.ts,
│                  mcp.playwright.json, statusline-bridge.js,
│                  watchdog/{windows-task.xml, crontab.txt, systemd.service, systemd.timer}}
├── project-template/                      # what `autoclaude init` writes into a project (D23)
│   CLAUDE.md  PLAN.md  CONTINUE_HERE.md  PROGRESS.md  .gitattributes  .editorconfig  .gitignore
│   docs/{DECISIONS,SESSION_LOG,DEFERRED,BLOCKERS,SECURITY-FINDINGS,REVIEW_NOTES}.md
├── test/
│   ├── unit/*.test.js                     # node --test
│   ├── scenarios/*.test.js                # feed fake hook JSON to scripts
│   └── fixtures/{todo-app, plans/}
├── spikes/                                # Phase 0 throwaway experiments
├── docs/{USAGE,DECISIONS,SESSION_LOG,DEFERRED,CONVENTIONS_SURVEY}.md
├── PLAN.md  CLAUDE.md  CONTINUE_HERE.md  VERIFY.md  LICENSE (once Scott picks one)
└── README.md
```

### 4.10 Pause for review (R15, D19)

- `autoclaude pause` (or `/autoclaude:pause` in the session) sets `pauseRequested`. The gate pauses **after the next verified commit**, so the tree is clean when Scott looks. `autoclaude pause --now` sets `paused(review)` immediately; the current step stays `[ ]` and keeps its attempt count.
- `review.pauseAt` in the config does the same automatically: `phase-end` after the last step of every phase, `every-step` after each step. Default `never`.
- While paused Scott reads `PROGRESS.md`, `docs/DECISIONS.md` and `git log`, edits `PLAN.md` freely (the gate re-lints it on resume and refuses to resume on a lint error), and leaves notes: `autoclaude note "<text>"` appends a dated entry to `docs/REVIEW_NOTES.md` and adds it to `pendingNotes`.
- `autoclaude resume` (or `/autoclaude:resume`) clears `pauseRequested`, sets running, and the next SessionStart context injection carries every pending note under "Owner review notes: act on these first". Claude records what it did with each note in `docs/DECISIONS.md` as `N-###`, and the note leaves `pendingNotes`.
- Where the run continues after a pause (D33): the step in `state.currentStep`, with its attempt count kept. If the owner unticked a verified step while paused, the gate re-baselines on resume: that step leaves `tickedByGate` and becomes current if it is now the first unfinished step. If the current step was removed from the plan, the first unfinished step becomes current. The owner never edits `state.json`.
- Every pause sends a default-priority notification with the last verified step, the next step and the resume command. The dev server is stopped on pause.

---

## 5. The plan

### Phase 0: Verify how Claude Code behaves today
*Each spike goes in `spikes/` (throwaway) and its result goes in `VERIFY.md`.* Findings so far, including why `claude --bg` was rejected as the runner: `VERIFY.md` (2026-09-26).

- [x] **P0.1** Record the environment (VERIFY.md, 2026-09-26)
  - Accept: `VERIFY.md` lists the OS and build, PowerShell version, Node version, `claude --version` of the native install (at least v2.1.260, otherwise update; the VS Code bundled binary does not count), plan type, git version, and whether `node`, `git` and `claude` resolve on the machine PATH (hooks need `node` there)
- [x] **P0.2** Spike the Stop-hook continue loop (VERIFY.md: 3 and 10 blocks honored with tool use; 8 without; 300 s hook not killed)
  - Accept: a minimal Node Stop hook that returns `{"decision":"block","reason":…}` makes Claude continue with that reason, 3 times in a row, each with tool use in between
  - Accept: documented: the value of `stop_hook_active` on each call, whether tool use resets the 8-block cap, and whether `last_assistant_message` is present
  - Accept: a Stop hook with `"timeout": 1200` that sleeps 300 s isn't killed
- [x] **P0.3** Spike the statusline bridge (VERIFY.md: `rate_limits` present 4 s after start, right after the first API response, and updated during the run)
  - Accept: a statusline script receives `rate_limits.five_hour` and `rate_limits.seven_day` (used_percentage and resets_at) and writes them to a file. Documented how soon after startup they appear.
- [x] **P0.4** Spike a nested headless run from a hook (VERIFY.md: works with `--settings '{"disableAllHooks":true}'`; `--bare` rejected, D30)
  - Accept: a Stop hook spawns `claude -p` with `--settings '{"disableAllHooks":true}' --output-format json --json-schema … --model sonnet` and parses `structured_output`
  - Accept: documented whether nested-session detection (`CLAUDECODE` env var) interferes, and the workaround (for example, stripping it from the child env)
  - Accept: the nested run uses Scott's subscription login, not an API key
- [x] **P0.5** Spike headless browser testing (VERIFY.md: `cmd /c npx` MCP config on Windows; no `--with-deps`)
  - Accept: `npx playwright install chromium` succeeds on this machine (Windows needs no `--with-deps`; Linux does, and it is documented)
  - Accept: `claude -p` with Playwright MCP (`npx @playwright/mcp@latest --headless`, passed through `--mcp-config` and `--strict-mcp-config`) opens a local page, clicks a button and reports the resulting text
- [x] **P0.6** Spike the unattended permission behaviour (VERIFY.md: PermissionRequest deny and the `AskUserQuestion` deny both reach Claude with the guidance text; no prompt appears)
  - Accept: a `PermissionRequest` hook returning `decision.behavior: "deny"` with a message makes Claude carry on without a prompt appearing
  - Accept: a `PreToolUse` deny on `AskUserQuestion` returns the guidance text to Claude
  - Accept: documented what happens after repeated auto-mode classifier blocks (does the PermissionRequest hook catch the fallback prompts?)
- [ ] **P0.7** Confirm the usage-limit behaviour
  - Accept: `autoContinueAtUsageLimit` is on (check with `/config`)
  - Accept: documented from the current docs: auto-continue conditions, the "re-arms at most twice in a row" rule, the weekly exception (over 24 h), and whether a connected Remote Control session disables auto-continue (D14)
- [x] **P0.8** Spike the supervisor (replaces the tmux spike, D18). VERIFY.md: every line verified, including the RDP disconnect and reconnect on 2026-09-27
  - Accept: a Node script using only built-ins opens a new console window titled `ac-spike` running `claude` interactively, and that window survives the launching terminal being closed
  - Accept: the same script sees the child exit, relaunches `claude --continue "<prompt>"`, and the prompt is submitted and answered in the new window
  - Accept: ending the child from the script kills the whole process tree (`taskkill /T /F` on Windows, the process group elsewhere), leaving no orphan `node` or `claude`
  - Accept: the window survives an RDP disconnect and reconnect; documented what happens on log-off and on sleep
  - Accept: documented whether the `idle_prompt` Notification hook and the `StopFailure` hook fire in that window, and what `rate_limit` looks like in the StopFailure input while auto-continue is waiting
- [x] **P0.10** Spike plugin hooks on Windows (VERIFY.md: exec form, `${CLAUDE_PLUGIN_ROOT}`, spaces, EPERM retry)
  - Accept: a local-marketplace plugin whose `hooks.json` runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.js"` fires on Windows, with `${CLAUDE_PLUGIN_ROOT}` expanded and the stdin JSON readable
  - Accept: documented which shell runs hook commands on Windows, whether `node` resolves there, and how a plugin path with spaces behaves
  - Accept: `fs.renameSync` over a file another process holds open is tried, and the retry strategy for `EPERM` and `EBUSY` is documented
- [x] **P0.9** Reconcile (VERIFY.md has a row per step; every change is in this plan and in `docs/DECISIONS.md` D26 to D31)
  - Accept: `VERIFY.md` has a Pass/Changed/Blocked row for every Phase 0 step
  - Accept: every "Changed" row is reflected in this plan and in `docs/DECISIONS.md`

**CHECKPOINT 0:** Walk Scott through `VERIFY.md` and any changes to the plan.

### Phase 1: Plugin skeleton and core libraries

- [x] **P1.1** Repo, local marketplace and an installable empty plugin (2026-09-27: `claude plugin marketplace add C:\AutoClaude`, `claude plugin install autoclaude@autoclaude-local`, loads in place; `/autoclaude:status` prints the not-initialized line; `validate --strict` passes)
  - Accept: `/plugin marketplace add <path to this repo>` then `/plugin install autoclaude@autoclaude-local` succeeds
  - Accept: `/autoclaude:status` prints "autoclaude: not initialized in this project"
  - Accept: `claude plugin validate plugins/autoclaude --strict` passes
- [x] **P1.2** `lib/plan.js`: parse, find the next step, set a marker, lint (2026-09-27: `test/unit/plan.test.js`, 7 tests incl. CRLF, BOM, mixed endings, fenced code blocks, and this plan itself)
  - Accept: unit tests cover the step format in §4.8.1, prose between steps, nested bullets, CRLF files, duplicate IDs, missing Accept lines and unknown markers
  - Accept: writes change only the marker characters and leave everything else byte-for-byte identical
- [x] **P1.3** `lib/state.js`, `lib/config.js`, `lib/fsatomic.js` (2026-09-27: crash-before-rename and locked-file retry tests pass; config validation reports paths)
  - Accept: state writes are atomic (temp file then rename) and survive a simulated crash mid-write
  - Accept: config merges defaults, validates types and gives clear errors, with no dependencies
- [x] **P1.4** CLI skeleton `bin/autoclaude.js` with `status`, `pause`, `note`, `resume`, `lint-plan`, `usage`, `install-cli` (2026-09-27: `test/unit/cli.test.js`; `install-cli` wrote `%LOCALAPPDATA%\autoclaude\bin\autoclaude.cmd` and added it to the user PATH on the Code VM)
  - Accept: `autoclaude install-cli` writes a shim into a per-user bin directory (`%LOCALAPPDATA%\autoclaude\bin\autoclaude.cmd` on Windows, `~/.local/bin/autoclaude` elsewhere), adds that directory to the user PATH without admin rights (Windows: `HKCU\Environment`), and prints what to reopen
  - Accept: `autoclaude status` shows state, current step, attempts, usage and last progress time
- [x] **P1.5** `lib/notify.js` and `userConfig` (2026-09-27: two Discord test messages reached Scott, one through the userConfig environment path and one through the per-machine `notify.json` written by `autoclaude notify-setup`, D32; stdout fallback and log covered by tests)
  - Accept: `plugin.json` declares `ntfy_url`, `ntfy_token` (sensitive), `discord_webhook` (sensitive) and `notify_channel`
  - Accept: `autoclaude notify-test` delivers a message to Scott's phone through the configured channel
  - Accept: with no channel configured, it falls back to stdout plus `logs/notify.log`
- [x] **P1.6** `lib/proc.js` and `lib/paths.js` (2026-09-27: `test/unit/proc.test.js`; the Windows console-window launcher is the one proven in the P0.8 spike; the tmux and background branches are untested until a Linux or macOS machine runs them)
  - Accept: spawns with quoted arguments through `cmd.exe /d /s /c` on Windows and `/bin/sh -c` elsewhere; kills a process tree on both; opens a detached console window on Windows (`start`), a tmux session or a background process elsewhere
  - Accept: every per-machine path (`~/.claude/autoclaude/`, the bin directory) resolves from `os.homedir()` and `LOCALAPPDATA`, with unit tests covering both OS branches

**CHECKPOINT 1:** Demo the install, `status` and a test notification on Scott's phone. `node --test` passes.

### Phase 2: Project init and context injection

- [x] **P2.1** `/autoclaude:init` skill and `autoclaude init` (2026-09-27: `test/unit/init.test.js`; live on a copy of the fixture app: config with detected lint, unit, e2e and the dev server, 14 template files, `.gitignore`, MCP config, registry, statusline; second run kept every file)
  - Accept: in a fresh project it detects `package.json` scripts and writes `autoclaude.config.json` with the detected commands (asking Scott to confirm anything it's unsure of)
  - Accept: it writes every missing file from `project-template/` (`CLAUDE.md`, `PLAN.md`, `CONTINUE_HERE.md`, `PROGRESS.md`, the `docs/` set, `.gitattributes`, `.editorconfig`), never touches a file that exists, reports what it skipped, and adds `.autoclaude/` to `.gitignore`
  - Accept: it offers to add Playwright (config plus one smoke spec) if missing, and writes the tester's MCP config into `.autoclaude/mcp.playwright.json` (on Windows `{"command":"cmd","args":["/c","npx","-y","@playwright/mcp@latest","--headless"]}`, elsewhere `npx` directly; P0.5)
  - Accept: it checks that `node` resolves on the machine PATH and that `claude` is the native install, and says what to fix if not (D29)
  - Accept: in a project that already has code or a plan, `init` ends by recommending a review of the plan against the step format and the decide-ahead rule (R17), and names `/autoclaude:plan` as the way to do it
  - Accept: running it again is safe (idempotent) and never overwrites a filled-in config or plan
- [x] **P2.2** Statusline bridge (2026-09-27: `init` installed `~/.claude/autoclaude/statusline.js` with a settings backup; a live session in the fixture copy showed `AC S1.1 > running | 5h 44% | 7d 11%` and wrote `usage.json`; chaining an existing status line is covered by `test/unit/statusline.test.js`, since this machine had none)
  - Accept: `init` installs `~/.claude/autoclaude/statusline.js` and registers it in `~/.claude/settings.json`, chaining any existing `statusLine` command and leaving its output intact
  - Accept: `usage.json` updates while a session runs. The statusline shows `AC <step> ▸ <status> │ 5h N% │ 7d N%` while running, and just the chained output otherwise.
- [x] **P2.3** Context injection (2026-09-27: `hooks/hooks.json` SessionStart exec-form hook; scenario tests for silent-when-idle and full injection; live: a headless session in a running fixture project answered with the current step and the owner note; `startup` and `resume` sources seen live, `compact` is demonstrated at CHECKPOINT 2)
  - Accept: while running, starting, resuming, `/clear` or `/compact` injects `prompts/context.md` (including the rule to rewrite `CONTINUE_HERE.md` before `ready`, D25), the current step's full text, the last 10 `PROGRESS.md` lines, and any pending review notes (§4.10)
  - Accept: when not running, nothing is injected
- [x] **P2.4** Machine registry (2026-09-27: `lib/registry.js`, `init` registers, `status --all` lists; live on the Code VM)
  - Accept: `init` adds the project to `~/.claude/autoclaude/registry.json`, and `autoclaude status --all` lists every registered project
- [x] **P2.5** Project template (2026-09-27: `project-template/` with 13 files; the template plan lints as "no steps" so a run cannot start on placeholders; the R17 section is in its `CLAUDE.md`; `init` on the fixture copy added only the missing files)
  - Accept: `project-template/CLAUDE.md` carries the conventions in `docs/CONVENTIONS_SURVEY.md` section 2 (all except 10, with 15 as reworded in this repo's `CLAUDE.md`) with fill-in slots for the stack and the definition-of-done commands; `PLAN.md` is the step-format skeleton with the requested-features table; each `docs/` file opens with a one-paragraph statement of its purpose
  - Accept: `project-template/CLAUDE.md` has a "planning for an unattended run" section (R17): decisions are made in the plan, not during the run, because nobody answers while autoclaude builds; every step needs Accept lines a test or a browser can check; the Constraints & decisions section says what to do when something is unclear; and a plan written before autoclaude was added gets reviewed against these rules
  - Accept: `autoclaude init` in an empty folder produces a project that passes `lint-plan` once one step is filled in; `init` in a checkout of Lists or DB adds only the files they lack and lists what it skipped

**CHECKPOINT 2:** Run `init` on the fixture app and show the generated config, the statusline and the injected context after `/compact`.

### Phase 3: The Stop gate (core loop)

- [x] **P3.1** Fixture app and plans (2026-09-27: `test/fixtures/todo-app` with a unit test, a Playwright spec and `npm run dev`; `plans/{happy,broken,ui-bug}.md`; `test/fixtures/prepare.js` builds a scratch project and applies the broken and ui-bug variants)
  - Accept: `test/fixtures/todo-app`: a minimal web app (Vite or Express with static HTML) with a unit test, a Playwright spec and `npm run dev`
  - Accept: `test/fixtures/plans/` contains `happy.md` (3 steps), `broken.md` (one step whose test can't pass) and `ui-bug.md` (unit tests pass but the UI is broken)
- [x] **P3.2** Ready/blocked protocol and gate skeleton (2026-09-27: `lib/protocol.js`, `autoclaude ready|blocked|start`, `lib/gate.js` + `scripts/stop-gate.js`; scenario tests cover not-running, nested role, nudge, no-progress pause)
  - Accept: `autoclaude ready <id>` and `autoclaude blocked <id> "<reason>"` write the markers, and reject IDs that aren't the current step
  - Accept: gate behaviour follows §4.4 for not-running (allow), no ready marker (continue nudge) and no progress (counter then pause)
- [x] **P3.3** `lib/devserver.js` (2026-09-27: 7 tests; on Windows a detached console-less node wrapper runs `cmd /c <command>` so the server survives the hook and still logs, see CLAUDE.md facts)
  - Accept: health-checks the URL, starts the command detached with logs in `.autoclaude/logs/devserver.log`, reuses a running server, and stops it on complete or pause
- [x] **P3.4** `lib/checks.js` and `lib/report.js` (2026-09-27: 13 tests; summaries never exceed 4,000 characters and always end with the report path)
  - Accept: runs the checks in order with per-check timeouts, stops at the first failure, and captures the last 150 lines of each failing check
  - Accept: the report file holds full output. The summary sent to Claude is ≤ 4,000 characters and names the report path.
- [x] **P3.5** Pass path (2026-09-27: scenario tests "ready with passing checks" and "last step passes")
  - Accept: ticks the step, appends `PROGRESS.md`, commits `autoclaude(<id>): <title>`, tags phase ends, advances to the next step and sends Claude the next step's full text
  - Accept: the last step marks the plan complete and sends the summary notification
- [x] **P3.6** Fail path (2026-09-27: scenario tests "ready with failing checks" and "fail then pass")
  - Accept: attempts increment. On the 3rd failure the step is marked `[!]`, the state pauses, a high-priority notification goes out and the stop is allowed.
- [x] **P3.7** Integrity check (2026-09-27: scenario test "integrity: a box ticked by anyone but the gate is reverted")
  - Accept: if a `PLAN.md` box was ticked by anything other than the gate, the gate reverts it and tells Claude why
- [x] **P3.8** Scenario tests (no live Claude, fake hook stdin) (2026-09-27: `test/scenarios/stop-gate.test.js`, 12 scenarios incl. blocked, wrong-step ready, pause requested, phase-end tag, D33 re-baseline)
  - Accept: `node --test test/scenarios` covers pass, fail→retry→pass, fail×3→pause, blocked, no-progress→pause, integrity violation and complete

**CHECKPOINT 3 (first live run):** On the fixture, Scott runs `happy.md` with a real Claude session. All 3 steps are verified and committed with no input. `broken.md` pauses after 3 attempts and sends a notification.

### Phase 4: Browser tester

- [ ] **P4.1** `prompts/tester.md`
  - Accept: the tester only reads and browses (never edits code), checks every Accept line, runs a quick smoke check of neighbouring features, gives evidence for each criterion and collects console errors
- [ ] **P4.2** `lib/tester.js`
  - Accept: spawns `claude -p` with the config model, `--max-turns`, `--strict-mcp-config --mcp-config .autoclaude/mcp.playwright.json`, `--permission-mode dontAsk`, a narrow `--allowedTools`, `--settings '{"disableAllHooks":true}'`, `--output-format json --json-schema <verdict>` and `AUTOCLAUDE_ROLE=tester`
  - Accept: timeouts or unparseable output count as an infrastructure failure: retried once, then reported, without using up one of the step's attempts
  - Accept: saves the verdict and any screenshots under `reports/`
- [ ] **P4.3** Wire into the gate
  - Accept: the tester runs only after the deterministic checks pass. Steps tagged `no-ui` skip it. Failing criteria and bugs become the failure summary with repro steps.
- [ ] **P4.4** Phase-end bug bash
  - Accept: at a phase's last step, `prompts/bugbash.md` explores every feature ticked in that phase. High-severity bugs fail the gate, others go to `docs/BLOCKERS.md` as follow-ups.
- [ ] **P4.5** Scenario
  - Accept: on `ui-bug.md` the unit tests pass, the tester catches the UI bug, Claude fixes it on the next attempt and the step passes

**CHECKPOINT 4:** Live run of `ui-bug.md`, with the tester's verdict and screenshots shown.

### Phase 5: Guardrails for unattended runs

- [ ] **P5.1** Questions
  - Accept: while running, `AskUserQuestion` is denied with guidance to follow §4.5
  - Accept: `agents/decider.md` exists and returns `{recommendation, reasoning, classification}`. `docs/DECISIONS.md` entries follow the format in §4.5.
- [ ] **P5.2** Critical blocker round-trip
  - Accept: `autoclaude blocked` pauses the run and notifies with the question. `autoclaude answer "<text>"` (from a shell, or `/autoclaude:answer` in the session) records the answer in `docs/DECISIONS.md`, resumes, and the answer reaches Claude through the next context injection or nudge.
- [ ] **P5.3** Permission handling and the tool guard
  - Accept: while running, anything that would prompt is denied with guidance and logged. If denials exceed 10 per hour, a notification goes out.
  - Accept: the hard-deny list (force push, `git reset --hard` on main or master, `rm -rf` outside the project, edits to protected autoclaude files) is denied, and shell commands that write to `PLAN.md` are caught as well
- [ ] **P5.4** Security reviewer
  - Accept: runs at phase end and on `security`-tagged steps over `git diff <last ac tag>..HEAD`. High severity fails the gate, anything else is appended to `docs/SECURITY-FINDINGS.md`.
  - Accept: a fixture step with an obvious flaw (for example SQL built by string concatenation, or a hardcoded secret) is caught
- [ ] **P5.5** Usage gate
  - Accept: with a fake `usage.json` showing weekly ≥ threshold, the gate pauses after the current step's commit and notifies with the reset time
  - Accept: usage data older than `staleAfterMin` produces one log warning, never a pause
- [ ] **P5.6** Pause for review (§4.10)
  - Accept: `autoclaude pause` sets `pauseRequested`; the gate pauses only after the next verified commit, stops the dev server and sends a default-priority notification
  - Accept: `autoclaude pause --now` pauses immediately and keeps the step's attempt count
  - Accept: `autoclaude note "..."` appends to `docs/REVIEW_NOTES.md`; after `resume` the note appears in the injected context, and Claude's handling lands in `docs/DECISIONS.md` as `N-###`
  - Accept: `review.pauseAt: phase-end` pauses after the last step of a phase and `every-step` after each step; scenario tests cover all three settings
  - Accept: `resume` refuses with a clear message when `PLAN.md` fails lint after Scott edited it

**CHECKPOINT 5:** Demo a blocked question answered from Scott's phone or a shell, a caught security flaw, a weekly-limit pause, and a pause, note and resume round trip.

### Phase 6: Recovery, supervisor and notifications

- [ ] **P6.1** Idle and permission-prompt detector (`Notification` hook)
  - Accept: while running, `idle_prompt`, `permission_prompt` or `agent_needs_input` sends a high-priority notification (throttled to one per 30 minutes)
- [ ] **P6.2** `StopFailure` handling
  - Accept: `rate_limit` is only logged. Other error types are logged to `failure.json` for the supervisor's next pass.
- [ ] **P6.3** `autoclaude run`
  - Accept: from a shell in the project, it opens a new console window titled `ac-<slug>` running `autoclaude supervise`, which spawns `claude --permission-mode auto "/autoclaude:start"`; it records the window title and supervisor pid in state and prints how to watch (`autoclaude status`, the window) and how to stop (`autoclaude pause`)
  - Accept: on Linux and macOS the same command uses tmux when present and otherwise a background process logging to `logs/supervisor.log`
  - Accept: `/autoclaude:start` runs the preflight (clean tree, branch, config valid, plan lints, checks runnable, dev server healthy, Playwright installed, usage below threshold, notify channel configured, first-run onboarding done (`hasCompletedOnboarding`) and the workspace trusted (`projects["<repo root, forward slashes>"].hasTrustDialogAccepted`), read from `~/.claude.json` without ever writing it; if either is missing it tells the user to run `claude` once in the project, pick a theme, accept the trust dialog and exit, D28), then sets running and starts on the first unchecked step
- [ ] **P6.4** Supervisor loop and backstop watchdog
  - Accept: every 60 s the supervisor decides from the heartbeat age, the idle marker, `failure.json`, `claude agents --json` (which lists interactive sessions with a `status`, D31), usage reset times and state:
    - working → nothing
    - usage-limit wait (`rate_limit` in `failure.json` and the reset time not yet passed) → nothing
    - idle and stale over 15 min → end the child, relaunch `claude --continue --permission-mode auto "/autoclaude:resume"`
    - child exited while state is running → relaunch the same way
    - 2 relaunches in a row with no progress → pause(stuck) and notify
  - Accept: if `autoResumeAfterWeeklyReset` is on, it resumes a weekly-limit pause after the reset time
  - Accept: `autoclaude watchdog --install` registers a scheduled task (Windows: `schtasks`, every 5 minutes, running only while the user is logged on; Linux and macOS: a cron line or systemd user timer from `templates/watchdog/`) that relaunches a dead supervisor for every registered running project, and `--uninstall` removes it
- [ ] **P6.5** Summaries
  - Accept: plan-complete and optional morning summaries include steps done, attempts, decisions made, blockers, usage used and elapsed time
- [ ] **P6.6** Chaos tests (live, on the fixture)
  - Accept: the run recovers without Scott from each of: a killed `claude` process mid-step, a killed supervisor (the backstop relaunches it), a forced `/compact` mid-step, a simulated stall (hook sleeps), a dev server crash, and an RDP disconnect and reconnect

**CHECKPOINT 6:** Show the chaos-test log and the notifications received.

### Phase 7: Planner, docs and an overnight dress rehearsal

- [ ] **P7.1** `/autoclaude:plan` skill
  - Accept: interviews Scott (goal, users, stack, constraints, out of scope), proposes phases and 20–90 minute steps with browser-observable Accept lines, `Test:` files and tags, writes `PLAN.md` from `PLAN.template.md`, and runs `lint-plan`
  - Accept: the Constraints & decisions section is filled in, because the decider relies on it
  - Accept: the interview settles every decision it can up front (stack, naming, scope, data, what to do when unsure) and records each in Constraints & decisions, so the run never needs a human (R17); for a project that already has a plan, the skill starts with a review of that plan and lists every step that would stall an unattended run, then rewrites it into the step format
- [ ] **P7.2** Docs
  - Accept: `README.md` (what it is, a 5-minute quickstart) and `docs/USAGE.md` (install, init, plan, run, watch, pause and notes, alerts, answering blockers, recovery, uninstall, troubleshooting; Windows notes on RDP disconnect versus log-off, power settings and the standard-user recommendation; Linux and macOS notes), all written for someone who has never seen this repo or Scott's machines
- [ ] **P7.3** Overnight dress rehearsal
  - Accept: a 12-step, 3-phase fixture plan (use `/autoclaude:plan` to write it) runs overnight on the Code VM with no input
  - Accept: the morning review finds 12 commits, every step verified, no false alarms, and every issue found turned into a fix or a backlog item
- [ ] **P7.4** Release
  - Accept: `plugin.json` version `1.0.0`, git tag `v1.0.0`, `CHANGELOG.md`, and `LICENSE` if Scott chose one

**CHECKPOINT 7:** Morning-after review of the dress rehearsal with Scott.

### Phase 8: Rollout

- [ ] **P8.1** First real project on the Code VM: `/autoclaude:init`, `/autoclaude:plan`, Scott reviews `PLAN.md`, a supervised run of 2–3 steps (watching the window, or `review.pauseAt: every-step`), then unattended
  - Accept: the first real project has run at least 3 steps unattended on the Code VM with one verified commit per step and no false alarms
- [ ] **P8.2** Install on the Windows 11 desktop and confirm an unattended run behaves the same as on the Code VM, including sleep and power settings
  - Accept: the fixture plan passes unattended on the Windows 11 desktop, and the sleep and power settings that matter are written into `docs/USAGE.md`
- [ ] **P8.3** Backlog of later ideas lives in `docs/DEFERRED.md`, each with a trigger; review it and file anything new from the rollout
  - Accept: every later idea raised during the rollout is in `docs/DEFERRED.md` with a trigger, and nothing is left only in chat

---

## 6. How to run this plan

### 6.1 Prepare the machine (once)

Windows (Scott's `Code` VM, or a Windows 11 desktop). Everything is per user; admin rights are needed only for the installers.

1. Install **Git for Windows**, **Node 24 LTS** and the **GitHub CLI** (`winget install Git.Git OpenJS.NodeJS.LTS GitHub.cli`). Open a new terminal so PATH picks them up. `gh auth login` once.
2. Install Claude Code natively: `irm https://claude.ai/install.ps1 | iex`, then run `claude`, log in with your subscription, and `/exit`. The VS Code extension's bundled binary is not on PATH and is not what the supervisor runs.
3. `npx playwright install chromium`, once per user.
4. `git config --global user.name` and `user.email`, if not set.
5. If the machine is reached over RDP: **disconnect, never log off**, when you walk away. Check that no disconnected-session time limit is set (Group Policy: Remote Desktop Session Host, Session Time Limits). On a desktop, set the power plan so the machine never sleeps while a run is on.
6. On your phone: install the **ntfy** app and subscribe to a hard-to-guess topic, either on ntfy.sh or a self-hosted ntfy. A Discord webhook works too.

Linux or macOS: git, Node 24, the native Claude Code installer (`curl -fsSL https://claude.ai/install.sh | bash`), `npx playwright install --with-deps chromium`. tmux is optional.

### 6.2 Bootstrap the repo

Done on 2026-09-26: `git init`, remote `git@github.com:chaoticnewfie/autoclaude.git`, first commit `46a7aa9`. On another machine:

```powershell
gh repo clone chaoticnewfie/autoclaude
cd autoclaude
code .    # open the repo folder itself, not a parent, so Claude Code files the chat history under this project
```

### 6.3 Kickoff prompt (paste into Claude)

> Read PLAN.md in full. We're building the AutoClaude plugin it describes, on this machine, which is where it will run. Follow section 0 exactly: one phase at a time, stop at every CHECKPOINT and show me the demo, and log decisions in docs/DECISIONS.md and keep CONTINUE_HERE.md and docs/SESSION_LOG.md current. Start with Phase 0. Do each spike, record the results in VERIFY.md, and if anything contradicts the plan, propose the change to PLAN.md before continuing. Don't start Phase 1 until I approve CHECKPOINT 0.

### 6.4 Running each phase

After you approve a checkpoint, start the next phase with the built-in `/goal`, so Claude keeps going without per-turn prompting:

```
/goal Phase <N> in PLAN.md is complete: every Phase <N> checkbox is ticked with evidence shown, `node --test` exits 0, and you have stopped at CHECKPOINT <N> with the demo ready. Stop after 60 turns if not done and summarize what's left.
```

Phase 0 and Phase 3 onward involve live runs. Stay nearby for those, because Claude may ask you to watch or confirm something.

### 6.5 What to check at each checkpoint

- The demo in the checkpoint line actually works in front of you.
- `node --test` is green, and `git log` shows sensible commits.
- `docs/DECISIONS.md`: do you agree with each choice Claude made?
- Anything in `VERIFY.md` marked Changed or Blocked.
- For CHECKPOINT 3 onward: read one gate report under `.autoclaude/reports/` to confirm the feedback Claude gets is clear.

### 6.6 Daily use once it's built

```text
# once per machine
/plugin marketplace add C:\path\to\autoclaude
/plugin install autoclaude@autoclaude-local      # enter ntfy or Discord settings when prompted
autoclaude install-cli                           # adds `autoclaude` to your user PATH
autoclaude watchdog --install                    # optional backstop, every 5 minutes

# per project (new or existing)
cd C:\code\my-app && claude
/autoclaude:init          # config, docs from the template, Playwright, statusline; skips files that exist
/autoclaude:plan          # talk it through; Claude writes or converts PLAN.md
                         # read PLAN.md yourself and edit anything you disagree with
/exit
autoclaude run            # opens the ac-my-app window with the supervisor and the loop
                         # disconnect RDP (do not log off); go to bed

# when your phone buzzes, or whenever you want a look
autoclaude status                     # what happened
autoclaude answer "Use Stripe test mode; no live keys"   # for a blocked question
autoclaude pause                      # stop after the next verified commit (--now to stop at once)
autoclaude note "Use the existing auth table, don't add another"   # as many as you like
autoclaude resume                     # Claude reads the notes first, then continues

# morning
autoclaude status && git log --oneline autoclaude/<plan>   # then skim PROGRESS.md and docs/DECISIONS.md
```

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude Code behaviour differs from the docs this plan relies on | Phase 0 spikes every assumption before code depends on it. The plan gets updated. |
| The gate loops forever on an unfixable step | 3-attempt cap, no-progress counter, per-step time cap, Claude Code's own block cap |
| Claude games verification (weakens tests, ticks boxes) | Only the gate ticks. Protected files. Integrity check. An independent tester runs in a separate process. The reviewer checks the diff, test changes included (the tester prompt flags deleted or weakened assertions). |
| The session stalls on a prompt overnight | PermissionRequest auto-deny, `AskUserQuestion` deny, idle notification, supervisor relaunch with `--continue` |
| Usage burns through the week | Weekly pause threshold (85%). The tester runs on Sonnet. Security review only at phase ends and tagged steps. |
| Context bloat across a long run | Built-in auto-compaction. SessionStart re-injects the rules and the current step after each compaction. All state lives in files. |
| Something destructive happens | Dedicated VM, a standard user account, no production credentials, auto-mode classifier, hard-deny list, git on a branch with one commit per step |
| The Windows session ends (log-off, reboot, sleep) and the run dies with it | Documented disconnect-not-log-off rule and power settings. The backstop scheduled task relaunches the supervisor at the next logon, and every state is in files, so `--continue` picks up where it stopped. |
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
