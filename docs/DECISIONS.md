# DECISIONS

A dated log. Each entry: the decision, why, and what was rejected. Append, never rewrite; a
reversed decision gets a new dated entry pointing at the old one. The draft's D1 to D16 live in
`PLAN.md` section 3 and are edited in place there when Phase 0 or Scott changes them, with the
change logged here.

Add an entry whenever a real alternative was rejected. "Postpone it" belongs in `DEFERRED.md`.

---

## 2026-09-26 - Revising the plan before Phase 0

Context: the plan was drafted on 2026-09-24 assuming a Debian LXC with tmux and systemd. On
2026-09-26 Scott moved all development to a Windows Server 2025 VM, asked for pure Windows support
(also Windows 11), approved a pause-for-review feature, and said the repo will be shared with other
people and used on other devices.

### D17 The name is autoclaude

**Decision.** Plugin, CLI, skills, config file and runtime folder are all `autoclaude`:
`/autoclaude:init`, `autoclaude run`, `autoclaude.config.json`, `.autoclaude/`. Git tags
`ac-<phase>`, console window `ac-<project>`, statusline prefix `AC`.

**Why.** The GitHub repo is `chaoticnewfie/autoclaude`. One name everywhere.

**Rejected.** Keeping `autopilot` from the draft. Nothing depended on it.

### D18 A Node supervisor replaces tmux and systemd

**Decision.** `autoclaude run` starts a small Node supervisor in its own console window. The
supervisor spawns the interactive `claude` session as a child with inherited stdio, polls the
heartbeat, the idle marker, the StopFailure log and the usage file every 60 s, and recovers by
ending the child and relaunching `claude --continue "/autoclaude:resume"`. That single operation
replaces both the tmux `send-keys` nudge and the crash relaunch. A scheduled task (Windows Task
Scheduler; cron or a systemd timer elsewhere) is only a backstop that relaunches a dead supervisor.

**Why.** Scott works only on Windows (Server 2025 and 11) and asked for pure Windows with no WSL.
tmux does not exist there, and scraping a console screen is fragile. Session state already reaches
the hooks (heartbeat, `idle_prompt`, StopFailure, SessionEnd), so the supervisor never needs to
read the screen. Restart-with-prompt loses nothing: all state is in files and `--continue` resumes
the conversation. The same code runs on Linux and macOS, where tmux becomes an optional way to
attach and watch.

**Rejected.** WSL2 (Scott wants pure Windows). node-pty for a real pseudo-terminal (a native
dependency that breaks "built-ins only" and complicates sharing). A `claude -p` loop (no
auto-continue at usage limits, no usage data). Reading the console buffer through Win32
(`AttachConsole` and `ReadConsoleOutput` need a compiled helper or P/Invoke from PowerShell).

**Consequences.** PLAN.md D3, D8, D9, sections 4.1, 4.2, 4.3, 4.7, 4.9, 6.1, 6.6 and steps P0.1,
P0.8, P0.10, P1.4, P6.3, P6.4, P6.6, P8.2 updated. Windows facts to design around: an RDP
disconnect keeps the window alive, a log-off or a sleeping machine does not; `taskkill /T` is
needed to end a process tree; `fs.rename` over an open file fails and needs a retry.

### D19 Pause for review

**Decision.** `autoclaude pause` (or `/autoclaude:pause` in the session) sets `pauseRequested`;
the gate pauses after the next verified commit, so the tree is always clean when Scott looks.
`pause --now` pauses immediately. `autoclaude note "<text>"` appends a dated entry to
`docs/REVIEW_NOTES.md` and marks it pending. `autoclaude resume` injects pending notes as owner
feedback through the SessionStart context, and Claude records how it handled each one in
`docs/DECISIONS.md` (`N-###` entries). Config `review.pauseAt` is `never` (default), `phase-end`
or `every-step`. Every pause sends a default-priority notification saying where it stopped.

**Why.** Scott wants the option to look over progress and steer, without it being required.
Pausing at a clean point keeps the one-commit-per-verified-step guarantee.

**Rejected.** Pausing mid-step by default (leaves a half-done tree). Notes only in the chat
transcript (lost across machines; his rule is that everything lives in the repo).

**Later.** A pause button on the phone. See `DEFERRED.md`.

### D20 Built to be shared

**Decision.** No personal facts in plugin code, templates, `README.md` or `docs/USAGE.md`.
Per-machine values (notification channel and tokens) live in plugin userConfig; per-project
values in `autoclaude.config.json`. Docs are written for someone who is not Scott. Users need
their own Claude subscription, because auto-continue and usage percentages depend on one.

**Why.** Scott: "It may be used on other devices, and likely by other people by sharing the
github."

**Open.** A license (MIT is the suggestion) and whether the repo goes public.

### D21 Conventions adopted

**Decision.** From `CONVENTIONS_SURVEY.md` section 2: all except 10 (the cold-start doc, which
Scott dropped), with 15 reworded to "reasonable fan-out, and stop agents when done". These are
the rules in `CLAUDE.md` and the basis of `project-template/`.

### D22 Models are config aliases

**Decision.** `tester.model` and `security.model` stay Claude Code aliases such as `sonnet` and
`opus`, which Claude Code resolves to the current model of that tier. The builder uses the
session model. Nothing pins a dated model id.

**Why.** The draft named specific models. Scott mostly runs Opus on a Max plan and the family
changes; aliases follow the current models with no code change.

### D23 One `init` for new and existing projects

**Decision.** `autoclaude init` writes the missing pieces of the doc set from `project-template/`
into any folder, empty or not, and never overwrites a file that exists. A new project is "run
init in an empty folder"; an existing project is "run init in the repo".

**Why.** Scott asked for both paths. Making them the same command means one thing to test.

**Rejected.** A GitHub template repo for new projects (a second thing to keep in sync).

### D24 Doc file locations in target projects follow Scott's convention

**Decision.** Defaults: `PROGRESS.md` (gate-written, root), `CONTINUE_HERE.md` (root),
`docs/DECISIONS.md`, `docs/BLOCKERS.md`, `docs/SECURITY-FINDINGS.md`, `docs/REVIEW_NOTES.md`,
`docs/SESSION_LOG.md`. All configurable under `docs` in `autoclaude.config.json`.

**Why.** His DB and Lists repos keep the logs under `docs/`; the draft put them at the root.

### D25 The context prompt asks Claude to rewrite CONTINUE_HERE.md before `ready`

**Decision.** `prompts/context.md` tells the builder to rewrite `CONTINUE_HERE.md` before running
`autoclaude ready`. A prompt rule, not a gate check.

**Why.** It is Scott's standing rule in every repo and costs nothing. A hard gate check would fail
steps over a docs nit.

### Open (Scott to decide)

- License and public versus private (D20).
- Whether `project-template/` also ships the fuller docs set (ARCHITECTURE, DATA_MODEL, API,
  DEPLOY) as empty stubs. Default until told otherwise: core files only, and `init` offers the rest.
