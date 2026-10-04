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
| 2026-09-27 | "Could we change phase 7 to work on a real project... my database project... that will also give us the chance to test integrating this into an existing project"; "give claude in that project the github repo for autoclaude and have it add it to the project and start it that way"; plan size follows the project, not a fixed 12 steps; then "dont look at that project at all... I want to test it without you specifically preparing it for that project" | D36, D37, P7.3 (blind rehearsal on the DB repo), P5.3 and P7.1 (generic existing-project handling), P8.1 | Planned |
| 2026-09-27 | "I'm going to keep it private and give certain people access. It's the morning now but I can let it run all day when it's time." | D41, P7.2 (install from a private repo), P7.3 (an all-day run), P7.4 (no license file) | Planned |
| 2026-09-27 | "Could you just write one now and it gets pulled with the github repo? literally just needs to be a text docment of instructions for the user" (a people-facing guide: getting started and every feature) | `INSTRUCTIONS.md` at the repo root, linked from the top of `README.md` | Done |
| 2026-09-27 | "we should probably make sure the autoclaude files and stuff doesn't get pushed to the projects github repos that it's used to build too" | D45: asked 2026-09-27, Scott chose "Leave it as is": only `.autoclaude/` stays out of git; INSTRUCTIONS.md says what is committed | Done |
| 2026-09-27 | "We don't ever need to use haiku, sonnet is okay if something is very basic but id set whatever the newest sonnet is as the floor for models usage. and whatever the newest Opus is as the celing and the main model used" | D44: builder, decider, tester, bug bash and security default to opus; config refuses Haiku | Done |
| 2026-09-27 | Keep AutoClaude a one-time install per device and pull the instructions into each project: "lets do it. I like having it as a one time setup per device" | D46: `init` copies INSTRUCTIONS.md into every project as AUTOCLAUDE.md, stamped with the version | Done |
| 2026-09-27 | "it's so so so so so much slower than just using claude code extension in vs code... Will it be possible to make it work at a more normal speed once I'm able to work on this again? I don't want to just burn tokens for no reason" | DEFERRED 18 (faster runs), measured at CHECKPOINT 7; P8.2 to P8.4 | Planned |
| 2026-09-27 | "I kinda pictured the checks to run after a full feature has been built. Like if we adding an admin page, build the page, and all the features within the page, and before moving to another page or other major feature or whatever, then run the checks. I want it to build a decent amount and run the checks to make sure everything is working before going to another major piece." | P8.2 (verify once per feature), D49 | Planned |
| 2026-09-27 | "I want it to work on the project start to finish no different than if I was watching the whole time, and I can specify differently if I want while making the plan... Can we adjust it to be closer to how I want eventually?" (after learning a run would not create the DB project's VM) | D47; P8.1 | Planned |
| 2026-09-27 | "Id rather 25 questions or more and end up with what I want than everything assumed and waste tokens. The point is a little extra planning time and I save most of the build time. Thats the goal. And I'll sit and work with claude code as I'm used to, to fine tune and make sure everything is working and looking how I want" | D48; P8.1 | Planned |
| 2026-09-28 | "a autoclaude:config command so we can change the config easily. Like have it open a page we can scroll up and down through to change things like the limit we stop at on the weekly, maybe be able to change the webhook url, everything we can set in there would be nice. It'll also be nice when other people use the project as well and might want different settings than me." | P8.7, D49 | Planned |
| 2026-09-28 | "I also wouldn't mind getting more updates in general, like get one each time a feature is finished... configurable alerts" | P8.6, D49 | Planned |
| 2026-10-02 | "Add an security command to autoclaude that we could run on existing projects that would run a security sweap on an app that would check over the entire app in the code and using a headless browser, and anything else you would have available to do a full security sweap. Also give the option to have it output a file with all the details including suggested fixes, or the ability to have autoclaude start fixing them right away after the sweap finishes." | Phase 10 (P10.1 to P10.12), D58 | Planned |
| 2026-10-02 | "optimize command. Have autoclaude sweap the entire project looking for stale or unused code to remove, or look for features that were poorly built and rebuild/ optimize them too. I'd want to have it do a total optimization sweap." Same report-or-fix-now option | Phase 10 (P10.1 to P10.12), D58 | Planned |
| 2026-10-03 | "when doing the autoclaude plan, make sure that the phase is small enough that it'll be able to actually be verified in the given time. I'm currently redoing a plan because it keeps running out of time on the verification of a phase... something to get fixed before doing another big update" | P10.13 (D60), in 1.1.0 | Planned |
| 2026-10-03 | A suggestion from another project's session: "Run the checkers side by side in one stop... The security review only reads the diff and never uses the browser. Running it alongside the browser checks costs almost nothing." Scott: "This combined with smaller phases should make it pretty safe" | P10.13 (D61) | Planned |
| 2026-10-04 | "Make sure the config page and instructions are updated whenever new features are added everytime if they need to be" | CLAUDE.md definition of done item 4; test/unit/docs-coverage.test.js; 1.1.1 | Done |

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
- **Unattended:** runs a real project's plan overnight with no human input (the rehearsal uses Scott's DB project, D36), and each verified step produces exactly one commit. Plans are sized by the work: steps of 20 to 90 minutes, as many as the project needs.
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
├── .claude-plugin/marketplace.json        # marketplace "autoclaude" (D42)
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
├── plugins/autoclaude/project-template/   # what `autoclaude init` writes into a project (D23, D42)
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
- [x] **P0.9** Reconcile (VERIFY.md has a row per step; every change is in this plan and in `docs/DECISIONS.md` D26 to D31)
  - Accept: `VERIFY.md` has a Pass/Changed/Blocked row for every Phase 0 step
  - Accept: every "Changed" row is reflected in this plan and in `docs/DECISIONS.md`
- [x] **P0.10** Spike plugin hooks on Windows (VERIFY.md: exec form, `${CLAUDE_PLUGIN_ROOT}`, spaces, EPERM retry)
  - Accept: a local-marketplace plugin whose `hooks.json` runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.js"` fires on Windows, with `${CLAUDE_PLUGIN_ROOT}` expanded and the stdin JSON readable
  - Accept: documented which shell runs hook commands on Windows, whether `node` resolves there, and how a plugin path with spaces behaves
  - Accept: `fs.renameSync` over a file another process holds open is tried, and the retry strategy for `EPERM` and `EBUSY` is documented

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

- [x] **P4.1** `prompts/tester.md` (2026-09-27: live, the tester checked every Accept line with evidence, smoke-checked, read the console, took screenshots, and could not edit: Playwright MCP, Read, Glob, Grep only)
  - Accept: the tester only reads and browses (never edits code), checks every Accept line, runs a quick smoke check of neighbouring features, gives evidence for each criterion and collects console errors
- [x] **P4.2** `lib/tester.js` (2026-09-27: with `lib/headless.js`; prompt on stdin, `--add-dir` instead of the project as working directory, per-run MCP config with `--isolated` and `--output-dir`; unit tests for infra retry, deadline, verdict file, stray-file sweep, D35)
  - Accept: spawns `claude -p` with the config model, `--max-turns`, `--strict-mcp-config --mcp-config .autoclaude/mcp.playwright.json`, `--permission-mode dontAsk`, a narrow `--allowedTools`, `--settings '{"disableAllHooks":true}'`, `--output-format json --json-schema <verdict>` and `AUTOCLAUDE_ROLE=tester`
  - Accept: timeouts or unparseable output count as an infrastructure failure: retried once, then reported, without using up one of the step's attempts
  - Accept: saves the verdict and any screenshots under `reports/`
- [x] **P4.3** Wire into the gate (2026-09-27: dev server restarted before each verification; scenario tests for tester failure, pass with follow-ups, infra not counted then pause, no-ui, dev server failure)
  - Accept: the tester runs only after the deterministic checks pass. Steps tagged `no-ui` skip it. Failing criteria and bugs become the failure summary with repro steps.
- [x] **P4.4** Phase-end bug bash (2026-09-27: live, it found two medium and one low misuse bug and filed them in `docs/BLOCKERS.md` inside the step commit; severity recalibrated after its first live run failed a phase on an absurd-input layout issue, D35)
  - Accept: at a phase's last step, `prompts/bugbash.md` explores every feature ticked in that phase. High-severity bugs fail the gate, others go to `docs/BLOCKERS.md` as follow-ups.
- [x] **P4.5** Scenario (2026-09-27: `test/live/ui-bug.live.mjs` with the real gate and tester and a scripted builder: attempt 1 failed in the browser with evidence and screenshots, the fix passed on attempt 2, the bug bash passed, the plan completed with one commit)
  - Accept: on `ui-bug.md` the unit tests pass, the tester catches the UI bug, Claude fixes it on the next attempt and the step passes

**CHECKPOINT 4:** Live run of `ui-bug.md`, with the tester's verdict and screenshots shown.

### Phase 5: Guardrails for unattended runs

- [x] **P5.1** Questions (2026-09-27: `agents/decider.md`; live, the builder consulted it, got "critical" with a ready-made owner question, and logged its own routine choice as D-002 in the section 4.5 format)
  - Accept: while running, `AskUserQuestion` is denied with guidance to follow §4.5
  - Accept: `agents/decider.md` exists and returns `{recommendation, reasoning, classification}`. `docs/DECISIONS.md` entries follow the format in §4.5.
- [x] **P5.2** Critical blocker round-trip (2026-09-27: live, blocked with a five-option question, high Discord message, Scott answered in the run window, the builder recorded it with `autoclaude answer` as D-001, finished the step and the gate verified it; CLI and scenario tests for the terminal path)
  - Accept: `autoclaude blocked` pauses the run and notifies with the question. `autoclaude answer "<text>"` (from a shell, or `/autoclaude:answer` in the session) records the answer in `docs/DECISIONS.md`, resumes, and the answer reaches Claude through the next context injection or nudge.
- [x] **P5.3** Permission handling and the tool guard (2026-09-27: `scripts/permission-deny.js` with scenario tests incl. the 11th-denial notification; `guard.deny` with validation and tests; no prompt appeared in either live run this phase, and the hook's output shape is the one verified live in P0.6)
  - Accept: while running, anything that would prompt is denied with guidance and logged. If denials exceed 10 per hour, a notification goes out.
  - Accept: the hard-deny list (force push, `git reset --hard` on main or master, `rm -rf` outside the project, edits to protected autoclaude files) is denied, and shell commands that write to `PLAN.md` are caught as well
  - Accept: a per-project deny list in `autoclaude.config.json` (`guard.deny`: regex patterns with a reason each) blocks matching Bash commands during a run; tested with generic example rules for a machine that can reach other hosts (`ssh`, `scp`, infrastructure CLIs), because section 4.7 assumes the run cannot reach anything outside the project and a developer machine often can
- [x] **P5.4** Security reviewer (2026-09-27: agent-built `lib/security.js`; live on a planted flaw: SQL injection and a hardcoded key both high, 14 s; live at a real phase end: pass with one sharp low finding filed in `docs/SECURITY-FINDINGS.md`; scenario tests for fail, pause as security, findings, tag, infra)
  - Accept: runs at phase end and on `security`-tagged steps over `git diff <last ac tag>..HEAD`. High severity fails the gate, anything else is appended to `docs/SECURITY-FINDINGS.md`.
  - Accept: a fixture step with an obvious flaw (for example SQL built by string concatenation, or a hardcoded secret) is caught
- [x] **P5.5** Usage gate (2026-09-27: scenario tests with a fake `usage.json`: 86% pauses after the commit and names the reset; two-hour-old data logs one warning and never pauses)
  - Accept: with a fake `usage.json` showing weekly ≥ threshold, the gate pauses after the current step's commit and notifies with the reset time
  - Accept: usage data older than `staleAfterMin` produces one log warning, never a pause
- [x] **P5.6** Pause for review (§4.10) (2026-09-27: live with `review.pauseAt: every-step`: paused after S1.1, a note, `resume`, the builder relaunched with `--continue` applied the note without breaking the Accept line, recorded it as N-001, and the run paused again after S1.2; the live run also exposed a note that stayed pending after its step passed, fixed; scenario and CLI tests for all three pauseAt settings, pause --now, lint refusal and the D33 re-baseline)
  - Accept: `autoclaude pause` sets `pauseRequested`; the gate pauses only after the next verified commit, stops the dev server and sends a default-priority notification
  - Accept: `autoclaude pause --now` pauses immediately and keeps the step's attempt count
  - Accept: `autoclaude note "..."` appends to `docs/REVIEW_NOTES.md`; after `resume` the note appears in the injected context, and Claude's handling lands in `docs/DECISIONS.md` as `N-###`
  - Accept: `review.pauseAt: phase-end` pauses after the last step of a phase and `every-step` after each step; scenario tests cover all three settings
  - Accept: `resume` refuses with a clear message when `PLAN.md` fails lint after Scott edited it

**CHECKPOINT 5:** Demo a blocked question answered from Scott's phone or a shell, a caught security flaw, a weekly-limit pause, and a pause, note and resume round trip.

### Phase 6: Recovery, supervisor and notifications

- [x] **P6.1** Idle and permission-prompt detector (`Notification` hook) (2026-09-27, as amended by D39: every notification writes the idle marker for the supervisor; only `permission_prompt`, `agent_needs_input` and `elicitation_dialog` page, high, at most once per 30 minutes. Live: an `idle_prompt` after the forced compaction was logged and paged nobody, and the supervisor relaunched the session 49 s later)
  - Accept: while running, `idle_prompt`, `permission_prompt` or `agent_needs_input` sends a high-priority notification (throttled to one per 30 minutes)
- [x] **P6.2** `StopFailure` handling (2026-09-27: `failure.json` records every type with its time, and the supervisor treats `rate_limit` as a wait until the reset plus a grace period, never a relaunch; scenario and unit tests; no API error occurred in the live runs)
  - Accept: `rate_limit` is only logged. Other error types are logged to `failure.json` for the supervisor's next pass.
- [x] **P6.3** `autoclaude run` (2026-09-27: live on Windows twice, including bringing back a paused run; the preflight refused a shell without node, and now also checks git on PATH for a run already under way, after a run window without git could not commit; Linux and macOS paths, tmux or a background process, unit-tested only)
  - Accept: from a shell in the project, it opens a new console window titled `ac-<slug>` running `autoclaude supervise`, which spawns `claude --permission-mode auto "/autoclaude:start"`; it records the window title and supervisor pid in state and prints how to watch (`autoclaude status`, the window) and how to stop (`autoclaude pause`)
  - Accept: on Linux and macOS the same command uses tmux when present and otherwise a background process logging to `logs/supervisor.log`
  - Accept: `/autoclaude:start` runs the preflight (clean tree, branch, config valid, plan lints, checks runnable, dev server healthy, Playwright installed, usage below threshold, notify channel configured, first-run onboarding done (`hasCompletedOnboarding`) and the workspace trusted (`projects["<repo root, forward slashes>"].hasTrustDialogAccepted`), read from `~/.claude.json` without ever writing it; if either is missing it tells the user to run `claude` once in the project, pick a theme, accept the trust dialog and exit, D28), then sets running and starts on the first unchecked step
- [x] **P6.4** Supervisor loop and backstop watchdog (2026-09-27: `decide` is one pure function with a unit test per rule, plus loop tests with a fake clock; live it relaunched a killed session in 11 s, a compacted idle session, and a stalled one after twice the stall time; the Task Scheduler watchdog brought back a killed supervisor within its 5-minute cycle. Added from the live run: `autoclaude nudge`, a running verification counts as activity, and a nudge never interrupts the gate (D40))
  - Accept: every 60 s the supervisor decides from the heartbeat age, the idle marker, `failure.json`, `claude agents --json` (which lists interactive sessions with a `status`, D31), usage reset times and state:
    - working → nothing
    - usage-limit wait (`rate_limit` in `failure.json` and the reset time not yet passed) → nothing
    - idle and stale over 15 min → end the child, relaunch `claude --continue --permission-mode auto "/autoclaude:resume"`
    - child exited while state is running → relaunch the same way
    - 2 relaunches in a row with no progress → pause(stuck) and notify
  - Accept: if `autoResumeAfterWeeklyReset` is on, it resumes a weekly-limit pause after the reset time
  - Accept: `autoclaude watchdog --install` registers a scheduled task (Windows: `schtasks`, every 5 minutes, running only while the user is logged on; Linux and macOS: a cron line or systemd user timer from `templates/watchdog/`) that relaunches a dead supervisor for every registered running project, and `--uninstall` removes it
- [x] **P6.5** Summaries (2026-09-27: the plan-complete summary reached Discord from the chaos run with steps, attempts, decisions, follow-ups, usage and elapsed time; the morning summary is covered by a supervisor loop test, not yet seen live)
  - Accept: plan-complete and optional morning summaries include steps done, attempts, decisions made, blockers, usage used and elapsed time
- [x] **P6.6** Chaos tests (live, on the fixture) (2026-09-27: all six recovered without Scott on a 5-step plan, 68 minutes; log in `spikes/out/chaos-events.log`. The run exposed five AutoClaude bugs, all fixed with tests: a nudge that killed a verification, an idle gap after compaction, a long verification mistaken for a stall, a bug bash thrown away at its turn limit, and a failed commit that did not stop the run)
  - Accept: the run recovers without Scott from each of: a killed `claude` process mid-step, a killed supervisor (the backstop relaunches it), a forced `/compact` mid-step, a simulated stall (hook sleeps), a dev server crash, and an RDP disconnect and reconnect

**CHECKPOINT 6:** Show the chaos-test log and the notifications received.

### Phase 7: Planner, docs and a dress rehearsal

- [x] **P7.1** `/autoclaude:plan` skill (2026-09-27: written, then reviewed by two dry runs on scratch projects, one new and one existing with conflicting rules, a roadmap and a deploy script, and rewritten from their findings (D43). An onboarding rehearsal from the repo link then followed it headless on a third scratch project: it reviewed the owner's list and rules, left their list untouched as their rule asked, deferred 3 items that need a person or another machine, planned 6 steps that lint clean, set checks, the dev server and guard rules (13 must-block commands denied, 9 everyday ones allowed via `guard-test`), added the CLAUDE.md run section, committed, and stopped at a preflight whose only FAIL was folder trust, which only a person can give)
  - Accept: interviews Scott (goal, users, stack, constraints, out of scope), proposes phases and 20–90 minute steps with browser-observable Accept lines, `Test:` files and tags, writes the plan from `plugins/autoclaude/project-template/PLAN.md`, and runs `lint-plan`
  - Accept: the Constraints & decisions section is filled in, because the decider relies on it
  - Accept: the interview settles every decision it can up front (stack, naming, scope, data, what to do when unsure) and records each in Constraints & decisions, so the run never needs a human (R17); for a project that already has a plan, the skill starts with a review of that plan and lists every step that would stall an unattended run, then rewrites it into the step format
  - Accept: in an existing project the skill also works out, with the owner: where the AutoClaude plan should live when the project's own plan file must not be rewritten (the `plan` config key); where the project's existing rules conflict with a run (for example "commit and push after every change" while the gate commits and pushing is off) and a short AutoClaude section for its `CLAUDE.md`; what the run must never touch outside the project, written as `guard.deny` rules; and whether every check command actually runs on this machine, naming any missing tool as a prerequisite for the owner
- [x] **P7.2** Docs (2026-09-27: README.md and docs/USAGE.md written, fact-checked against the code by two reviewers, read cold by a newcomer reviewer, and rewritten from 80-odd findings; the onboarding rehearsal reached the preflight using only these two files, and its 14 notes led to the last fixes. `test/live/gh-install.live.mjs` installs from GitHub into a config folder whose path has a space and a tilde: 9/9, including init from the cache copy, the launcher across a simulated update, and the installed guard denying pushes from both shell tools)
  - Accept: `README.md` (what it is, a 5-minute quickstart) and `docs/USAGE.md` (install, init, plan, run, watch, pause and notes, alerts, answering blockers, recovery, uninstall, troubleshooting; Windows notes on RDP disconnect versus log-off, power settings and the standard-user recommendation; Linux and macOS notes), all written for someone who has never seen this repo or Scott's machines
  - Accept: the docs cover installing from the private repo as an invited collaborator (D41)
  - Accept: a GitHub install works on a machine that has never seen the repo: everything `init`, the CLI shim and the watchdog need ships inside the plugin folder and survives a plugin update, proven by a scripted install into a throwaway Claude config (D42)
- [x] **P7.3** Dress rehearsal on a real project, as a blind test: Scott's DB repo (D36, D37) (2026-09-28: onboarded by link on 0.9.4, planned, then ran 18 h 23 min unattended: 28 of 28 steps verified in 30 attempts, 26 first time, one commit per step, no pauses, no relaunches, one alert (plan complete), nothing sent to pve or other hosts. The review (two read-only agents over the logs, reports, planning and builder transcripts) found 16 issues, among them: planning never asked the run's scope and wrote the deny rules itself, so the VM was left to Scott; the full test suite ran twice per step (about 46% of the run); one 18-hour builder context; the last commit and the tags never pushed; a verified commit failing its own test; 13 false-positive denials; 33 leaked Docker volumes. Every issue is a step of Phase 8 or a DEFERRED entry. The run branch is not merged yet, as the Accept line requires)
  - Accept: nothing in AutoClaude, its docs or this plan is prepared for that project; whoever builds AutoClaude does not open it. The only preparation is generic: the local-directory install of the plugin is removed from this machine, so the rehearsal installs from GitHub the way a new machine would
  - Accept: onboarding by link: in a Claude Code session in that project, Scott gives Claude only the repo URL `https://github.com/chaoticnewfie/autoclaude` and asks it to add AutoClaude; using nothing but the repo's `README.md` and `docs/USAGE.md`, Claude installs the plugin and the CLI, runs `init`, reviews the project's existing plan and rules with Scott, and writes the AutoClaude plan. Every place it had to guess, or asked Scott something the docs should have answered, becomes a fix to the docs
  - Accept: the run goes all day (D41) with no input; the review afterwards finds one verified commit per completed step on the run branch, no false alarms, every pause justified, nothing done outside the project, and every issue turned into a fix or a backlog item. The run branch is merged only after Scott's review
**CHECKPOINT 7:** Review of the dress rehearsal with Scott, after the run. (2026-09-28: done with Scott in 8 rounds of questions; the release moved to Phase 9, D49.)

### Phase 8: What the rehearsal taught (0.10.0)

Every step here comes from Scott's answers on 2026-09-28 and the rehearsal review (D47 to D49).

- [x] **P8.1** Planning asks and never assumes (D47, D48, D49) (2026-09-29, shown in the P8.9 practice planning: headless, the skill asked 11 announced rounds as numbered text, each question with a recommendation drawn from the repo or the owner's notes, and waited; it decided nothing alone. The scope round listed the only outside work (Docker), offered does-it / write-it / leave-it-out, a snapshot, a never-touch list, then the 8 deny rules as their own approval after a dry run against the real guard (28 blocked, 25 allowed), install limits, secrets and the permission rules. It asked before starting the dev server, gave an estimate from the rehearsal's measured rates, and recorded 39 decisions naming only options shown. Found and fixed on the way: the init skill applied its two setup recommendations when headless instead of asking; it now asks in text too)
  - Accept: `/autoclaude:plan` puts every interview topic to the owner with AskUserQuestion, in rounds of up to 4 grouped by topic, each question with a recommended option drawn from the code or the owner's notes; it decides alone only where the owner says "you decide", and a question asked only in prose that got no answer stays open
  - Accept: the run's scope is always asked: for each item that reaches outside the project folder, "the run does it" (the default), "write it for me" or "leave it out"; what the run must never touch; the proposed deny rules as their own approval question; a snapshot before a change to an existing machine (offered, default yes)
  - Accept: secrets the run needs are generated into a gitignored `secrets/` folder; installing tools and packages, Docker, and creating GitHub repositories are allowed unless the plan says otherwise
  - Accept: planning asks before installing, pulling or starting anything; `docs/DECISIONS.md` records only options the owner actually saw; the estimate uses the rehearsal's measured rates
  - Accept: actions the plan allows outside the project are pre-approved for Claude Code's auto mode, after verifying how permission rules interact with auto mode; the decider and the run rules treat work the plan allows as routine
- [x] **P8.2** Verify once per feature (D49) (2026-09-29: gate.verifyAt "phase" is the default; built steps are committed [~] without checks and the step that closes the feature runs every check, the tester over the phase, the bug bash and the security review, 3 attempts per feature, reports naming the failing Accept lines (test/scenarios/feature-gate.test.js, stop-gate.test.js); run rules for targeted tests pinned by test/unit/run-rules.test.js; fix-up pass closes only with an outcome per finding; the committed tree is the verified one, across cut-off commits too (D51))
  - Accept: with `gate.verifyAt: "phase"` (the new default), `ready` on a step inside a phase commits that step and moves on without checks; the phase's last step runs the full verification (every check, the browser tester over every Accept line of the phase, the bug bash, the security review), with up to 3 attempts per feature and a report naming the failing Accept lines; `"step"` keeps the old behaviour
  - Accept: the run rules tell the builder to run only the tests for what it changed; the full suite runs once, in the gate
  - Accept: non-blocking findings of a feature get a fix-up pass before the feature closes: each is fixed or left for the owner with a reason, then the checks run once more
  - Accept: the tree the checks verify is exactly the tree the gate commits (plan ticks and PROGRESS lines are written before the checks and reverted on failure)
- [x] **P8.3** A fresh builder per feature, lighter paperwork, pushes, effort (D49) (2026-09-29: supervisor tests for the fresh session with rules, feature and progress injected; CONTINUE_HERE per step and doc duties per feature in the run rules (run-rules.test.js); branch and tag pushed per verified feature with a push-failed alert and hand-back line (feature-gate push tests); builder.effort unset follows the owner's default)
  - Accept: after each verified feature the supervisor starts a new builder session with the run rules, the next feature and recent progress injected
  - Accept: the builder keeps CONTINUE_HERE.md current every step and does the project's other doc duties once per feature
  - Accept: with `git.push` true (the new default), the gate pushes the run branch and the phase tag after each verified feature, retrying once; a failed push is alerted and shown in the hand-back
  - Accept: `builder.effort` is optional; unset, the builder uses the owner's own Claude Code default
- [x] **P8.4** Run hygiene from the review (D49) (2026-09-29: the 13 rehearsal false positives are guard test cases and pass; temp deletes resolved; checks use the run's recorded PATH; decide is synchronous with By and Owner review lines; supervisor.json written only on change; --help on every command; checks[i].requires in the preflight; commit bodies carry Accept, checks with durations, decisions and findings)
  - Accept: `guard.deny` matches the command being run, not heredoc bodies or quoted data, and read-only commands on named files pass; recursive deletes inside the OS temp folder pass; the 13 rehearsal false positives are test cases
  - Accept: `autoclaude checks` runs in the gate's environment (the same PATH), so its pass means the gate's pass
  - Accept: the decider runs synchronously; a decision that accepts a security risk is logged with "Owner review: yes"; every D-### says who decided
  - Accept: nothing under `.autoclaude/` changes while the checks run, apart from the checks' own output; the supervisor writes its state only when it changes
  - Accept: `--help` works on every subcommand; a check can name a prerequisite command (for example `docker version`) that the preflight runs; gate commits carry a body (Accept lines, checks with durations, the step's decisions and findings)
- [x] **P8.5** Hand-back and machine footprint (D49) (2026-09-29: HANDOFF.md written, committed and pushed at completion, resumable if cut off (handoff.test.js, stop-gate tests); Docker footprint recorded at start and only project-tied objects the run created removed, the rest reported (footprint.test.js, 22 tests incl. other projects' volumes, engine switch, cold start); completion alert counts only this run's decisions by number (D51))
  - Accept: at plan completion the run writes `HANDOFF.md`: what was built, what is left for the owner with exact commands, secrets it created and where, open findings, owner-review decisions, push state, and the machine footprint
  - Accept: Docker containers, volumes and networks are recorded at run start; at the end the run removes the unused ones it created and reports anything else
  - Accept: the completion alert counts only the run's own decisions and lists owner-review decisions and open items
- [x] **P8.6** Configurable alerts (D49) (2026-09-29: notify.events switches featureVerified (on), stepVerified, runStarted, runResumed, pausedByOwner; the morning summary is notify.morningSummaryAt; critical alerts always sent (notify.test.js, cli.test.js, feature-gate alert tests))
  - Accept: `notify.events` switches each informational alert: feature verified (on by default), step verified, morning summary, run started, resumed or paused by the owner; critical alerts cannot be switched off
- [x] **P8.7** Layered settings and the config page (D49) (2026-09-29: built-in, then <Claude config>/autoclaude/defaults.json, then the project (config.test.js); autoclaude config and /autoclaude:config serve one page on 127.0.0.1 behind a random token with host and origin checks, sections for project, computer defaults, alerts (secrets masked, Show and test buttons), watchdog and status line (configpage.test.js); safe keys live during a run, the rest locked with the reason, and the guard now also denies the builder's own writes to those files)
  - Accept: settings resolve as built-in defaults, then this computer's defaults (`<Claude config>/autoclaude/defaults.json`), then the project's `autoclaude.config.json`; project-only keys (plan, branch, devServer, checks, guard, docs) exist only in the project
  - Accept: `autoclaude config` and `/autoclaude:config` open one scrollable page in the browser, served from this computer only behind a random token, in sections, each setting with its explanation, its default and where its current value comes from: the project's settings, this computer's defaults, the alert channel (secrets hidden with a Show button, a test button), the watchdog and the status line bridge
  - Accept: during a run, safe settings apply at once and the rest are locked with the reason; values are validated before saving
- [x] **P8.8** Docs and version 0.10.0 (2026-09-29: INSTRUCTIONS.md, its template copy, docs/USAGE.md and README.md describe Phase 8 and the verification fixes; released as 0.10.2 after two fix rounds (D51); test/live/gh-install.live.mjs 10/10 against GitHub on 0.10.2; this machine updated in place from 0.9.4 to 0.10.2 with claude plugin marketplace update and claude plugin update, and the launcher followed)
  - Accept: INSTRUCTIONS.md (and its template copy), docs/USAGE.md and README.md describe all of Phase 8; the plugin is version 0.10.0; `test/live/gh-install.live.mjs` passes against GitHub
- [x] **P8.9** Practice run, done by Claude (headless where possible) (2026-09-29, on 0.10.2 installed from GitHub over 0.9.4 in place: planning 13 turns, about 40 min; the run did 7 steps in 2 features in 64 min (Phase 1 30 min, Phase 2 34 min; rehearsal 39 min per step, practice 9). Each feature verified once, then a fix-up pass that handed 2 findings to the owner with reasons; a fresh builder for feature 2; branch and ac-phase-1/2 pushed to the local bare remote after each feature and the hand-back after completion; alerts run started, each step built (switched on through the settings page mid-run, effective at the next step), Phase 1 verified and plan complete; the page refused gate.verifyAt while running (409). HANDOFF.md complete. Footprint: a planted volume tied to the project by its compose name was removed, a planted untied one was left and reported, the running todo-backups container and its network reported with commands, all 36 volumes from before intact. One bug found: the tester's Playwright MCP timed out on connect and the tester failed every line unchecked, which counted as an attempt; fixed in 0.10.3 (browserUnavailable is could-not-run, MCP start timeout 120 s))
  - Accept: on the practice project, the plan skill with scripted answers, then an unattended run of at least two features, one with work outside the project that the plan allows (a Docker container): verified once per feature, a fresh builder per feature, a feature alert, pushes to a local bare remote, HANDOFF.md, the footprint cleanup, and the config page changing a setting during the run

**CHECKPOINT 8:** Show Scott the practice run's hand-back, the alerts received, the config page, and the time per feature compared with the rehearsal. (2026-09-29: held. Scott accepted the choices in D50 to D52 and keeps the fix-up pass as it is; next is P9.1, a second all-day run on the DB project, D53.)

### Phase 9: Rollout and 1.0

- [ ] **P9.1** The DB project's next part on 0.10.0 (2026-10-02: Scott ran it: 36 steps in 12 features, 28 h 40 min, VM 105 created and the stack deployed, alerts received, no pauses or recoveries, 9 of 12 features first time. Measured read-only (docs/SESSION_LOG.md 2026-10-02); the effort findings became D54 (0.10.4). Still open: the full review, every issue to a fix or a backlog item)
  - Accept: Scott re-plans with the new questions (create the new VM and work there, touch nothing else) and the run does it; the review afterwards turns every issue into a fix or a backlog item
- [ ] **P9.2** A second existing repo of Scott's is onboarded the same way
  - Accept: a second existing project has run at least one feature unattended with no false alarms
- [ ] **P9.3** Install on the Windows 11 desktop and confirm an unattended run behaves the same as on the Code VM, including sleep and power settings
  - Accept: the fixture plan passes unattended on the Windows 11 desktop, and the sleep and power settings that matter are written into `docs/USAGE.md`
- [ ] **P9.4** Backlog of later ideas lives in `docs/DEFERRED.md`, each with a trigger; review it and file anything new from the rollout
  - Accept: every later idea raised during the rollout is in `docs/DEFERRED.md` with a trigger, and nothing is left only in chat
- [x] **P9.5** Release 1.0.0 (2026-10-02: released by Scott's decision after his own review of the P9.1 run, ahead of P9.2 to P9.4, which continue after 1.0 (D57). `plugin.json` 1.0.0, tag `v1.0.0`, `CHANGELOG.md`; the repo is public with no license yet (D56))
  - Accept: `plugin.json` version `1.0.0`, git tag `v1.0.0` and `CHANGELOG.md`, after Scott's review of P9.1. No `LICENSE` file for now (D56; the repo is public since 2026-10-02)

**CHECKPOINT 9:** Review of the second DB run with Scott; if it is good, 1.0. (2026-10-02: held. Scott judged the run good and asked for 1.0 now; P9.1's written review, P9.2, P9.3 and P9.4 follow after 1.0, D57.)

### Phase 10: Security and optimize sweeps (1.1.0)

Scott's requests of 2026-10-02 and his answers in seven rounds of questions (D58). Both sweeps run
on one engine; "fix right away" turns confirmed findings into a generated plan that a normal run
fixes and the gate verifies.

- [ ] **P10.1** Sweep engine
  - Accept: `/autoclaude:security` and `/autoclaude:optimize` (and `autoclaude security`, `autoclaude optimize`) start a sweep that runs unattended in its own console window, survives a closed terminal or an RDP disconnect, and picks up where it left off after a crash or restart (finished agents are not rerun)
  - Accept: the sweep splits the project into areas under a size budget and runs read-only headless sessions (Read, Glob, Grep; no Bash) at most `sweep.concurrency` (default 3) at a time, on Opus at `checkers.effort`
  - Accept: it waits for the 5-hour reset when the window is nearly full or a session reports a rate limit, stops at `usage.weeklyPauseAtPct`, and shows an estimate of sessions and time before it starts
  - Accept: a "sweep finished" alert is always sent, carrying counts and the report path only, never finding details
- [ ] **P10.2** Findings, verification and the report
  - Accept: one findings schema for both sweeps: id, category, severity (critical, high, medium, low), CWE (security), CVSS and fixed version (packages), confidence, file and line, redacted evidence, impact, suggested fix with code, test idea, fix tier, fingerprint
  - Accept: with depth "thorough" (the default) every candidate is checked by 3 independent sessions that try to disprove it and kept only on a majority; "standard" uses 1; refuted findings go to an appendix, uncertain ones are never fixed automatically
  - Accept: the report (`report.md` and `findings.json`) goes to a dated folder under the gitignored `.autoclaude/sweeps/`, states what was and was not examined, and no secret value appears in it, in the saved session output or in an alert
  - Accept: findings the owner marks as an accepted risk or a false alarm are kept by fingerprint and reason (no details) in a committed list, and later sweeps list them as accepted instead of reporting them again
- [ ] **P10.3** Security scanners (Node, no model)
  - Accept: secrets are searched in the working tree and the whole git history, with values masked; tracked sensitive files and `.gitignore` coverage are checked
  - Accept: package advisories come from `npm audit --json` and, for other lockfiles, the OSV service, behind a switch (`sweep.advisories`, on by default); a tool that is missing or switched off is reported as "not checked", never as clean
  - Accept: scanners fetched on the fly (npx, or a Docker image when Docker is running) are used when available and never added to the project
- [ ] **P10.4** Security review of the code
  - Accept: one session maps the app (entry points, routes, roles, data stores, trust boundaries); area sessions then review login and sessions, access control (database roles and row-level security included), input handling and injection, output encoding, secrets and data exposure (logging, errors, CORS, CSRF), crypto, and configuration and infrastructure (Dockerfiles, compose, CI, web server config, `.env` handling, open ports)
  - Accept: reviewers respect the project plan's "Constraints & decisions", and triage every scanner hit (reachable or not, real secret or test value)
- [ ] **P10.5** Live attacks on the running app
  - Accept: the targets are chosen per sweep: the local dev server (default), staging URLs the owner names, and production as off, read-only checks or full attacks (with a warning); each kind of test can be switched off
  - Accept: every live request goes through an allow-list: a Node proxy for the browser and the same list for direct HTTP probes; a request to any other host is refused and logged
  - Accept: direct probes check security headers, cookie flags, CORS, exposed files (`/.git`, `/.env`, source maps), verbose errors, routes that answer without a login and rate limiting; a browser session with two test users checks one user reaching the other's data, XSS, CSRF, open redirects and session handling
  - Accept: tests that write data run only when the owner confirms the database is throwaway (ideally with a reset command); test users are signed up by the sweep when the app allows it, otherwise asked for and kept in the gitignored `secrets/` folder, never in a report
- [ ] **P10.6** The questions before a sweep, and setup
  - Accept: the skills ask in rounds with a recommendation each: what to check (all modules on by default), targets and test kinds, test logins, depth, what to exclude, and report only, report plus a fix plan to review, or fix right away (recommended)
  - Accept: a project without proven checks or dev server is set up as planning does it (found, confirmed with the owner, proven to run); "fix right away" refuses until the checks pass on the starting commit
- [ ] **P10.7** Fix right away
  - Accept: confirmed findings (all severities; anything needing the owner listed under "After the run") become a generated plan (`SECURITY_PLAN.md` or `OPTIMIZE_PLAN.md`) on its own branch: phases grouped by area then severity, at most 5 steps each, each with a regression test as an Accept line, security steps tagged `security`, the main plan's "Constraints & decisions" copied in; it passes `lint-plan`
  - Accept: the generated plan words every fix neutrally and points to finding ids in the gitignored report; no exploit detail reaches a commit, a pushed file or an alert
  - Accept: `autoclaude run --plan <file>` runs that plan with every gate check, leaves the project's own plan and its state alone, and is refused while another run is running or paused; "report plus a fix plan to review" writes the plan and stops
- [ ] **P10.8** Optimize: baseline and scanners
  - Accept: before any finding is acted on, a baseline is recorded: each check's and each test file's time, flaky tests found by rerunning, build time, bundle size (gzip), package count, dev-server start time, and per page load time and request count from the browser
  - Accept: unused code, packages and duplicates are found with tools fetched on the fly (for example knip, jscpd, `npm outdated`), at pinned versions, plus git churn hotspots; something is "unused" only when a tool flags it, a search of the whole repository (scripts, CI, manifests, config, docs) finds no reference, and it matches no entry-point convention of the stack
- [ ] **P10.9** Optimize: review and safe changes
  - Accept: sessions review unused code and packages, duplicates and leftovers, performance (measured before and after, an improvement claimed only above the noise), poorly built features (a written rubric), and the test suite's speed and flakiness, never weakening a test
  - Accept: a rebuild or other behaviour-sensitive change comes as two steps: first tests that pin the current behaviour (they pass on the unchanged code), then the change, with an Accept line that the pinned tests were not edited and the browser shows the same pages
  - Accept: a real bug found while optimizing is fixed with a test and listed in the hand-back as a behaviour change; minor and patch upgrades are made, major upgrades and changes to a database shared with other apps are report-only
- [ ] **P10.10** Disclosure and the browser checkers
  - Accept: in a new project, security findings from normal runs go to a gitignored file, never to a committed one; an existing project with a committed findings file is offered the move in the sweep's and planning's questions
  - Accept: no browser checker (tester, bug bash, sweep) can use Playwright MCP's arbitrary-code tool, and Playwright MCP runs at a pinned, tested version (closes DEFERRED 17)
- [x] **P10.11** Docs and version 1.1.0 (2026-10-04: INSTRUCTIONS.md section 15 and its template copy, USAGE.md section 17 and the settings rows, README, CHANGELOG; released as 1.1.0)
  - Accept: INSTRUCTIONS.md (and its template copy), docs/USAGE.md, README.md and CHANGELOG.md describe both sweeps, their questions, reports, fix mode and safety limits; the settings page shows the sweep settings; the plugin is version 1.1.0
- [x] **P10.12** Proof on the practice app, done by Claude (2026-10-04, on 1.1.0-rc.3: planted problems in spikes/out/todo-live (spikes/lib/prep-sweep-practice.mjs). Security: /autoclaude:security asked 5 rounds plus a go, fixed the setup itself, swept in 31 min (75 verifier sessions), confirmed 24 findings incl. every planted one plus real extras, and its report lists what was not examined; fix right away ran 18 of 18 steps in 6 features in 2 h 5 min on autoclaude/security-fixes-2026-10-04-0010 with every gate check, pushes, alerts and HANDOFF-SECURITY.md, the project's own plan and state restored after (one pause on the planted flaky test, resumed). Optimize: /autoclaude:optimize, report plus a plan to review, 31 min, 25 confirmed incl. every planted problem still present (the slow route had been fixed by the security run) plus real bugs, a 31-step plan that lints and fits, with pinned two-step changes and a baseline. Proxy log: 0 requests allowed outside the target, 69 refused. No Docker object created; ~/.claude.json valid)
  - Accept: the practice app gets planted problems (security holes of several kinds, a secret in its git history, unused files and packages, duplicated code, a slow path, a flaky test); a thorough security sweep and an optimize sweep each find the planted problems that are in scope, and their reports say what was not checked
  - Accept: "fix right away" fixes them through a normal run that the gate verifies, on its own branch; the proxy log shows no request outside the allow-list; nothing that existed before the sweep outside the project is changed

- [x] **P10.13** Phases small enough to verify in the time a verification has (D60) (2026-10-04: built, reviewed, 782 then 805 tests; live: a headless /autoclaude:plan on spikes/out/plan-practice with gate.timeoutSec 660 measured the checks, estimated each part with the gate's rules, kept a 19-line feature as one phase, then split a 48-line feature into 3 phases by itself and told the owner which and why; lint-plan confirms all fit; it also reasoned that at 300 s no split could help, since the bug bash alone needs 420 s)
  - Accept: the gate spreads one feature's verification over turns: it runs the checks, the browser tester, the bug bash and the security review in one turn when they fit, and when the time left is short it carries the rest to the next turn (the builder is told to end its turn); a carried-over stage is never counted as a cut-off, a change to the files between turns starts the verification again, and small phases take no extra turns
  - Accept: once the checks pass, the security review runs at the same time as the browser tester and bug bash (which stay one after the other: they share the dev server); a failed check starts neither (D61)
  - Accept: every verification and `autoclaude checks` record each check's time, and estimates use the recent times
  - Accept: `autoclaude lint-plan` and `autoclaude run --check` estimate each phase's verification (each check, the browser tester by its Accept lines, the bug bash, the security review) and warn about a phase whose biggest single part needs more than `gate.fitPct` (default 70) percent of the verification time, naming the phase and the fix
  - Accept: planning measures the checks, estimates every phase, and splits a phase that does not fit into smaller features by itself, telling the owner what it split
  - Accept: `autoclaude verify-per-step <phase>` marks a phase to be verified step by step (`gate.stepPhases`); the out-of-time alert names that command, and `autoclaude resume` carries on without the plan being rewritten

- [x] **P10.14** Flaky checks and report polish, from the live proof (D62) (2026-10-04: rerun of a failed check, flaky reporting, merged duplicates, scanner titles, plain baseline labels; replayed on the proof's outputs: security 25 to 24 findings, optimize 26 to 23)
  - Accept: when a check fails, the gate runs it once more before counting an attempt; a check that then passes counts as passed, is reported as flaky in the verification report, the commit body and HANDOFF, and a real failure (failing twice) counts as before
  - Accept: a sweep merges findings about the same problem in the same file when one is file-level and the other names a line (the proof's OPT-007/013 and OPT-019/023 become one each), and every finding from a scanner has a title
  - Accept: the optimize report's baseline table uses plain labels, not raw field names

**CHECKPOINT 10:** Show Scott both reports, the fix run's hand-back, the alerts, and the time and usage each sweep took. (2026-10-04: held. Scott chose: rerun a failed check once, polish the reports before 1.1.0, keep D59 and the D61 addendum, a quick live test of phase sizing before the release; D62.)

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
# once per machine (D41, D42: a private repo, so git needs read access to it)
claude plugin marketplace add chaoticnewfie/autoclaude
claude plugin install autoclaude@autoclaude
node <plugin folder>/bin/autoclaude.js install-cli   # adds `autoclaude` to your user PATH
autoclaude notify-setup --discord <webhook>      # or --ntfy <topic url>
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
