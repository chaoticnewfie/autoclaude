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

---

## 2026-09-26 - Phase 0 findings (details in `VERIFY.md`)

### D26 Claude Code background sessions are not the runner

**Decision.** The runner stays an interactive `claude` under our supervisor in a console window
(D18). `claude --bg` background sessions are not used.

**Why.** They looked ideal: a built-in supervisor daemon, no terminal needed, survive terminal
close and machine sleep, restart crashed processes, Windows supported, `claude agents --json`
for state. But the agent-view docs say **Stop hooks do not run in background sessions**, and the
gate is a Stop hook. They also do not auto-continue at usage limits (the session waits for a
reply), and they isolate edits into a worktree unless `worktree.bgIsolation` is `none`.

**Rejected.** Rewriting the gate around another hook (PostToolUse cannot decide when a step is
"ready"). Kept as a revisit trigger in `DEFERRED.md`.

### D27 Two usage sources, statusline first

**Decision.** The usage gate reads `~/.claude/autoclaude/usage.json` (written by the statusline
bridge, `rate_limits.*.used_percentage` and `resets_at`) and falls back to
`~/.claude.json` -> `cachedUsageUtilization.utilization.{five_hour,seven_day}` (`utilization`,
`resets_at`, `fetchedAtMs`) when the statusline has not run yet or its file is stale.

**Why.** The statusline only runs in interactive sessions and only after the first API response;
`cachedUsageUtilization` is refreshed by any session and needs no terminal. Both are read-only
for us.

**Amended 2026-09-27.** `cachedUsageUtilization` disappeared from `~/.claude.json` after an
interactive session rewrote the file, so it is present only sometimes. The statusline bridge is
the source the usage gate depends on; the cached key is a fallback when it happens to exist, and
"no data" means unknown (one log warning, never a pause).

### D28 Onboarding and workspace trust are checked, never written

**Decision.** `autoclaude start` reads `hasCompletedOnboarding` and
`projects[<repo root>].hasTrustDialogAccepted` from `~/.claude.json`. If either is missing it
refuses to start and tells the user to run `claude` once in the project, pick a theme, accept the
trust dialog and exit. The tool never edits `~/.claude.json`.

**Why.** The first interactive run of the native CLI shows a theme picker and then the trust
dialog, and an unattended session sits on them forever (Phase 0 screenshot). Writing those keys
from a session was denied by the auto-mode classifier as self-modification, and a tool other
people install should not silently grant trust to a folder either.

**Rejected.** Editing `~/.claude.json` from `init` or `start`.

**Observed key format (2026-09-27).** After Scott's one-time run the file holds
`hasCompletedOnboarding: true` and `projects["C:/AutoClaude"].hasTrustDialogAccepted: true`:
the repository root with forward slashes. The preflight matches that form.

### D29 Hooks use exec form, and `node` must be on the claude process PATH

**Decision.** Every `hooks.json` entry is `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/<x>.js", ...]}`.
`init` and `start` check that `node` resolves on the PATH the claude process will have.

**Why.** Exec form spawns `node.exe` directly with `${CLAUDE_PLUGIN_ROOT}` expanded in `args`
(verified, including a path with a space) and needs no shell. Shell form runs under Git Bash on
Windows, or PowerShell when Git Bash is absent, with profile output risks. `node` was not on the
PATH of shells opened before it was installed, which is the failure the check catches.

### D30 Nested runs use `--settings '{"disableAllHooks":true}'`, never `--bare`

**Decision.** Tester and reviewer are `claude -p ... --settings '{"disableAllHooks":true}'`.

**Why.** Verified from inside a Stop hook with the parent's environment inherited: hooks were
disabled in the child (no recursion), `--json-schema` returned `structured_output`, and the
subscription login was used. `--bare` also skips keychain and credential reads and the run
failed with `is_error: true`. Stripping `CLAUDE*` variables made no difference and is not done.

### D32 Notification settings live in a per-machine file as well as in plugin userConfig

**Decision.** `autoclaude notify-setup` writes `<claude config dir>/autoclaude/notify.json`
(`channel`, `ntfy_url`, `ntfy_token`, `discord_webhook`, file mode 600 where the OS honours it).
`resolveChannel` reads explicit options first, then the `CLAUDE_PLUGIN_OPTION_*` environment,
then that file. The SessionStart hook (Phase 2) mirrors the plugin userConfig values into the
file so either way of configuring works everywhere.

**Why.** Plugin userConfig reaches only hook processes as environment variables; sensitive
values go to the OS secure store, which Node built-ins cannot read. The CLI (`notify-test`,
`status`) and the supervisor are not hook processes and still have to notify. Verified
2026-09-27: a Discord webhook set with `claude plugin install --config discord_webhook=...`
is absent from `settings.json` (good) and invisible to the CLI (the gap).

**Rejected.** Reading the OS credential store (native code or PowerShell on every call).
Sending every notification through a hook process (the supervisor would need a session).
Storing the channel in the project (secrets in repos, and it is per machine anyway).

### D33 Resume continues the current step, notes first, and honours owner edits to the plan

**Decision.** `state.json` holds `currentStep` and its attempt count; `PLAN.md` holds what is
verified. On resume the SessionStart injection gives Claude the current step's text and every
pending note under "act on these first", so the run continues the step it was on, shaped by the
notes. While paused the owner may also edit `PLAN.md` freely, including unticking a verified step
to have it redone. On resume the gate re-baselines its record from the plan as the owner left it:
a step the owner unticked leaves `tickedByGate`, and `currentStep` becomes the first unfinished
step in document order if the old one no longer exists or is no longer first. Lint still has to
pass.

**Why.** Scott asked how the run knows where it is after a pause and notes (2026-09-27). The
answer has to be "exactly where the files say", not "wherever Claude remembers", and the owner
needs a way to send the run back to a step without editing state files by hand.

**Rejected.** Treating an owner untick as an integrity violation (the integrity check is for
Claude ticking boxes during a run, not for the owner during a pause). A separate "redo step"
command (the checkbox is the interface everyone already understands).

### D34 Two CLI shims on Windows, and the tool guard only blocks real writes

**Decision.** `install-cli` writes an extensionless `autoclaude` sh script on every OS and, on
Windows, `autoclaude.cmd` as well. `cliCommand()` reports `autoclaude` only when the sh shim is
on PATH. The tool guard's shell rules deny a command only when a write operator (redirect, tee,
in-place sed, PowerShell writer, delete, move, copy-as-destination) targets a protected path.

**Why.** Seen in the first live run (2026-09-27): Claude's Bash tool on Windows is Git Bash,
which does not resolve `.cmd` files by bare name, so the builder had to find the CLI by hand; and
the guard denied `cat autoclaude.config.json` and `cat .autoclaude/state.json` because a
`2>/dev/null` elsewhere on the line looked like a write. Both cost the builder a turn and would
confuse anyone reading the denial log.

**Rejected.** Telling the builder to always use the node invocation (ugly in every prompt and
log). Denying every command that mentions a protected path (reading them is legitimate).

### D35 How the browser checks are judged (Phase 4)

**Decision.**
- The tester runs for every step not tagged `no-ui`, after the deterministic checks pass. The bug
  bash runs at a phase's last step, only if the phase has at least one UI step.
- A step fails on a "fail" verdict, any failing criterion, or any high-severity bug. Medium and
  low bugs, and possible weakened tests (`testConcerns`), never fail a step: they become rows in
  `docs/BLOCKERS.md`, committed with the step.
- An answer that is not a usable verdict (timeout, crash, error result, no structured output, a
  tester verdict with no criteria) is an infrastructure failure. It is retried once inside the
  same stop when the gate deadline allows, never counts as an attempt, and the second such stop
  for the same step pauses the run (`infra`) with a high-priority notification.
- Before each verification the gate restarts a dev server it started, so the checks and the
  tester never see code from before the builder's last edit. A server someone else started is
  reused and the report says so.
- Each run gets its own Playwright MCP config: the project's `.autoclaude/mcp.playwright.json`
  plus `--headless`, `--isolated` (fresh in-memory browser profile) and `--output-dir` at the
  attempt's report folder, where the screenshots land. Tools: Playwright MCP, Read, Glob, Grep.
- The prompt goes to `claude -p` on stdin (verified), so plan text of any length or content is
  safe.

**Why.** A weakened test is a real risk (PLAN.md section 7), but a language model flagging one is
not reliable enough to burn attempts on; the tester checking the Accept lines in the browser is
the actual guard, and the diff review arrives with the security reviewer in Phase 5. A broken
browser setup is not the builder's fault, but looping on it overnight wastes the night, so it
pauses after the second stop.

**Rejected.** Letting medium bugs fail a step (attempts spent on polish). Sharing one browser
profile across runs (state leaks between attempts). Passing the prompt as an argument (Windows
command-line limit, quoting).

### D36 The dress rehearsal runs on Scott's DB project, onboarded from the repo link

**Decision.** P7.3 is an overnight run on `chaoticnewfie/DB` (`C:\Database`) instead of a
12-step fixture plan. It starts the way another person would start: in a session in that project,
Scott gives Claude the autoclaude repo URL and asks it to add AutoClaude; Claude follows only the
repo's README and usage guide. Conditions:
- **Local work only.** The DB repo has scripts that create ZFS pools and VMs, and the Code VM has
  a root SSH key to the Proxmox host. The plan's scope excludes Proxmox, the VM, deploys and
  secrets, and a new per-project `guard.deny` list (P5.3) blocks `ssh`, `scp`, `qm`, `pct`,
  `zpool`, `zfs` and the repo's `proxmox/` and `vm/` scripts during the run.
- **Docker first.** Most of the DB's next work is SQL. Without Postgres the gate can only check
  TypeScript, so WSL2 and Docker Engine go onto the Code VM with Scott beforehand (his machine
  notes already plan exactly that for Docker on Windows Server).
- **A fresh install path.** The local-directory install is removed first, so the plugin comes from
  GitHub; two installs of the same plugin would run every hook twice.
- **The DB's own rules win where they should.** Its `PLAN.md` is a historical spec, so the
  AutoClaude plan gets its own file (`plan` in the config). Its `CLAUDE.md` gains an AutoClaude
  section agreed with Scott, because its "commit and push after every change" rule conflicts with
  the gate committing and pushing being off during a run.
- **Size by the work.** The plan has as many 20 to 90 minute steps as the local work needs.

**Why.** Scott: the tokens get spent either way, so spend them on his next real project, and it
tests integration into an existing repo. The link-only onboarding also tests the shareability
requirement (R14) with the real docs.

**Rejected.** The fixture rehearsal: known expectations, but it tests nothing about existing
projects or onboarding. Letting the run include VM or Proxmox work: irreversible, and the key to
do it is on this machine. The browser tester gets little use here (the DB work is mostly no-ui);
the fixture's live UI scenario (P4.5) already covers it.

**Note.** The repo is private. Onboarding by link works on this machine because the GitHub CLI is
logged in; anyone else needs the repo shared or public (D20, still open).

### D37 The rehearsal is a blind test (supersedes the project-specific conditions in D36)

**Decision.** Scott, minutes after D36: "dont look at that project at all either. I want to test
it without you specifically preparing it for that project specially." So:
- Nobody building AutoClaude opens the DB project or tailors anything to it. D36's project-specific
  conditions (a Docker prerequisite, named deny rules, where its plan goes, a section for its
  `CLAUDE.md`) are withdrawn. Whatever that project needs is for the Claude session in it to work
  out from the repo link and the docs, with Scott, which is the point of the test.
- The generic lessons stay, stated for any project: a per-project `guard.deny` list (P5.3),
  and a plan review for existing projects that settles where the plan lives, conflicts with the
  project's own rules, what the run must never touch, and missing tools for the check commands
  (P7.1). These are what a stranger's existing project needs too.
- The only preparation on this machine is generic: remove the local-directory plugin install so the
  plugin comes from GitHub as it would on a new machine.

**Why.** A rehearsal the builder has prepared for proves the builder's knowledge, not the
product's. The value is in finding what the docs and the planner miss.

**Kept from D36.** The rehearsal runs on the DB repo, overnight, sized by the work, onboarded by
link; the branch is merged only after Scott's review; the repo is private, so the link works here
through the logged-in GitHub CLI and D20 remains open for anyone else.

### D38 Guardrail details settled in Phase 5

- **Every permission prompt during a run is denied, never approved.** The hook cannot judge what
  is safe better than auto mode's classifier did; denying with guidance keeps the run moving
  without widening what it may do. Past 10 denials in an hour (permission prompts and tool-guard
  blocks together) the owner gets one high-priority message per hour.
- **Hooks never write notification text to stdout.** `notify()` falls back to stdout when no
  channel is set; inside a hook that would corrupt the JSON answer, so hooks pass a no-op sink.
- **The owner's answer is a decision.** `autoclaude answer` appends the next `D-###` with the
  question and the answer, resets the step's `[?]`, resumes, and hands the answer to the builder
  twice: at session start and at the top of the gate's next message. Seen live (2026-09-27): Scott
  typed the answer into the run's own window instead of a terminal; the builder recorded it with
  `autoclaude answer` itself and carried on. Both paths are supported.
- **Owner input is delivered once and cleared when its step passes.** Delivery is either the
  session-start injection or the top of a gate message, whichever comes first; the injection keeps
  repeating it after a compaction until the step passes. Notes not yet delivered stay pending, so a
  note left during a review pause reaches the next step. (First version counted only gate
  messages; live, a note injected at session start stayed pending after its step passed.)
- **Resume trusts the plan as the owner left it** (D33 made concrete): the first unfinished step
  in plan order is where the run continues; owner ticks and unticks become the record; a failed or
  blocked step gets fresh attempts.
- **A step that fails three times on the security review pauses as `security`,** not
  `step-failed`, so the notification says what kind of problem it is.
- **The decider runs in the foreground.** Live, the builder started it in the background and
  spent turns waiting; the context prompt now says to wait for its reply.

### D39 An idle session does not page the owner; the supervisor fixes it

**Decision.** The Notification hook writes every notification to `.autoclaude/idle` for the
supervisor. It pages the owner (high, at most once per 30 minutes) only for prompts that wait for
a person: `permission_prompt`, `agent_needs_input`, `elicitation_dialog`. `idle_prompt` alone is
a marker; the supervisor relaunches the session after `supervisor.idleRelaunchMin` and pages only
when two relaunches make no progress (pause as stuck).

**Why.** PLAN.md P6.1 as drafted paged for `idle_prompt` too, but with a supervisor that recovers
idle sessions in minutes those pages would be false alarms, against the "Quiet" success
criterion and R10. A prompt waiting for a person means the PermissionRequest hook did not catch
something, which is worth a page.

### D40 Supervisor details settled in Phase 6

- **Everything it decides from is a file** (heartbeat, idle marker, `failure.json`, the gate's
  `gate.json`, `nudge.json`, usage, state), plus `claude agents --json` only when activity is
  stale. The decision is one pure function (`decide`), unit-tested rule by rule.
- **It never prints while the session is alive**; the session owns the console. It logs to
  `.autoclaude/logs/supervisor.log`.
- **The gate keeps `gate.json` (with its pid) while it works**, so a 20-minute verification is not
  mistaken for a stall; a marker whose pid is dead is ignored and removed.
- **`autoclaude nudge "<prompt>"`** asks the supervisor to restart the session with that prompt
  now (for example `/compact`). It is an owner request, not a recovery, so it does not count
  towards the stuck limit. Added because the chaos tests need a forced compaction and nothing else
  can inject a prompt into a running session.
- **Relaunch is always `claude --continue --permission-mode auto "<prompt>"`**, which resumes the
  same conversation; the builder's environment drops a parent session's `CLAUDE_CODE_*` variables
  and keeps `CLAUDE_CONFIG_DIR`.
- **`run` and `start` share one preflight.** `run` on a run that is already under way (after a
  reboot or a closed window) checks only tools and trust, because mid-step the tree is dirty.
- **A second supervisor refuses to start** while a live one is recorded.
- **Trust lookups compare real paths,** because Windows can name one folder by its 8.3 short form
  and its long form (found by a test, not by guessing).
- **Found by the live chaos run and fixed the same day:**
  - A nudge waits while the gate is verifying. The first forced `/compact` landed two seconds
    into a verification, killed it and threw away the builder's `ready`.
  - When a nudged prompt ends at the idle prompt, the supervisor goes straight back to the plan
    (`continue`, not counted as a recovery). Before, a compacted session sat idle until the idle
    or stall rule fired, which is 15 to 45 minutes with the default settings.
  - `autoclaude nudge` undoes Git Bash's path conversion: from Git Bash, `"/compact"` arrives
    as `C:/Program Files/Git/compact` and was sent to Claude as that text.
  - `/autoclaude:start` prints the run rules after starting. The first session of a run never
    had them, because SessionStart fires before the run exists.
  - Only a resume from a pause starts the "did not pick it up" timer; the change from idle to
    running is the session's own start, already in progress.
  - The watchdog leaves a run alone when its supervisor pid is missing or its state is more than
    24 hours old (logged as `stale`). It had revived a scratch project abandoned in Phase 5.
  - A verification the supervisor has seen running counts as activity. Without it, a nine-minute
    phase-end verification looked like nine silent minutes, and the session was relaunched two
    seconds after the gate answered, which lost the answer.
  - The checkers state their turn budget in the prompt. A checker that still runs out of turns is
    resumed once (`--resume`, 4 turns) and asked for its structured answer from what it has
    seen. The phase-end bug bash had explored for all 60 turns on both tries, and the gate threw
    both runs away as machine failures. The resume was checked live before relying on it.
    Live afterwards: the bug bash used its 60 turns again, and the resume got a pass verdict
    with two follow-ups in 3 more turns.
  - A step that passes but cannot be committed pauses the run (`commit-failed`, a high page),
    and `autoclaude resume` commits the pending steps before the session restarts. The run
    window had inherited a PATH without git: the last step was reported verified and the plan
    complete with nothing committed. Preflight now checks git on PATH even for a run already
    under way.
- **After the plan completes, the window stays open with the session idle,** so the owner can
  ask it about the run. An idle session uses no tokens; the supervisor ends when the owner
  closes the session or the window.

### D31 The launcher spawns `cmd start` from Node, and the supervisor polls `claude agents --json`

**Decision.** `autoclaude run` opens the window through Node's `spawn("cmd.exe", ["/d","/s","/c",
"start \"ac-<slug>\" /D <dir> node ..."], { detached: true, stdio: "ignore" })` and `unref()`s
it. The supervisor polls `claude agents --json` (interactive sessions appear with `kind:
"interactive"` and a `status`) next to the heartbeat and idle marker.

**Why.** Launching from Git Bash mangles `/D` into `D:/` (MSYS path conversion) and an unquoted
`start` title is taken as the program; both hung `cmd` on an error dialog. From Node with a
quoted title it worked first time, and the window outlived the launching shell. Three
spawn, `taskkill /T /F`, relaunch cycles left no orphan `claude.exe`.

### D41 Private repo, shared by invitation; the rehearsal runs all day (2026-09-27)

**Decision.** The repo stays private. Scott gives chosen people access as GitHub collaborators.
There is no LICENSE file; P7.4 ships without one. The docs explain installing from a private
repo: the marketplace is added with the owner/repo shorthand, and git needs credentials that can
read it (the GitHub CLI logged in, or an SSH key on the account). The P7.3 rehearsal runs during
the day instead of overnight.

**Why.** Scott: "I'm going to keep it private and give certain people access. It's the morning
now but I can let it run all day when it's time." This settles the open item in D20.

**Rejected.** MIT and a public repo (the D20 suggestion).

### D42 Everything the plugin needs ships inside the plugin folder (2026-09-27)

**Decision.** `project-template/` moves into `plugins/autoclaude/project-template/`. The CLI shim
and the watchdog task call a small launcher kept in the machine's AutoClaude bin folder. The
launcher finds the current install from Claude Code's plugin records each time it runs. The
marketplace is renamed from `autoclaude-local` to `autoclaude`, so the install command is
`autoclaude@autoclaude`.

**Why.** Found while writing the install docs. A marketplace install copies only the plugin
folder into a cache folder named after the version. `init` read the template from the repo root,
so it would have failed on every machine except this one. The shim and the watchdog stored that
versioned path, so they would have broken after the first plugin update. A directory
marketplace, which is how this machine ran every live test, hides both problems because it loads
the plugin from the clone.

**Rejected.** Copying the template into the machine folder at install time: there is no install
hook, and a stale copy would outlive plugin updates.

### D43 Fixes from the Phase 7 review, before the rehearsal (2026-09-27)

Six reviewers (two fact-checkers, a newcomer reading only the docs, two dry runs of the plan
skill on scratch projects, and a completeness critic) found these; four agents fixed them.

- **The builder is one known session.** The supervisor starts it with
  `claude --session-id <uuid>`, stores the id in state, and relaunches with `--resume <id>`
  (supersedes "relaunch is always `--continue`" in D40, which could continue a person's own
  session opened in the same folder). The builder's environment carries `AUTOCLAUDE_BUILDER=1`.
  While a supervisor is alive, every hook ignores any other session in the project: no rules
  injected, no gate on its stops, no guard, no heartbeats. Without a supervisor (a run started by
  hand) any session is the builder, as before. A `--resume` that dies within 30 seconds (no
  conversation saved yet) is followed by a fresh session under a new id. Both flags were checked
  headless before relying on them.
- **The guard covers the PowerShell tool.** On Windows the builder also has a PowerShell tool,
  which the PreToolUse matcher did not list, so every rule, `guard.deny` included, could be
  bypassed through it. The guard patterns were hardened (git global options, `+refspec` and
  `--mirror`, split `rm` flags, quoted paths, deletes judged against the project root, the
  `.autoclaude` folder itself, `git checkout`/`git restore` of the plan). They remain best-effort
  text checks; a standard user account is the real boundary.
- **Paths with spaces.** The tool guard compared a URL-encoded path to decide whether it was the
  entry script, so under a profile such as `C:\Users\John Smith` it silently did nothing. All
  entry checks use `fileURLToPath`; a scenario test spawns the guard from a copied plugin folder
  with a space and a tilde in its path.
- **`pause --now` ends the session.** Before, it only changed the state, and the builder carried
  on through its turn with every guard off. Now the supervisor ends the session and the dev
  server stops; resume relaunches it.
- **A finished plan can be continued**: add steps, commit, `autoclaude run`.
- **Preflight fits new projects**: Chromium only when a dev server is configured; a dev server
  that does not start yet is a warning when the next step is `no-ui`; a `needsDevServer` check
  without a dev server fails; tmux is required on Linux and macOS (the background mode gave the
  interactive builder no terminal).
- **Lint checks more**: unknown tags, `ui` with `no-ui`, `no-ui` steps without `Test:`, id and
  phase order, duplicate or empty phases, template placeholders, TBD and TODO in steps.
- **The security reviewer sees the plan's Constraints & decisions**, so a documented design
  choice (no login on a local-only app) is not failed as a high finding on every attempt.
- **One decision entry format**: `## D-### (YYYY-MM-DD, step) title` with Question, Choice, Why,
  Rejected, Reverse by; `autoclaude answer` writes the same, and the template's example no
  longer makes the first real id D-002.
- **New commands** the plan skill relies on: `autoclaude run --check` (preflight only),
  `autoclaude checks` (the checks exactly as the gate runs them, in cmd.exe on Windows), and
  `autoclaude guard-test "<command>"`.
- **The plan skill was rewritten** around what the dry runs showed: every case sets checks, the
  dev server and guard rules; a new project gets a committed skeleton with a green baseline;
  every Accept line of a UI step must be observable in the browser; tester needs go in `- Note:`
  lines; runtime output is gitignored; the project CLAUDE.md always gets a "During an AutoClaude
  run" section; the hand-over rewrites CONTINUE_HERE.md and runs `autoclaude run --check`.

**Rejected.** Documenting around the bugs instead of fixing them, and a `guard.protect` path list
for files the run must not edit (the CLAUDE.md run section and Out of scope cover it for now;
logged in DEFERRED.md if a run ever edits one).

### D44 Models: Opus is the main model, Sonnet the floor, never Haiku (2026-09-27)

**Decision.** Every model AutoClaude chooses defaults to `opus`: the builder session (new
`builder.model`, passed as `--model` on every launch and relaunch, so it no longer depends on the
owner's own Claude Code default), its decider agent (`model: opus`), the browser tester and bug
bash (`tester.model`, was `sonnet`) and the security reviewer. Config validation accepts only
`opus`, `sonnet` (the aliases, which always resolve to the newest model of each family, with an
optional `[1m]`) or a full `claude-opus-*` / `claude-sonnet-*` id, and refuses Haiku.

**Why.** Scott: "We don't ever need to use haiku, sonnet is okay if something is very basic but
id set whatever the newest sonnet is as the floor for models usage. and whatever the newest Opus
is as the celing and the main model used." Aliases rather than pinned ids, because he asked for
whatever is newest. The Haiku usage he saw came from `--model haiku` verification calls made while
testing AutoClaude, not from the product; building sessions no longer use it either.

**Rejected.** Keeping Sonnet for the tester to save usage: the tester is the step's independent
verification, not basic work.

### D45 What AutoClaude leaves in a project's git (2026-09-27)

**Decision.** Unchanged: only `.autoclaude/` (run state, logs, reports, screenshots, the browser
tester's MCP config) is gitignored. `autoclaude.config.json`, the run records (`PROGRESS.md`,
`docs/REVIEW_NOTES.md`, `docs/BLOCKERS.md`, `docs/SECURITY-FINDINGS.md`), the doc set and the
`autoclaude(<step>)` commits are part of the project and reach GitHub when the owner merges the
run branch and pushes. AutoClaude itself never pushes (`git.push` false, the guard denies the
builder's pushes, the gate only commits).

**Why.** Scott asked that AutoClaude's files not end up in his project repos, was shown the
options, and chose "Leave it as is". Keeping the config in git also carries the project's deny
rules and checks to any other machine.

**Rejected.** Gitignoring the run records; also the config; also the plan and docs (the last
contradicts his rule that project plans and docs live in git).

### D46 One install per device; the instructions travel into each project (2026-09-27)

**Decision.** AutoClaude stays a one-time install per device from the GitHub marketplace; every
project on that device uses the same plugin, and nothing of AutoClaude itself is copied into a
project. `init` now writes a copy of the repository's `INSTRUCTIONS.md` into each project as
`AUTOCLAUDE.md`, with a line saying which AutoClaude version copied it and how to refresh it
(delete it, run `autoclaude init`). The template copy lives in
`plugins/autoclaude/project-template/AUTOCLAUDE.md` and a test keeps it identical to the root file.

**Why.** Scott asked whether AutoClaude should live in its own cloned folder per device, with
projects pointing at it and the instructions pulled into each project, then chose: "I like having
it as a one time setup per device". The plugin install already is that folder, managed by Claude
Code; the missing piece was having the instructions at hand in every project. The name is not
CLAUDE.md, so Claude Code never loads it and the builder pays nothing for it.

**Rejected.** Installing from a git clone (a directory marketplace): a `git pull` would change the
code under a running build, and it clashes by name with the GitHub marketplace. A per-project
pointer to the install location: not needed, the plugin is enabled for the user everywhere.

### D47 A run does the whole project, like a watched session; limits are opt-in (2026-09-27)

**Decision.** Supersedes the "never touch anything outside the project" default built into the
plan skill (P7.1: the stall review turns work on other machines into scripts left to the owner,
and asks what the run must never touch), the decider (reaching outside the project is critical),
and the template's "When something is unclear" defaults. From now on a run does everything the
plan says, including infrastructure (creating a VM, deploying, touching other machines), exactly
as a session the owner watches would. The plan interview asks what the run may do, records it in
the plan, and only what the owner marks off limits becomes a `guard.deny` rule. The built-in run
mechanics (the gate commits, no force push, no questions to a person) stay. Decided now,
implemented after the DB rehearsal (DEFERRED 19).

**Why.** Scott, on learning the rehearsal would not create the DB project's VM: "Why? I never
wanted that? I want it to work on the project start to finish no different than if I was
watching the whole time, and I can specify differently if I want while making the plan." The
restriction was a default chosen while building AutoClaude, reinforced by advice to name the
Proxmox host as off limits during planning; he never asked for it.

**Kept, as an offer during planning, not a rule.** A snapshot or backup step before a run changes
an existing machine, because the homelab has no backup jobs; the owner decides per plan.

### D48 Planning asks; it never assumes (2026-09-27)

**Decision.** `/autoclaude:plan` asks the owner about every open decision, the run's scope
included, however many questions that takes. What the code, the docs or the owner's own notes
suggest is offered as the recommended answer and confirmed, never applied silently. The session
decides by itself only where the owner says "you decide". The purpose of a run is the bulk of
the build; the owner fine-tunes afterwards in normal Claude Code sessions. Supersedes the plan
skill's "ask what the code and docs do not already answer". Implemented with D47 after the DB
rehearsal (DEFERRED 19 items 6 and 7).

**Why.** Scott: "Id rather 25 questions or more and end up with what I want than everything
assumed and waste tokens. The point is a little extra planning time and I save most of the build
time. Thats the goal." In the rehearsal the planning session inferred the run's scope from his
notes and never asked, which cost him the VM he expected the run to create.

**Rejected.** Keeping the interview short to save the owner's time: a wrong assumption costs a
whole night of building.

### D49 What the rehearsal review settled (2026-09-28)

Scott's answers, over eight rounds of questions after the DB rehearsal (P7.3) and its review.

- **Verification once per feature** (`gate.verifyAt: "phase"`, the new default): a mid-phase
  `ready` commits the step without checks; the phase's last step runs everything over all of the
  phase's Accept lines. A commit per step, verified per feature; 3 attempts per feature.
- **The builder runs only the tests for what it changed**; the full suite runs once, in the gate.
  The rehearsal ran the full suite about 66 times; the builder's own runs were 67% of its time.
- **Builder effort follows the owner's Claude Code default** (Scott uses ultracode); an optional
  `builder.effort` exists for others.
- **A fresh builder session per feature**: one 18-hour context averaged 459K tokens per request.
- **Paperwork**: CONTINUE_HERE per step, the project's other doc duties per feature.
- **Push the run branch and the phase tag after each verified feature**; `git.push` defaults to
  true.
- **Full scope** (D47) with: a snapshot offered, default yes, before a change to an existing
  machine; Claude Code permissions pre-approved for exactly what the plan allows; new secrets
  generated into a gitignored `secrets/`; installing tools, Docker and new GitHub repositories
  allowed; planning asks before installing or pulling anything.
- **Planning interview in rounds** of up to four questions with a recommendation each (D48).
- **Decisions mid-run**: decide, log, keep going; a decision that accepts a security risk is
  flagged "Owner review: yes" and listed in the hand-back and the completion alert.
- **Non-blocking findings** get a fix-up pass at the end of each feature.
- **Hand-back**: a HANDOFF.md and a richer completion alert.
- **Machine footprint**: Docker state recorded at run start; unused things the run created are
  removed at the end; the rest reported.
- **Alerts per event**, set on the config page; "feature verified" on by default; critical alerts
  cannot be switched off.
- **Settings in layers**: built-in, then this computer's defaults, then the project; existing
  projects follow a changed default unless they set their own. Project-only keys stay in the
  project.
- **The config page**: a browser page served from this computer only, opened by `autoclaude
  config` or `/autoclaude:config`; project settings, computer defaults, alert channel (secrets
  hidden with a Show button), watchdog and status line; safe settings live during a run, the rest
  locked until paused.
- **Parallel steps**: later, after these speed fixes are measured.
- **Release path**: 0.10.0 after a short practice run that Claude does itself; then the DB
  project's next part; then a review; then 1.0 (P7.4 moved to P9.5).

**Why.** The rehearsal worked (28 of 28 steps, no false alarms) but was slow and narrow: builder
time was two thirds test runs, planning never asked the scope, and nothing reached the VM Scott
wanted built. Each item above is his answer to a question with alternatives shown.

### D50 How Phase 8 was built: the smaller choices (2026-09-28)

**Decision.** Choices made while building D47 to D49, each between real alternatives:

- **Settings layers.** An invalid or project-only value in this computer's `defaults.json` is
  ignored with a warning, not an error, so one bad default cannot stop every project. `init`
  writes only the project-only keys (`plan`, `branch`, `devServer`, `checks`, `guard`, `docs`,
  `permissions`), so a new project follows the computer defaults.
- **Live settings.** Safe while running: `notify.*`, `usage.*`, `review.pauseAt`,
  `supervisor.*`, `git.push`, `git.tagPhaseEnds`, `footprint.*`. Everything else, and any
  computer default a running project inherits, is locked on the page until the run is paused.
- **The settings page.** Served on 127.0.0.1 with a random port and a 48-hex-digit token in the
  address, closed after 30 idle minutes. Alert switches in the project section write to the
  project; the computer defaults have their own section. The test alert uses the saved
  `notify.json` channel, not the plugin userConfig. Secrets are shown masked to the host until
  Show is pressed.
- **`autoclaude decide`** is synchronous (up to about 9 minutes; the builder gives the call a
  600000 ms timeout), prints JSON (classification, recommendation, reasoning ending in how to
  undo it, question_for_owner, owner_review), logs to `.autoclaude/logs/decide.log`, and never
  writes `docs/DECISIONS.md` itself: the builder writes the `D-###` with `- By: decider`. The
  Agent-tool decider stays as the fallback when the command fails. Replaces the background
  decider that left the rehearsal's session idle until a "Continue" nudge.
- **Per-feature gate.** A mid-feature step is committed as `autoclaude(<id>): <title>` with the
  body "Built, not verified yet", marked `[~]`, and PROGRESS says "(built; verified with Phase
  N)". The feature commit keeps the closing step's id in its subject and names the feature,
  Accept lines, checks, decisions, findings and report in its body. A pass report is written for
  every verification so the body can name it. PROGRESS and the plan tick are written before the
  checks run, and reverted on a failure, so the verified commit always holds a passing tree.
- **Fresh sessions.** Also at phase ends in `gate.verifyAt: "step"` mode, and after a session
  that failed to resume twice fast. A fresh session is not counted as a recovery.
- **Alerts.** "Phase N verified" is not sent for the last feature; the plan-complete alert
  covers it. A push failure is its own always-on alert at default priority: the work is safe
  locally and the next feature pushes again.
- **Hand-back.** HANDOFF.md is committed as `autoclaude: hand-back` and pushed. Decisions and
  owner reviews count only entries dated on or after the run started. "Left for you" is the
  plan's After the run list plus BLOCKERS rows marked for the owner.
- **Footprint.** Docker containers, volumes and networks are listed at run start; only ones
  created after it and now unused are removed. A kind not listed at start is never compared,
  and nothing is removed when Docker was unreachable at start. A running container the run
  created is only reported. Images are not tracked yet (DEFERRED 20).
- **Tester.** In phase mode it skips `no-ui` steps; a coverage shortfall is noted in the report,
  not failed.
- **Secrets.** `init` adds `secrets/` to `.gitignore`, and the gate's commit never stages it,
  even when the project's `.gitignore` lost the line.
- **Items left for the owner during a run** go to `docs/BLOCKERS.md` rows with Owner "owner"
  and Status "left for the owner: <why>", and secrets the run created are named in their `D-###`
  entry and the footprint, because the builder may not edit the plan. HANDOFF.md merges them with
  the plan's own "After the run" list, which planning writes with the owner. Rejected: a guard
  exception letting the builder write that one plan section.
- **Resume at a feature boundary.** With a live supervisor and a pause other than a blocked
  question, `resume` starts a fresh builder for the next feature; an answered question carries
  on in the same session, which holds the context of the question.
- **Counting.** The completion alert's "decisions the run made" leaves out planning entries and
  the owner's own answers. Push times in the summary and HANDOFF.md are labelled UTC.
- **Deadlines.** The decider and the checkers' wrap-up turns are capped by a deadline, so
  `autoclaude decide` finishes inside one 10-minute Bash call and a checker never overruns the
  gate's time budget.
- **Session context.** A fresh builder gets the current feature's steps with their markers, the
  last 10 PROGRESS lines and, during a fix-up pass, the findings.
- **Guard.** `guard.deny` is tested against the words of each command a line runs (and the
  script behind `npm run <name>`), not heredoc bodies, strings or files being read. Recursive
  deletes in the temp folder are allowed. A plain push is allowed when `git.push` is true; a
  force push never is.
- **Checks environment.** `autoclaude run` records its PATH in `.autoclaude/run-env.json` and
  `autoclaude checks` uses it, so a check behaves the same in the gate and by hand. A check's
  `requires` command runs in the preflight.

**Why.** Each follows from a rehearsal finding or from D49; the alternatives were the obvious
opposite in each line (failing on a bad default, writing every key at init, a live page for all
settings, a background decider, verifying mid-feature, and so on), rejected for the reasons
given with each.

**Rejected.** Recorded per line above.

### D51 What the Phase 8 verification changed (2026-09-29)

A four-lens verification of the committed Phase 8 code (the per-feature gate, the Accept lines,
safety, Windows live-readiness) confirmed 29 defects; two fix rounds (0.10.1, 0.10.2) and their
own skeptic checks followed. Choices made, each between real alternatives. Supersedes the D50
lines on the footprint and on counting decisions.

- **Docker cleanup needs proof, not timing.** An object is removed only when it was not in the
  start record, Docker dates its creation after the start, the same engine answers at the end
  (engine id, name and OS), and it is tied to this project: its compose folder is in the
  project, it bind-mounts a project folder, it carries a compose project name the project
  declares, or (volumes, networks) a tied container uses it. A volume tie also carries the
  volume's creation time and labels, so a later volume of the same name is not taken for it.
  Docker's predefined networks are never considered. Anything else new is reported as "not tied
  to this project" and left alone. Why: Scott's rule is "clean up what it created, report the
  rest", and time alone cannot show who created something; a context switch could otherwise
  wipe another engine. Rejected: removing whatever appeared during the run (the 0.10.0 code).
- **Run decisions are counted by number, not date.** The highest D-### and N-### at run start
  (state.decisionsAtStart, or the log at the run's base commit) mark where the run's own
  entries begin. Rejected: dates (two runs in a day mix) and entry counts (break on insertions).
- **Out of time is its own pause reason.** A verification cut off by the hook, a check or
  checker stopped at the gate's deadline, or a passed feature whose commit was cut off twice
  with the files changed each time: the second time pauses `out-of-time` with a high alert
  naming the levers. It is never an attempt. Checks are capped by the gate's deadline; the
  checkers share what is left, each leaving half a fair share for every checker after it.
  Rejected: counting these as infra failures (blames Playwright and the CLI, the wrong
  diagnosis) and strict proportional shares (cut the tester even when everything would fit).
- **Close and completion are resumable.** The pass is recorded in state before the commit; a
  stop cut off in the commit, tag, push or hand-back is finished by the next stop, once. The run
  is marked complete only after HANDOFF.md is committed. A resumed close whose files changed
  after the checks is verified again, except when only CONTINUE_HERE.md changed. Rejected:
  committing the recorded tree with plumbing (bypasses the project's hooks).
- **The fix-up pass closes only with an outcome for every finding** (fixed, or "left for the
  owner: <why>"); a row the builder deleted is put back as left for the owner.
- **Phase tags from an earlier run** keep their name; this run tags
  `ac-phase-<n>-<7 characters of its start commit>`.
- **The guard, with pushes on:** a plain push is allowed; every force form, remote deletes and
  prunes, and git settings that change what a push does are denied, as are edits to this
  computer's AutoClaude settings and Claude Code's settings.json. A recursive delete must name a
  target the guard can place; guard.deny also sees inline code and container commands. Git
  reads (tag listings, config reads) pass. Rejected: denying every builder push (a plan may
  create and push a repository). The remaining gaps are DEFERRED 21.
- **Windows details:** an npm `claude.cmd` is started through cmd.exe with escaped arguments; a
  check starting with `bash` that would reach WSL's launcher fails the preflight.

### D52 What the practice run changed (2026-09-29)

**Decision.** From the P8.9 practice run on 0.10.2 (0.10.3):
- A browser checker with no working browser returns `browserUnavailable: true` (a new required
  verdict field) and the gate treats that run as "could not run": retried once, then an infra
  pause, never a failed attempt. The checkers' MCP servers get 120 s to start (`MCP_TIMEOUT`,
  `MCP_CONNECT_TIMEOUT_MS`) unless the owner set their own.
- The init skill, when headless, asks its two setup questions as text and waits, like the plan
  skill, instead of applying its recommendations.

**Why.** In the practice run the tester's Playwright MCP timed out on connect; the tester marked
all 9 Accept lines FAIL with "not checked", and the gate counted it as the feature's first
attempt and sent the builder a failure report about working code. Three such timeouts would have
paused the run as `step-failed`, blaming the code. Headless init applied "add a Playwright
scaffold" on its own, which planning then had to undo.

**Rejected.** Inferring "no browser" from the evidence text (fragile wording); a longer default
without the flag (a checker that never connects would still fail the feature).

### D53 CHECKPOINT 8: keep it as it is (2026-09-29)

**Decision.** Scott accepted every choice the build and review agents made (D50 to D52),
including no "Phase N verified" alert for the last feature, HANDOFF.md committed and pushed, a
plain `git push` allowed when pushing is on, and Docker cleanup only of what is provably the
project's. The fix-up pass stays as it is (DEFERRED 22 stays deferred). Next is P9.1: a second
all-day run on the DB project on 0.10.3, which he watches in person.

**Why.** Scott: "All of those decisions are good with me, and I think I want to keep everything
as is, and do another test run on the db project all day today so I'm able to pop in and look at
everything running."

**Rejected.** A `fixup.minSeverity` setting now (DEFERRED 22), until a real run measures it.

### D54 Effort in a run: builder at the owner's choice, checkers at the owner's default, no ultracode (2026-10-02)

**Decision.** (1) The builder keeps the effort the owner chooses; Scott keeps xhigh. (2) The
headless checkers (browser tester, bug bash, security reviewer) and the decider use the owner's
own Claude Code effort setting: `runHeadless` drops an inherited `CLAUDE_EFFORT`. (3) Ultracode's
multi-agent orchestration stays off in runs: `builder.effort: "ultracode"` launches the builder
at `--effort xhigh`.

**Why.** Measured on the DB project's second run (28 h 40 min, 36 steps): effort only touches the
builder's model time (25% of the run; thinking about 8%), so high instead of xhigh would save an
estimated 55 to 125 min (3 to 7%), while one extra failed feature costs 35 to 80 min and high
trims exactly the hard 10% of turns that carry 70% of the thinking. Scott: "I like the idea of
it being on xhigh to make sure it can think about what it's doing". The checkers ran at high by
accident (they inherited the builder's CLAUDE_EFFORT "ultracode", which `claude -p` did not take
as xhigh); Scott chose his default for them, about 10 to 20 min more per run. Ultracode never
reached the unattended builder (its reminder comes only with a prompt a person types; 0 workflow
calls); turned on it would multiply usage several times for little speed, since half the run is
serial machine time. Scott chose to leave it off; mapping it to xhigh keeps that true whatever a
later Claude Code does.

**Rejected.** High for the builder (small saving, quality risk where it matters); checkers fixed
at high; making runs orchestrate workflows.

### D55 One checker effort setting, xhigh by default (2026-10-02)

**Decision.** A new setting, `checkers.effort`, sets the reasoning effort of the browser tester,
the bug bash, the security reviewer and the decider together. Built-in default `xhigh`; allowed
`low`, `medium`, `high`, `xhigh`, `max`, or `null` for the owner's own Claude Code default. It is
on the settings page next to "Builder effort", can be a computer default, and is locked during a
run like the other verification settings. The plan skill asks it in the run-settings round.
Builder effort is unchanged (unset = the owner's Claude Code default). Supersedes D54's "the
checkers use the owner's own Claude Code effort setting" as the default.

**Why.** Scott: "could we make the default effort be something configurable in the config page
too?", then chose one setting for all checkers, xhigh, as a fixed level. The checkers are about 5%
of a run's gate time, so xhigh costs about 10 to 20 minutes per long run, and the comparison of
both DB runs suggests xhigh reviews notice more small problems.

**Rejected.** One setting per checker (more to set for little gain); one dial for the builder and
the checkers together; following the Claude Code default as the built-in default.
