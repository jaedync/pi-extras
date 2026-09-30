# Changelog

Versioning rules are in [CONTRIBUTING.md](CONTRIBUTING.md#versioning).

## 0.12.4 - 2026-09-30

### Added

- Rate-limit Recovery: short rate limits, such as OpenRouter's "temporarily
  rate-limited upstream" and other 429s without a structured reset, are waited
  out instead of failing after Pi's roughly 14-second retry. Waits back off 5,
  10, 20, 40, then 60 seconds (jittered, never below the 429's `Retry-After`)
  for up to `transientMaxWaitSeconds` (default 180, `0` leaves them to Pi) per
  streak, in every session including subagents. Interactive sessions show a
  countdown; Esc cancels, and switching models resumes at once with the new
  model. Quota, billing and usage-limit errors keep their existing handling.

## 0.12.3 - 2026-09-30

### Fixed

- Starting a subagent ran every installed extension's setup for the child.
  remote-pi then delivered the parent session's agent-network messages to the
  newest child, and after one such delivery held later messages until the
  parent's next turn ended, sometimes for hours. A child now loads only the
  extensions that provide its tools, with the same tools as before.
- A subagent's note to an idle main session sat unread until something else
  woke main, usually the child's report minutes later. Notes now wake main
  like questions and answers do. What the user types to a child directly is
  still recorded without waking main.

## 0.12.2 - 2026-09-30

### Fixed

- Rate-limit Recovery: an Anthropic subscription request that returns headers
  and then only keep-alive pings (seen near :00 and :30 UTC) no longer hangs
  the turn for minutes. After `anthropicFirstEventSeconds` (default 45, `0`
  disables) without a real event, it fails as a timeout and Pi's own
  auto-retry sends it again. Only bearer-auth requests direct to
  `api.anthropic.com` are watched; API keys, proxies and other providers are
  unchanged.

## 0.12.1 - 2026-09-30

### Fixed

- A resumed child could answer main's question in the same response as other
  tool calls (when tools run one at a time, or when the answer comes from
  inside another tool) and then report without waking main. The answer now
  counts as the whole report only when its response made just that `message`
  call; otherwise the report wakes main.

## 0.12.0 - 2026-09-30

### Added

- Rate-limit Recovery: detected provider cooldowns fail with reset guidance by
  default. `/rate-limit-recovery on` opts the main interactive session into
  cancellable hibernation, with a countdown, a five-hour aggregate ceiling and
  bounded attempts. Escape/Ctrl+C cancels; Anthropic model switches retain the
  wait and use the selected model. Before retrying, the agent receives actual
  elapsed wait and UTC pause/resume timestamps. Ordinary transient retries are
  unchanged. Subagents never wait: one quota error fails fast with the provider
  and estimated reset, even if the parent opted in. Recognized native HTTP
  quotas also bypass configured transport retries without changing ordinary
  retry behavior or provider configuration.

### Changed

- Backgrounded subagents use Shell Jobs' compact handoff chips. Blocking waits,
  expanded tasks and reports retain their full rows.
- Codemode uses JavaScript tool-call cells marked `ƒ`, with observed status and
  elapsed time, bounded previews and per-call popup output. Overlapping call
  lifetimes are labeled `overlap`, not inferred parallel execution. Saved Pi
  metadata restores calls without inventing missing results. No scripts or
  tool behavior are changed. Its full-screen popup keeps Source and Result
  views fixed, follows the selected call as calls arrive, and copies the
  script without unsafe terminal controls or the retained call output alone.
- Subagent report bands show tokens (prompt, including cached, and output)
  beside cost and time. Reports saved earlier keep their cost and time.

### Fixed

- A child resumed by main's question that answered and then kept working
  delivered its final report silently, so an idle main never woke. Now only a
  run that answered main's resuming question and then just wrote its final text
  counts as already reported. Further tool work, any new input (steering, notes,
  its own subagents' reports) or a failure makes the report wake main. Even an
  already-answered report shows its band (cost, tokens, time), text folded.

## 0.11.5 - 2026-09-30

Windows Use for guests behind a VPN, and in the desktop session the user is
already using.

### Added

- A Hyper-V socket relay in the guest carries `windows_use` calls, session
  checks and server restarts without the guest's network. A full-tunnel VPN in
  the guest, or firewall rules that cut it off from the host, no longer cut
  Windows-MCP off. Setup installs the relay with the server, and an existing
  server gets it on its next call over the guest's IP. A relay that stops comes
  back within a minute or two, and a relay update that fails to start is rolled
  back to the previous version. Without a relay, calls use the guest's IP and
  port as before.

### Changed

- Setup sends its installer over Hyper-V key-value exchange and types only a
  short stub that carries the key and the installer's hash, about 650
  characters instead of 3,400. A setup took about three minutes live instead of
  seven and a half. The bootstrap clears the stub, which shows the key, off the
  screen before anything else. Without a working key-value exchange, all of it
  is typed as before.
- A setup works with the guest's VPN already up. A reinstall that can't reach
  the package index keeps an installed Windows-MCP from the same release line.
- A new session's first call takes about 3 seconds instead of 7 to 11. Warm
  calls take 130 to 180 ms instead of 1.1 to 1.8 s. Under WSL the host scripts
  run from a copy under the Windows `%LOCALAPPDATA%`, because read over
  `\\wsl.localhost` they started seconds slower.
- A stalled or stopped server is restarted through the relay without console
  input, and at once, instead of after a wait, once the guest has been up a
  while.
- In an enhanced VM Connect/RDP session, guest methods work in that session.
  Console input, which could take the session over, is refused, and console
  screenshots and OCR read Windows-MCP's image, scaled back to desktop pixels.
- Console typing sends one paired `TypeKey` per character with settled
  modifiers, and setup switches to its new key only once the whole command is
  queued, so a typing failure leaves the running server usable.

## 0.11.4 - 2026-09-29

### Changed

- Clicking a tool call, a shell job or a subagent opens it over the full
  terminal instead of in a box in the middle. All three share one view: a
  title bar with copy buttons and `✕`, the live band, a scrolling body with a
  scrollbar and a row of keys. Esc, `q` or `✕` closes it; there is no outside
  left to click. Up and down, `j` and `k`, page keys, space and `b`, `g` and
  `G` scroll. The subagent view has no letter keys, since letters go to its
  message box.
- Copy buttons: a tool call copies its command (or path) and its output, `c`
  and `o`; a shell job its command and its whole log, `c` and `o`; a subagent
  its task and its report. Text dragged across the view copies just what it
  shows, without borders, the scrollbar or the transcript behind it.
- Pi's `[compaction]` block is a purple band like a tool row's: why it ran
  (`auto`, `manual` or `overflow`), the context size before and an estimate
  after, its cost and how long it took. The summary's first three lines sit
  under it on Pi's compaction purple; a click or ctrl+o shows all of it.
  Timing and sizes survive a resume; older compactions show the size before
  and the cost.

### Fixed

- A tool popup showed a single command twice, in its band and above the
  output.
- Popups sized to their content and moved when a chain step was picked, so
  the next click could miss. The view's layout is now fixed.
- In a small terminal a popup lost its details, its keys, its scroll
  position or its bottom edge.
- A prompt Pi shows while a popup is open (a confirmation, a choice) was
  hidden behind it. The view steps aside until the prompt is answered.
- The subagent inspector could open twice; it now opens one at a time, like
  the other popups.
- `/jobs <id>` took two Enters when the id was already complete.

## 0.11.3 - 2026-09-29

### Fixed

- After `/reload` (as after `pi update`), the history above drew in Pi's own
  style: plain tool boxes, no step lists or job chips, full thinking blocks
  and no copy labels; only new rows looked right. Pi rebuilds the transcript
  before extensions start again, so pi-extras now rebuilds the rows drawn in
  between once it is ready.

## 0.11.2 - 2026-09-29

### Changed

- Chained bash commands: the running step's line breathes gently, and each
  step that finishes flashes green, red or amber and fades back, so quick
  steps read as a wave down the list. Reduced motion keeps both still.
- Thinking tails run the block's lines together, joining paragraphs and list
  items with `·`, so the three lines hold as much of the thinking as fits
  instead of spending them on list items and gaps.
- Starting a background job leaves a small chip, `↳ Run unit tests  in
  background`, set in from the edge, instead of a full-width row that looked
  like any other call. It takes the job's outcome and time when it ends.

### Fixed

- Output previews no longer say `… 1 earlier line`: a single hidden line is
  shown in the row the hint would take. This covers bash and step output,
  write previews, edit diffs, search results, computer use, other tools' rows
  and job logs.

## 0.11.1 - 2026-09-29

### Fixed

- A child that asked two agents at once lost one of the questions and stayed
  blocked, shown as `thinking`, until the reply timeout. A child can now wait
  on several agents, and a child's report answers its parent's open question
  to it.
- A child main was waiting on (`wait: true`) could ask main a question main
  could not answer until the 10-minute timeout. The question now ends the
  wait. That child's notes to its waiting parent are refused with advice to
  put them in the report.
- `/subagents stop <name>`, `/subagents stats` and other complete commands
  ran only on a second Enter; the completion menu took the first.
- The inspector's message box is always live: type and press Enter. Esc
  clears a draft or closes, ctrl+x twice stops the agent (it was `x`), and
  pastes and kitty-protocol keys work. Letters are no longer shortcuts.
- A waited-on child's row shows only its report, and reports and messages
  render Markdown. ctrl+o shows a background child's whole task instead of
  text written for the model.
- After main asks a finished child something, the run's report no longer
  repeats the answer on screen; it goes to main's context only.
- A child's band says `compacting context` while Pi compacts it.
- Wording: `queued` on a queued child's row, `+1 more agent`, `1 more line`,
  `1 run`, and `Stopped before it wrote a report.`; the `/subagents` picker
  says `finished`, adds spend, time and task, and fits one line.

## 0.11.0 - 2026-09-29

Copy Blocks: one click copies a code block or quote from a reply.

### Added

- Copy Blocks. Code blocks and quotes in replies are drawn as cards on a
  background of their own, with a `copy` label. In fullscreen mode a click on
  a code block's header or a quote's label copies the block's exact text:
  tabs kept, and quotes without their `>` markers or wrapping. `/copy-block`
  copies the last block of the latest reply, or the nth, from the keyboard.
  `PI_COPY_BLOCKS=off` turns it off.

## 0.10.2 - 2026-09-29

### Fixed

- A subagent the agent waits on (`wait: true`) showed twice, in its tool row
  and above the editor, and the tool row lacked context, cost and a line for
  what the child is doing. It now shows once, in the tool row, with all of it.
- The context share in a subagent's band reads `ctx 12%` instead of a bare
  percentage.
- A child resumed by a message reported the time since it was first started;
  each run is now timed on its own, and its report names the message that
  started it without the delivery boilerplate.
- When main asked a finished child a question, the child's answer woke main
  and then its report woke main again with the same answer. That report is now
  appended without a new turn.

## 0.10.1 - 2026-09-29

### Fixed

- Subagents stays off, with one notice, when another extension such as
  pi-subagents already provides a `subagent` tool. It used to skip only that
  tool and still add `message`, which then had no agents to reach.

## 0.10.0 - 2026-09-29

Subagents: background child agents on the model of your choice, which talk to
the session and to each other, with a live band per agent.

### Added

- Subagents. The `subagent` tool starts a child agent: a separate Pi session
  on one of your scoped models, with a fresh context (or a condensed copy of
  the conversation), in the background by default. Its report arrives as a
  message; `wait: true` blocks for a quick check, and `readOnly: true` takes
  away edits and shell commands.
- A model guide, `~/.pi/agent/subagent-models.md`, says which model suits
  what. It goes into the tool description at session start and on `/reload`
  only, so it never busts the prompt cache mid-session. `/subagents guide`
  edits it. Thinking levels come from Pi's `modelThinkingLevels`.
- `message` between every agent: main, children, and siblings by name, or
  `all`. A running agent reads it after its current tool call and a finished
  one resumes with its context. Children can ask and wait for an answer; main
  never waits, and a child's question wakes it. Reports from children started
  in the same run arrive as one message.
- A band per agent above the editor with its model, what it is doing, context
  used, spend and time, children nested under their parent, and notes queued
  for main until they reach the transcript. `/subagents`, or a click on a
  band or row, opens an inspector with the agent's live transcript, where you
  can write to it or stop it; main is told what you wrote.
- Status Plus counts children's usage in its totals as they run.
- A run log, `~/.pi/agent/subagents/runs.jsonl`, and `/subagents stats` to
  compare models by runs, time and cost.

## 0.9.2 - 2026-09-29

Status Plus, checked against every recorded session: it now matches the
transcripts to the cent wherever they link their spend.

### Fixed

- Status Plus charges compactions, branch summaries and Pi's cache refreshes.
  Pi bills them but records their usage outside replies, and the footer
  skipped them; compactions alone were about 5% of real spend. They are
  charged to the model that ran them and count as no turn.
- Subagent children that a workflow notice, incremental child notice or
  supervisor request names only in its text are charged, when their session
  sits under this session's folder. A child reachable under two run ids, its
  own session and another run's artifact copy, is charged once.
- The cache clock follows the lifetime the newest cache write actually got.
  Anthropic-compatible proxies such as Meridian write hour-long entries
  whatever Pi asked for, so a warm cache read cold after five minutes.
  `PI_CACHE_RETENTION` still decides when the transcript doesn't say.
- A request refused before its prompt was read no longer blanks the cache hit
  rate or restarts the cache clock, and tool calls in a failed or aborted
  reply, which never run, are no longer counted.
- Context Pi can't size yet, as after a compaction, shows `?` rather than 0.
- A cost recovered for a reply saved without one prices hour-long cache
  writes at twice the input rate, as Pi does.
- Pi's cache refreshes during a long tool call no longer tick live airtime.

## 0.9.1 - 2026-09-29

Windows Use, after a night of live agent runs against a Hyper-V guest.

### Added

- `PI_WINDOWS_USE_VMS` limits `windows_use` to the VMs it names (for example
  `"Win11,Test Lab"`, matched case-insensitively): others are left out of
  `win.vms()`, and calls naming them fail before reaching the host. With one
  VM allowed, calls may leave out `vm`.
- `win.console.ocr({ vm })` reads a VM's screen with Windows OCR on the host,
  as `(x,y) text` lines whose centers can be clicked. It reads what the UI
  tree can't: apps running as administrator, custom-drawn windows, UAC and
  sign-in screens, and it needs no model that takes images. It reads the
  screen at twice its size, a quarter at a time, where small UI text and
  text over a photo wallpaper come out right far more often.
- `win.uac({ vm, answer })` answers a UAC prompt from the console. It never
  types a password.
- `PI_WINDOWS_USE_ELEVATED=on` runs Windows-MCP with the guest user's
  administrator rights: `win.powershell` and the apps `win.app` launches run
  as administrator, and its input reaches apps running as administrator. A
  server set up with other rights is reinstalled on the next call. MMC
  consoles' UI trees remain unreliable (Event Viewer crashed, Services
  stalled), so agents are pointed to PowerShell and OCR for them.
- Snapshots mark windows Windows-MCP can't see into, such as apps running as
  administrator, and point to the console methods, which reach them.

### Changed

- `win.powershell` returns `{ output, status }` rather than Windows-MCP's
  text. A `timeout` over 540 seconds, longer than a call may run, is refused
  with how to run the command in the background instead.
- Snapshot text is about 40% shorter: no box drawing, one line per window,
  and no lines that say nothing on a single-display guest. Lines past 2,000
  characters, such as a document's whole text, are cut. Runs of one-word
  elements, as rich text boxes and translated pages list them, read as one
  line.
- `win.type` without coordinates types into the focused control by pasting,
  exactly (any characters, several lines), and restores the clipboard.
- `win.sleep(ms)` takes a plain number. Guest calls have limits of their own
  (30 seconds for a snapshot) instead of ten minutes for all.
- `win.console.scroll`'s `amount` counts wheel notches, as `win.scroll` does.
- `win.app` launches the Start menu app a name means: its exact name, or
  words only it has. Windows-MCP matched names loosely and reported the name
  it was given, so asking for "System Management Console" started Print
  Management and said the console launched. A name no app has now fails with
  the nearest ones, and nothing starts.
- A `win.call` that names no Windows-MCP tool, or gives wrong arguments,
  fails with the server's own list of tools and their arguments.
- Setup opens PowerShell from the Run box instead of Start search, and types
  the installer, which carries the server's key, only once OCR reads an
  administrator's PowerShell on the console. It installs Windows-MCP 0.8.6 or
  a later 0.8 release.
- With a model that takes no images, results say that emitted images were
  left out.

### Fixed

- A snapshot stalled by Start or its search, which can stop answering UI
  Automation, restarts them and is taken again, instead of failing for good.
  A snapshot stalled by another window names it.
- A Windows-MCP that answers nothing is restarted from the console's Run box,
  instead of leaving the agent without it. A live run lost half an hour to this.
- A VM locked between lock checks is signed back in before a snapshot,
  instead of the agent getting a picture of the lock screen.
- A restart inside Windows no longer reads as a stopped VM: Hyper-V's brief
  "shutting down" is waited out, a snapshot Windows restarted under is taken
  again once the guest is back, and the first snapshots after it get longer.
- A display that went to sleep is woken before recovery and console captures,
  which read a black or stale screen before.
- A `win.app` launch whose window Windows-MCP lost track of says the app may
  have opened and to look before launching it again, instead of reading as a
  failure that agents answered with a second copy.
- Alt+F4 through `win.key` or `win.console.key` is refused while the
  desktop or taskbar is in front, where it opens Shut Down Windows. A window
  switch that silently didn't take led there in testing.
- `win.console.scroll` and `win.console.drag` failed on every call.
- Console key combinations let go of every key even when a press fails.

## 0.9.0 - 2026-09-28

### Added

- Windows Use (opt-in, `PI_WINDOWS_USE=on`, Pi in WSL on a Hyper-V host): a
  `windows_use` tool that runs short scripts against the host's Windows VMs,
  batching calls like `computer_use`. `win.snapshot`, `win.click`, `win.type`,
  `win.powershell` and the rest act inside the guest through Windows-MCP,
  with its UI Automation tree; `win.console.*` drives the VM's screen, keyboard
  and mouse through Hyper-V, also on lock, sign-in and UAC screens. The first
  call to a VM installs Windows-MCP in it through the console, with nothing to
  configure, and later calls sign a locked or rebooted VM back in, wait out a
  restart that installs updates, and repair a stopped server by themselves.
  They never click on a desktop in use. A call whose connection drops mid-way
  is not repeated, since it may have run. A failed install stops with the
  guest's reason within seconds. `win.sleep` paces console steps.
  `/windows-use` lists the VMs.

### Changed

- `emitImage` in `computer_use` scripts also takes the whole result that
  carries a screenshot, not only its `.screenshot`.

## 0.8.3 - 2026-09-26

### Changed

- Usage Guard keeps long runs going past a limit instead of ending them.
  When the window near its limit resets within five hours
  (`maxWaitSeconds`), a weekly window in its last hours included, the final
  warning tells the agent to finish what fits, then sleep through the reset
  in a background job and continue. The sleep
  ends three minutes after the reset (`resumeMarginSeconds`, was five). The
  `usage` report marks such resets `waitable`.
- Usage warnings no longer push short tasks to stop half done. The first
  band is advance notice only, and a reset days away asks the agent to
  finish small remaining work before stopping at a clean checkpoint. A
  session budget still stops, since the user set it.

## 0.8.2 - 2026-09-26

### Fixed

- A tool popup or job inspector that Pi takes off screen without closing it,
  as `/reload` and session switches do, now lets go by itself. Before, it
  could keep redrawing the screen every frame, swallow clicks while another
  extension's overlay was open, or stop rows from opening popups at all.

## 0.8.1 - 2026-09-26

### Fixed

- Clicking and selecting text work again after a popup closes. Closing a
  tool popup or the job inspector left behind the piece that closes it on a
  click outside, and it went on swallowing every left click in the
  transcript: rows stopped opening popups and text couldn't be selected until
  Pi restarted. If clicks have already stopped in a running Pi, restart it
  once after updating; `/reload` isn't enough.

## 0.8.0 - 2026-09-26

### Added

- Every tool row gets Tool Display's band, not only Pi's built-in tools.
  Other extensions' tools (MCP, subagents, web access, goals and the rest)
  keep their own words: the band shows the line the tool would draw for its
  call, with the time and any failure in the right rail, and under it sit the
  first four lines of the tool's own result. Click a row for a popup with
  every argument and the whole result. `/tool-display others off` gives those
  rows back to their own renderers.
- pi-extras's own tools get layouts of their own. A web search row shows the
  query and how many results came back, with the first three under it. A
  computer use row names the apps and counts the calls and screenshots, and
  says `failed` or `not allowed` in words instead of marks. A usage row answers
  in its band, each window's use amber from 80% and red when spent, instead of
  a page of JSON.

## 0.7.2 - 2026-09-26

### Fixed

- Long sessions no longer lag. 0.7.1's thinking tail wrapped every thinking
  block in the transcript again on every frame, so anything that moved (a
  running tool, the spinner, streaming text) made Pi redo that work many times
  a second. Each tail is now drawn once, and a long block is wrapped from its
  newest paragraphs rather than from the top. Replaying a long session, CPU
  while a reply streams fell from 90% to 15%, against 32% for Pi on its own,
  and while a tool runs from 45% to under 4%, against 10%.
- A finished thinking block is no longer wrapped again for every token of the
  reply that follows it.
- Everything that animates (tool bands, the phase spinner, the Shell Jobs
  widget, popups) ticks off one shared frame timer, so Pi draws one frame for
  all of them instead of one per timer. While the phase spinner covers Pi's own
  working loader, that loader is held still instead of redrawing the screen on
  its own timer. A running tool now costs about 11 frames a second instead of
  23.
- The Status Plus footer reads context usage and the session name only when the
  session or model changes, not on every frame, formats its clock once a
  minute, and hashes messages only when there are subagent sessions to tell
  them apart from.
- A thinking tail that would start on the blank line between two paragraphs
  starts at the next paragraph, instead of showing `…` on a line by itself.

## 0.7.1 - 2026-09-26

### Changed

- A thinking block's tail is just its text: no `Thinking...` or `Thought`
  label and no line counting what is hidden. Up to three lines show whole; a
  longer block shows its newest three, the first starting with `…`. Click it,
  or press ctrl+t, to read all of it.

## 0.7.0 - 2026-09-25

### Changed

- Thinking shows as a live tail by default: `Thinking...` while it streams and
  `Thought` once done, then only its newest three lines, with a line saying how
  many earlier ones are hidden. Click a block to read all of it; ctrl+t does
  the same for every block. `/tool-display thinking collapsed` brings back
  Pi's label, and `/tool-display thinking full` shows everything.
- A write row shows the last three lines of the file instead of the first ten,
  so a streaming write shows what is being written now.
- Everything under a tool row's band sits on a gray panel, so each call reads
  as one block apart from the conversation. Shell Jobs rows get the same.
- Popups, including the Shell Jobs log, sit on a lighter panel and close with a
  click outside them.

### Fixed

- Running tool bands are easier to see. 0.6.0 drew the fill and the sweep at
  about half the intended strength, so a command in progress looked nearly
  still. Background job bands above the editor get the same fix.

## 0.6.0 - 2026-09-25

### Changed

- Tool Display is redesigned. Each tool call is now one colored header band
  instead of a box: green when it worked, red when it failed, amber when it
  timed out, gray when it was stopped. Failures are named in words on the right
  (`exit 1`, `timed out`), next to the time. While a command runs, its band
  fills toward the timeout and warms as the timeout gets close; without a
  timeout it sweeps. Times of 10s or more are drawn in a warmer color.
- The `boxed` and `compact` densities are gone, along with the ✓ and ✗ marks.
  `/tool-display` now has `on|off`, `chains on|off` and `motion full|reduced`.
  A saved density setting is ignored.
- Shell Jobs are named after their titles: a job titled "Run unit tests" is
  `run-unit-tests`, not `j1`, and the model is asked to call jobs by their
  titles. Old `j1` ids from a resumed session still work. Job rows, completions,
  the widget above the editor and the job popup use the same bands. A running
  job's transcript row stays still, and its widget band is the one that moves.
  A completion is one line until you click it, and a job stopped with
  `shell_job kill` reads `stopped` in gray rather than as a failure.

### Added

- Click any tool row to open a popup with the whole call: the full command,
  all its output, and, for a chained command, each step. Esc or `q` closes it.
  ctrl+o still expands rows in place.
- Chained bash commands (`a && b || c`) are shown step by step, each with its
  own status and time, so you can see which step failed and which never ran. A
  leading `cd` is shown as the location. To time the steps, Tool Display adds
  marker lines around each step and removes them from the output before the
  model sees it; the command the model wrote and the output it reads are
  unchanged. Commands it can't split safely run as written.
  `/tool-display chains off` turns this off. `docs/security.md` describes the
  rewrite.
- Click the tool count in the Status Plus footer to count each step a chained
  command ran; click again for one per call. `/tool-display count steps|calls`
  does the same where the terminal sends no clicks.
- These notes. The first new session after an update shows what changed in
  pi-extras, once per version. `/pi-extras changelog` shows them again.

## 0.5.0 - 2026-09-25

### Added

- Tool Display, a new extension that redraws the rows for Pi's built-in tools.
  Bash rows highlight the command, collapse long scripts to their first lines
  and put the run time and exit code in the header. Read rows show how many
  lines were read, edit rows show `+added −removed` and collapse long diffs,
  write rows show the line count, and grep, find and ls rows summarize what
  they found. The model sees the same tools and results.
- `/tool-display` switches every row between `boxed` (Pi's look, the default)
  and `compact`, which replaces the box with a status mark and halves the
  height of one-line rows. The choice is saved in `pi-extras.json`.
  `PI_TOOL_DISPLAY=off` turns the extension off.

## 0.4.1 - 2026-09-24

### Added

- `/computer-use` opens a panel with the client's status, an apps mode and a
  checklist of the apps the agent may always use. Check and uncheck several
  apps at once, filter by typing, and save together; widening access asks for
  confirmation first. Checking an app ahead of time lets headless runs use it.
  The checklist edits the Computer Use service's approvals file the way the
  ChatGPT app does, and only when the file has that exact format.
- An apps mode for every Pi session: Ask per app (the default), Allow all,
  which approves every app for the client session without asking or storing
  anything, and Allow none, which refuses every computer use call. The
  checklist is kept while either override is on.
- Computer use tool rows show the script as highlighted code and a live
  timeline of its Computer Use calls, each with its app, target, time, client
  startup and approval.

### Changed

- The app approval dialog is drawn by pi-extras instead of as an all-accent
  select list, defaults to "Don't allow", shows the service's risk warning for
  apps such as browsers, says the agent is asking rather than
  ChatGPT, and says that "Always allow" also applies to ChatGPT and Codex.
  "Allow once" is now "Allow for this session", which is what it did.
- A headless run that is denied an app tells the agent how to allow it.

### Fixed

- Cancelling a computer use call while its approval dialog was open left the
  dialog up, and answering it could still allow the app. The dialog now closes
  and a late answer is ignored.
- Requests from the Computer Use service other than a plain app approval, such
  as a URL to open, were shown as an app approval, and allowing one accepted
  it. They are now declined without asking.
- A script that fired many Computer Use calls in parallel could exceed the
  50-call limit.

## 0.4.0 - 2026-09-23

### Added

- Computer Use, an opt-in macOS extension: `PI_COMPUTER_USE=on` adds a
  `computer_use({ code })` tool that operates Mac apps through the signed
  Computer Use client the ChatGPT app installs. It runs as a launchd job in the
  desktop session, so it works from a local terminal and over SSH. Each app
  needs approval on first use; `/computer-use` shows what is missing. Off by
  default and not registered on other platforms.

## 0.3.6 - 2026-09-23

### Fixed

- The Kagi pacing tests no longer depend on timer punctuality, which made both
  0.3.5 CI runs fail on slow runners. The extension behaves as in 0.3.5; its
  pacer only gained a test clock.

## 0.3.5 - 2026-09-23

### Changed

- Kagi searches run up to four at once instead of one at a time, so a batch of
  four takes about as long as one (about 1.5 s instead of 5.6 s). Request starts
  stay at least 150 ms apart and are capped at 30 page requests a minute; a
  search that would wait past its deadline for that pace fails with a pacing
  error. A rate limit or challenge still stops every waiting search.
- The Kagi tool no longer makes Pi run the rest of its tool batch one at a
  time. Identical queries in flight share one request.

## 0.3.4 - 2026-09-23

### Changed

- The README image is a 110 KB WebP instead of a 1.8 MB PNG, and the social
  preview PNG is now render output ignored by git. Both PNGs were removed from
  the history, which makes a clone about 2.3 MB smaller; the `v0.3.3` tag was
  moved to the rewritten release commit. The package itself is unchanged from
  0.3.3.

## 0.3.3 - 2026-09-23

### Added

- The README opens with a preview image rendered from a real Pi session.
  `npm run preview:render` re-stages and re-renders it, and
  `npm run preview:check` reviews it; every minor or major release now
  includes a fresh one. The package itself is unchanged from 0.3.2.

## 0.3.2 - 2026-09-23

### Fixed

- Two voice tests failed on Node 22 because they waited on a timer that
  deliberately does not keep the process alive. The package itself is
  unchanged from 0.3.1.

## 0.3.1 - 2026-09-23

### Changed

- After you stop, a voice wait longer than a second is labelled with what it is
  waiting for (starting voice, loading the speech model, or transcribing) and
  that Esc cancels.
- The status-plus footer renders about 12 times faster. It rebuilt its date
  formatters on every frame, which cost CPU whenever the screen animated.
- The package is type-checked in CI with strict TypeScript.

### Fixed

- Voice no longer drops speech recorded while the model is still loading. Those
  chunks were marked done with no text, so only speech after the load was
  typed in.
- A dictation stopped during a slow model load now waits for the load (up to 5
  minutes) instead of timing out after 30 seconds. After that, the 30 second
  limit counts from the last progress, not from the stop.

## 0.3.0 - 2026-09-22

### Added

- Voice extension: hold or tap ctrl+space to dictate into the editor. Speech
  is transcribed locally in chunks while you talk (NVIDIA Parakeet through
  sherpa-onnx, or MLX on Apple Silicon), by one shared background daemon that
  exits when unused. `/voice` picks the mic and model and shows status. Setup
  runs in the background on machines with a microphone and skips models the
  disk cannot hold. Over SSH on a Mac, capture runs in the desktop session.

### Changed

- Phase Spinner hands the editor's top border to a voice recording while the
  agent is idle, and takes it back when a run or status starts.

## 0.2.1 - 2026-09-22

### Fixed

- Phase Spinner shows Pi's compaction, retry and branch-summary statuses in
  the editor border again. They were hidden because the spinner embeds Pi's
  status indicators but only drew its own phases. Each status gets its own
  spinner and an event timer; a retry keeps one timer across attempts, and the
  retried request shows its live phase with `retry n/m`.

## 0.2.0 - 2026-09-22

### Added

- Usage Guard extension: `usage` tool, `/usage` command, session budgets
  ("work until 60% of the weekly limit") and optional one-shot wrap-up
  warnings near a limit. Band warnings are off by default.

### Changed

- Status Plus shares its limit snapshots with Usage Guard, polls a provider
  faster near a threshold, backs off exponentially on failures, and reads
  model-scoped windows such as `seven_day_fable`.

### Fixed

- Usage Guard sends at most one wrap-up per window and reset cycle, even when
  a proxy recomputes the reset time on every fetch.
- Per-minute rate limits from response headers never trigger warnings.

## 0.1.0

- Initial release: Status Plus, Phase Spinner, Shell Jobs, Bash Default
  Timeout, Kagi Search and the Quiet theme.
