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
