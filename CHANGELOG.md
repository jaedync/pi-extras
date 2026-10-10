# Changelog

Versioning rules are in [CONTRIBUTING.md](CONTRIBUTING.md#versioning).

## Unreleased

### Added

- Pull Link: a new `pull_link` tool. Give it a link, and it returns the
  content as markdown for the agent. It reads posts with their threads and
  replies from X, Bluesky, Threads, Mastodon, Reddit, Hacker News and
  LinkedIn, GitHub repositories, issues, pull requests, files, commits,
  releases and gists, and the readable text of any other page. A post's
  photos come back as images.
- Pull Link: video links (YouTube, TikTok, Instagram, Vimeo and the other
  yt-dlp sites) give the description, chapters, a transcript with time
  stamps, the thumbnail and top comments. The transcript comes from the
  captions, or from speech-to-text on this machine when there are no
  captions. Frames are on request, so a video does not fill the context:
  `at` gives the frames at exact times (from 2-second clips on a long
  video), and `frames` samples frames evenly, as images or as contact sheets
  of 12 with time stamps. `range` limits the transcript and the sampled
  frames to part of a video.
- Pull Link: image links in posts and comments (imgur, `i.redd.it`, direct
  image files) come back as images, and a direct image link returns the
  image.
- Pull Link: the first video link installs the media tools into the user
  cache, with no sudo and no browser, so the tool also works on headless
  Linux hosts. This includes the bgutil PO-token provider, which YouTube now
  needs for downloads and captions. The tools update every 3 days
  (`linkContext.refreshDays`).

## 0.23.9 - 2026-10-10

### Changed

- Tool Display, folded mode: a run of calls hangs under the reply that made
  them, set in two columns with no blank line between them. A reply's
  thinking alone reads `∴ Thought for 0.6s` directly above its words, as in
  the unfolded view, with no figures.
- Tool Display, folded mode: when all the edits (or all the writes) in a run
  are to one file, the line names that file (`edited footer.ts`). When one
  call fails, the line names it in red (`ls node_modules failed`); two or
  more are counted (`2 failed`).
- Tool Display, folded mode: an open run shows its rows inside a rule under
  a brighter line. The rule ends with `╰─ close`, and a click on it closes
  the run. An open `∴ Thought` line shows the full thinking text.
- Tool Display: a thinking label shorter than one second shows tenths
  (`∴ Thought for 0.4s`) instead of `0s`.

## 0.23.8 - 2026-10-09

### Added

- Cache Compaction: supports Pi's `openai-completions` API (OpenAI chat
  completions), which local engines such as llama.cpp, vLLM and other
  OpenAI-compatible servers use. Before, these sessions always fell back to
  Pi's own compaction with `unsupported-api`, which is a cold prefill on a
  local engine. The summary request keeps the system message, `tools`,
  `tool_choice`, `reasoning_effort`, the template arguments and every earlier
  message byte-identical, adds the instruction as a new user message, and
  sets only the output limit (`max_tokens` or `max_completion_tokens`). On a
  local OpenAI-compatible engine (Qwen3.8-Flash-Next), 18,311 of 19,229
  prompt tokens came from the cache. A cache marker that Pi moves to the last
  message does not count as a change.
- Cache Compaction: chat completions on a local engine (a loopback, private
  or Tailscale address, or a LAN-only host name) count as warm for 25
  minutes, not 4. `idleSeconds` still sets the limit per provider. Engines
  that unload an idle model on a timer, such as Ollama (`OLLAMA_KEEP_ALIVE`,
  5 minutes by default) and LM Studio (idle TTL), need a shorter
  `idleSeconds`.
- Cache Compaction: a thinking budget field in a chat-completions request
  (`thinking_token_budget` and similar) gets the same check as Anthropic
  and Google budgets. When the budget leaves no room for the summary, Pi's
  own compaction runs with `thinking-budget`.

## 0.23.7 - 2026-10-09

### Changed

- Phase Spinner: TPS in the editor divider is live. While the model streams,
  it counts the tokens that came in the latest second and changes on every
  frame, at least 12 times a second. A burst after a silence, such as a tool
  call that the provider held back, counts as if it came evenly over that
  silence, so it does not show as a false spike. When no tokens came in the
  latest second, between responses and when idle, TPS shows the prompt's
  average as before. The end line keeps the average:
  `π Worked for 41s, done 9:14 PM, avg TPS 98.1`.

## 0.23.6 - 2026-10-09

### Fixed

- Status Plus: the Anthropic monthly budget shows again when several Pi
  sessions use one account. Anthropic limits how often its usage endpoint
  answers one account, and each session polled it on its own clock, so most
  polls got HTTP 429 and the footer showed no dollars. The Pi sessions of one
  agent directory now poll once between them and share the result in
  `status-plus-limits/`, so a new session shows the last budget at once. A
  shared result older than 15 minutes gives only its budget, not its windows.
- Status Plus: when response headers update the 5h and 7d windows, the
  budget that the last poll found stays on screen until its month ends.
  Before, it went away 15 minutes after the last good poll.
- Status Plus: a refused limit poll now writes a line such as
  `anthropic limit poll failed: HTTP 429` to `status-plus.log`, and polling
  waits as long as the provider's `Retry-After` asks, for at most an hour.

## 0.23.5 - 2026-10-09

### Fixed

- Status Plus: the session cost no longer goes up and down by itself when
  the subagents of a session have more than 64 MB of transcripts. Before,
  each walk of the transcript could read only 64 MB of child sessions that
  were not in its cache, so two walks in a row counted different children.
  On a session with 83 MB of child sessions, the total changed by dollars
  every 30 seconds. The footer now keeps only the parts of each child
  session that it counts (1 to 12% of the file), reads a growing session
  from where it stopped, and keeps a child's earlier records when a walk
  cannot read it yet.
- Status Plus: when one walk cannot read all the child sessions, as after a
  resume of a very large session, the footer reads the rest 250 ms later,
  not on the next 30 s walk. It does not show that catch-up as a new charge.

## 0.23.4 - 2026-10-08

### Changed

- Status Plus: when a provider row does not fit, it drops the reset times
  first and keeps the token counts. A window above 70% still shows its
  countdown inline. Before, the token counts went first.
- Status Plus: a model-family window at 0%, such as `7d-fable` while that
  family goes unused, is not shown, and neither is its reset time. It shows
  again at 1% or more, or when it blocks.

## 0.23.3 - 2026-10-08

### Changed

- The shared color for local and other custom providers is now a soft mint,
  not olive, in the footer and the subagent views.

## 0.23.2 - 2026-10-08

### Changed

- Every provider that pi-extras has no color for, such as a local or
  self-hosted server, now shares one muted olive. The footer uses it for the
  provider's row and for the model name, and the subagent views use it for
  the agent's `◆` and name. Before, the footer drew these providers in dim
  gray and the subagent views in Pi's custom-message purple. An agent whose
  model names no provider is still purple.

### Fixed

- Status Plus: a free provider's row shows only after it sent or made
  tokens. A request that failed before its first token no longer adds a
  `0 in · 0 out` row.

## 0.23.1 - 2026-10-08

### Fixed

- Status Plus: the tool count counts each step of a chained command in a
  subagent, and each call a codemode script made. Before, it counted only
  the chains Tool Display saved, and Tool Display saves none in a subagent
  or inside a script, so the count fell further behind as a session used
  more subagents. It now counts as the folded lines do. A saved chain still
  counts the steps it ran; any other chain counts the steps in its command
  text. On a long session with subagents, the count went from 3,686 to 3,870.
- Status Plus: a chained command counts its steps while it runs, not only
  after it ends.

## 0.23.0 - 2026-10-08

### Changed

- Status Plus: the tool count counts each step of a chained command by
  default, and it is as dim as the other counters in both modes. A click or
  `/tool-display count calls` still counts one per call, and a saved choice
  stays.
- Status Plus: limit windows keep one order: the shortest window first, each
  window before its model-family window (`5h · 7d · 7d-fable`), then rate
  limits, budgets and credits. The resets follow the same order. Before,
  they took the order of their source, and Meridian lists the window it saw
  last first.
- Status Plus: the footer walks the transcript only when the branch gains an
  entry, and on its 30 s timer. A request's start, its limit headers and a
  limit poll only repaint. A walk no longer hashes each message again: on a
  4,000-entry session with subagents it takes 5 ms, not 47 ms.

### Added

- Status Plus: a provider whose models all cost nothing in Pi's model list,
  such as a local or self-hosted server, gets its own row after the paid
  ones once it has done work: `$0.00`, its airtime and its tokens. A row with
  no limits ends after its tokens, and a provider id longer than 15
  characters is cut.

### Fixed

- Status Plus: a reply's cost shows when Pi saves the reply. Before, it
  showed only after the reply's tools ran or at the next 30 s tick, because
  Pi tells extensions about a reply before it saves it.

## 0.22.8 - 2026-10-07

### Added

- Subagents: each agent's row shows its context as `48k 24%`: the size after
  its last reply and that size's share of the model's window. The percent
  turns amber above 70 and red above 90, as the footer does for main. After
  a compaction the size is `?` until the next reply, and a finished agent
  keeps its last size. The widget, the agents view, the inspector's title
  bar, the row of a child main waits on and the plain `/subagents` list all
  show it.

### Changed

- Subagents: the inspector's top rule no longer shows `ctx N%`, because its
  title bar shows the context.
- Subagents: a restore drops a saved context size that is not a positive
  number, and keeps the child.

## 0.22.7 - 2026-10-06

### Added

- Subagents: a `cwd` option on `subagent`, as an absolute path or one that
  starts with `~/`. The child starts in that directory: its tools,
  `AGENTS.md` and relative paths work from there. Its own subagents start
  there too, and a resume or a restore keeps it. A path that does not exist,
  is not a directory or has control characters is refused with what is
  wrong.
- Subagents: that directory's project settings and resources load only as
  Pi would load them without a prompt: nothing there needs trust, you
  trusted it, or `defaultProjectTrust` is `"always"`.
- Subagents: `isolation: "worktree"` makes the worktree from the repository
  at `cwd`, and the child starts in the same directory of the worktree. So a
  parent whose directory is not a repository, such as `~`, can start
  worktree children. A read-only child's subagents can't do this, because it
  runs that repository's git hooks.

### Changed

- Subagents: for files outside git, the edit lock belongs to the child's
  checkout: git's top level of its `cwd`, or that directory. Before, one lock
  covered these files for all children. Children without `cwd` still share
  the parent's. Links are resolved, so two paths to one directory are one
  checkout.
- Subagents: a refused edit names the holder and the checkout or worktree
  path, and so does the note on a `bash` command that changed files there.
- Subagents: two agents' `bash` commands that run at the same time in one git
  work tree, from different directories of it, count as one place, so
  neither one's changes are blamed on the other.
- Subagents: the inspector draws a child's tool rows against its own
  directory (its `cwd` or worktree), not the parent's.
- Subagents: the `subagent` description and schema explain `cwd` and
  `isolation`, with one example.

## 0.22.6 - 2026-10-06

### Changed

- Tool Display, folded mode: the folded lines use the darker grays of 0.22.1
  again. The words are `muted`, and the bullet and figures are `dim`.
- Phase Spinner: the end line no longer shows the prompt's tools, tokens and
  cost in folded mode. It is the same in both views:
  `π Worked for 2m04s, done 4:13 PM`. A prompt of one minute or more now reads
  in minutes, in place of only seconds (`124s`).

### Removed

- The end line no longer saves totals in its custom entry. Totals that 0.22
  saved are ignored.

## 0.22.5 - 2026-10-06

### Changed

- Tool Display, folded mode: tools without a kind of their own, such as MCP
  tools, are counted together (`used 44 tools`, or `used 2 other tools` after
  the known kinds). Only one such tool with a short name is named. When the
  words do not fit the width, the line shows the total count:
  `● Used 45 tools, ↑681k ↓6.9k 2m21s`.
- Tool Display, folded mode: the figures follow one comma, with spaces between
  them, and without the word "tokens". The end line drops "tokens" too:
  `π Worked for 11s, 5 tools, ↑1.2M ↓1.6k, $0.30, done 1:26 PM`.

## 0.22.4 - 2026-10-06

### Changed

- Tool Display, folded mode: a folded line starts with the same `●` as the
  other rows (a spinner while it is live), and its parts are joined by
  commas: `● Ran 4 commands, read 1 file, ↑875k ↓1.4k tokens, 8.8s`.
- Tool Display, folded mode: lines show the tokens sent (`↑`, cache included)
  and received (`↓`). The cost moves to the end line of the prompt only, which
  also shows `↑` and `↓`.
- Tool Display, folded mode: each step of a chained command counts as a
  command, and the calls in a codemode script count in its place.
- Tool Display, folded mode: a cut line ends in `…` without a comma before it.

## 0.22.3 - 2026-10-06

### Changed

- Tool Display, folded mode: a folded line is one block on the left. The
  figures follow the words after a `·`, as the end line reads, instead of
  sitting at the right edge. The number of calls is left out, because the
  words count them already.
- Tool Display, folded mode: a line of thinking alone says how long, for
  example `▸ Thought for 2.5s · 180 tokens · $0.07`.
- Tool Display, folded mode: the end line of a prompt uses the folded lines'
  lighter gray.

## 0.22.2 - 2026-10-06

### Changed

- Tool Display, folded mode: a reply that thinks and then writes keeps its
  thinking in a folded line, so the live `Thinking…` line no longer goes
  away when the words start. Without calls before it, the reply gets a
  `▸ Thought` line of its own, with its tokens, cost and thinking time.
- Tool Display, folded mode: folded lines use brighter grays.
- Tool Display, folded mode: a line's time also counts thinking after the
  last call, and a run of calls starts its time where the reply that made
  them stopped thinking.

## 0.22.1 - 2026-10-06

### Added

- Tool Display: folded mode, off by default. `/tool-display folded on` hides
  tool rows and thinking. Each run of work between two replies becomes one
  line, for example `▸ Ran 3 commands, read 1 file, edited 1 file`, with the
  number of calls, output tokens, cost and time at the right. While the model
  works, the line is live and its figures count up. Click a line to open its
  run; ctrl+o opens every run. The end line of a prompt adds the prompt's
  tools, tokens and cost. The setting is `toolDisplay.folded`. The `fold` key
  of the folding that 0.18.0 removed does not turn it on.

## 0.22.0 - 2026-10-05

### Added

- Subagents: model fallback. When a child's model can't serve its run
  (quota or usage limit, a rate limit, an overloaded provider, missing
  credentials, a model that is gone), the run goes on from the child's
  session on the next model of `fallbackModels`. The default is the default
  subagent model, and `[]` turns fallback off. The report says which model
  failed and which one ran, because the fallback can cost more.
- Subagents: a `tools` list on the `subagent` call gives a child only the
  tools it names. A child's own subagents never get more tools than it has.
- Subagents: a worktree child's `bash` commands run in an OS sandbox
  (`sandbox-exec` on macOS, `bwrap` on Linux when it is installed), so they
  can't write into your checkout or install into the linked `node_modules`.
  The worktree's git data and tool caches stay writable.

### Changed

- Subagents: a child's `bash` call that changes files in a checkout now
  takes its edit lock, as `edit` and `write` do. When another child holds
  the lock, the call's result says what it changed. This is found after the
  command ran; it can't be prevented.
- Subagents: the edit lock belongs to the git checkout or worktree of the
  edited file, not to the folder the child started in, so children that edit
  in different repositories or worktrees no longer block each other.
- Subagents: mail for a child that is not running, answers it is owed, and
  messages it has not read yet survive a restart or a crash. Before, unread
  messages were lost even when a run only failed or was stopped.
- Subagents: the subagents of a read-only child are read-only too.

### Fixed

- Subagents: `isolation: "worktree"` failed in a repository that has a
  `node_modules` folder and lists it in `.gitignore` (since 0.20.0).

## 0.21.0 - 2026-10-05

### Added

- Subagents: run budgets. Each run of a child stops after `maxRunMinutes`
  (default 60) and, when you set it, `maxRunCost` (US dollars). The
  `subagent` call can set `maxMinutes` and `maxCost` for one child. Time
  pauses while the child waits for an answer. A child stopped over its
  budget tells its parent so in its report, and a message resumes it with a
  fresh budget. A hung child no longer keeps `pi -p` open.

### Changed

- Subagents: the one-writer rule now starts at the first edit, not at the
  start of a child. The first child that calls `edit` or `write` in the
  shared checkout, or in one worktree, holds it until its run ends. An edit
  there by another child is refused with what to do instead. The holder's
  own subagents and parents can edit beside it. Children no longer need
  `readOnly: true` to run in parallel. `bash` is not covered.
- Subagents: a worktree child's `edit` and `write` calls must stay inside its
  worktree.
- Subagents: when a peer's message starts a new run of a finished child,
  the report of that run reaches the parent without waking it. Main reads it
  at its next turn.

## 0.20.0 - 2026-10-04

### Added

- Subagents: a `stop_subagent` tool. Main can stop a subagent and
  everything it started, and a child that may start subagents can stop its
  own. The call returns how the child ended and its last message, so no
  report follows. A message resumes it later with its context.
- Subagents: `isolation: "worktree"` gives a child its own git worktree at
  `<repo>.worktrees/<name>` on branch `subagent/<name>`. It starts from the
  parent's current files, uncommitted changes included, and links
  `node_modules`. The parent's files and index stay unchanged. The report
  counts the changed files and gives the commands to apply the changes and
  then remove the worktree. Worktrees stay until you remove them.
- Subagents: a failed or stopped child resumes when main, its parent or you
  write to it, and it is told first how its last run ended.

### Changed

- Subagents: only one writer at a time works in the shared checkout. A child
  is a writer unless `readOnly` is true. A second writer is refused with its
  options: `readOnly`, `isolation: "worktree"`, or wait for the first one's
  report. A writer's own helpers can share its checkout.
- Subagents: a child waits only on questions to main or its parent. A
  question to a peer or to its own subagent returns at once. The answer
  arrives as a message that wakes the asker, and its report waits until
  every agent it asked answers or ends, so agents can no longer wait on each
  other in a loop.
- Subagents: a child's session leaves memory when the child ends: at once
  when it failed or was stopped, after two quiet minutes when it finished.
  A message reloads it from its session file.
- Subagents: the inspector shows a child as a normal Pi chat on a tinted
  background, with live replies and clickable tool rows.
- Subagent rows show the name, time, cost and model before what the child is
  doing. The context percentage left the row.
- Rate limit recovery: `maxRecoveries` is 10 per run by default (was 3).

### Fixed

- Subagents: `pi -p` and `--mode json` no longer exit before background
  children report. Main waits for them, reads their reports, questions and
  notes, and answers a child's question so that the child can continue.
- Full-screen sheets, such as the subagent inspector, keep their background
  color after styled text that ends with a combined reset code such as
  `ESC[0;3m`.

## 0.19.3 - 2026-10-02

### Fixed

- Copy Blocks: code blocks and quotes in replies are cards with a `copy`
  label again. Since Tool Display began to draw replies in a shared bullet
  gutter (0.16.0), the gutter hid each reply from Copy Blocks, so replies
  showed plain fences and no labels. Only `/copy-block` still worked. Copy
  Blocks now finds the reply inside the gutter, and the reply keeps its
  bullet in either load order.

## 0.19.2 - 2026-10-02

### Fixed

- Subagent mail to main is no longer lost or raced around Esc and
  compaction. A note, question or report that arrived while main worked was
  steered into Pi's queue, which Esc clears, so pressing Esc dropped it, and
  `/compact` mid-run left it stuck there until something else woke main. It
  now lands at main's next turn boundary, main takes one more turn before it
  stops if it hasn't replied since, and Esc leaves it in the transcript.
  After a `/compact` that stopped main's turn, a hidden reminder naming who
  wrote wakes main to reply. Mail that arrived during a manual `/compact`
  started a turn on the uncompacted context while the summary was being
  written; it now waits and wakes main once the compaction is done, after
  any prompt you typed during it.

## 0.19.1 - 2026-10-02

### Added

- A view of every subagent at once. The widget's `(view)` or `/subagents`
  opens it over the full terminal: each agent's live row with its task under
  it, children under their parents, and a count of what they are doing and
  what they have cost on top. Use ↑↓ and Enter, or click, to open an agent's
  inspector; Esc there comes back to the list. It replaces the plain-text
  picker `/subagents` used to open.

### Changed

- The subagents widget shows up to four agents. A fifth turns the last row
  into `+2 more subagents · 2 working  (view)  (expand)` instead of a
  `+N more` line that did nothing when clicked, and it never says `+1 more`.
  The rows kept are the agents that need you first (asking, failed,
  interrupted), then those still working; finished ones give way first.
  `(expand)` shows as many rows as fit, up to all of them, while the
  transcript keeps at least half of the room the editor and footer leave;
  `(collapse)` takes them back.
- `/subagents <name>` with a name that isn't an agent says so instead of
  opening the list.

## 0.19.0 - 2026-10-02

### Changed

- Shell jobs and subagents no longer look alike. Before, both started as the
  same `↳ name  in background` chip, ran as the same gray band above the
  editor and finished as the same green band.
  - A running shell job's band now fills with its real progress. A command
    that starts with `sleep N` fills over those N seconds. A meter in the
    job's newest output line (curl, wget, rsync with `--info=progress2`, git
    with `--progress`, tqdm, ninja, pip or cargo when they draw one, or a
    percentage drawn beside a bar) fills it with what the meter says: the
    percentage, then time left (written the same for every tool), size and
    speed. A bare percentage counts only while it climbs, and a finished
    meter stops filling, since the job may still be working. Jobs with no
    known progress sweep and show their latest output line. The start row is a still gray band,
    `Title  $ command  ⇢ background`, that takes `✓ exit 0 · 29.9s`,
    `✗ exit 2` or `■ stopped` when the job ends, and the completion shows the
    last output lines in a gutter under its band. A job's details sit side by
    side, its title first, instead of across the line.
  - Subagents read like someone in a conversation, with no band behind them:
    a `◆` and name in the provider color the footer uses for its model
    (purple for a provider without one), then what the agent is doing and
    its facts close beside them. A start reads `◆ name joined  model  working`
    with the task under it, a report `◆ name reported  1m12s  model`, and mail
    `◆ name → main  asks`. The row above the editor shows its run time, what
    it is doing (with the same animation main's spinner uses for that work:
    thinking and writing in the agent's color, a tool call in the tool color, compacting, or how it
    ended), then its model, cost and context. Names and times line up, so
    what each agent is doing starts in one column. A child main waits on
    shows the same row in its `subagent` call.
  - Both inspectors keep the sheet's own background; only the title takes the
    tool color or the agent's color. A subagent's inspector shows the
    messages it received as those same rows (`→ name  you wrote`,
    `→ name  main asks`, `◆ sender → name  note`, `◆ child reported`)
    instead of the `Message from main:` and `Question from main, who is
    waiting for your reply` text its model reads.
- Times read the same on every row: `8.6s`, then `24m23s` and `1h50m`. Tool,
  job and subagent rows break into hours instead of reading `62m 05s`, and a
  bash call's timeout is in the same units as the time beside it, so
  `20m 02s / 1800s` is now `20m02s / 30m00s`. Job completions, Kagi and
  Computer Use rows use the same shape.
- While the model writes a `write` call, the phase line, the terminal tab and
  a subagent's row say `Writing main.md` instead of `Writing write call`, and
  an `edit` reads `Editing cc-phase.ts`; the file shows once its path has
  streamed in. Other calls still read `Writing bash call`, and a subagent's
  row now says that too instead of `calling a tool`.

### Added

- Usage Guard reports pace. When a window's length and exact reset time are
  known, the `usage` tool, its popup and its warnings say whether use is
  `on pace` (heading for 90% to 110% at reset), `above pace` or
  `below pace`, from the average rate since the window began. An above-pace
  limit also gives when it is expected to reach 100%. Under 5% into a window,
  or under 1% used, it says `too early to tell`. Pace doesn't change warning
  thresholds.

### Fixed

- A proxy quota rejection no longer keeps blocking after the quota resets. A
  later reset cycle, or a successful response from the model it applies to,
  clears it below 95% used; a newer quota error brings it back. Cleared
  warnings stay in history but no longer reach later requests, and a reload
  after an update keeps the stored limits and flags.
- `/tool-display motion reduced` now also holds the shell job and subagent
  spinners still, including those in their inspectors.
- A subagent's inspector no longer says `report queued` after the report has
  reached main.
- Colored job output no longer leaves codes like `[32m` in the line above the
  editor or in the completion's output lines.

## 0.18.3 - 2026-10-01

### Fixed

- Cache Compaction works in sessions where another extension, such as
  remote-pi, leaves its own notices out of requests. Pi then merges the
  session's system messages into one, and Cache Compaction didn't recognize
  that request, so it used Pi's compaction instead. It now applies the same
  merge itself and accepts it only when the result matches exactly.

## 0.18.2 - 2026-10-01

### Fixed

- Cache Compaction now runs in real sessions. Before, it skipped every
  session that starts with a startup notice, which is most of them, and
  subagents never loaded it. An expired Usage Guard warning no longer blocks
  it either. It still checks the real request before sending anything.
- The subagent panel showed `1ms` for runs restored from before 0.15.0. It now
  shows how long they ran.

### Added

- Cache Compaction logs each decision to `cache-compaction.log` in the agent
  directory: which path ran, why, the token estimates and the cache usage.
  It never logs message content.

## 0.18.1 - 2026-10-01

### Changed

- Phase Spinner: a stopwatch beside the status word shows how long the current
  step has run, such as `Thinking… 00:12.4`, so long thinking or a stalled
  request is easy to see. `Time` on the right still shows the whole prompt.
  `1 token` is now singular.
- Tab Status turns on progress by itself in Windows Terminal, including WSL
  tabs. Windows Terminal doesn't report its version, but every release since
  1.6 draws the ring and older ones ignore it. A failed turn fills the ring red,
  and a full yellow ring means Pi is waiting on you. `tabStatus.progress: false`
  turns it off.

## 0.18.0 - 2026-10-01

### Changed

- Phase Spinner's live status moved into the editor's top divider, for example
  `⢌⡱⢎ Thinking… ↓ 212 tokens ─── TPS 109.3 ─ TTFT 0.7s ─ Time 00:15.8`.
  There is one clock, and narrow terminals drop TPS, then TTFT, then tokens.
  The line under the conversation is gone; live thinking and queued messages
  stay there.
- The status names the phase in plain words: `Thinking…`, `Writing bash
  call…`, `Running bash…`, `Writing reply…`. The pie and π verbs are opt-in
  with `phaseSpinner.verbs: "playful"` or your own list.
- A finished prompt ends with `π Worked for 41s, done 9:14 PM`.

### Removed

- Tool-call folding, with `/tool-display fold` and the `fold` setting. Every
  tool row stays visible; ctrl+o still expands them all. A leftover `fold` key
  is ignored. Restart Pi after this update: `/reload` leaves the old folding
  code loaded, though it does nothing.

## 0.17.0 - 2026-10-01

### Added

- Tab Status shows Pi's state in the terminal tab. iTerm2 3.7.0+ gets a colored
  status dot with a short detail. iTerm2, Ghostty, WezTerm and Windows Terminal
  get tab progress that pauses for dialogs and Rate-limit Recovery waits and
  turns red after a failed turn. Background Subagents and Shell Jobs count as
  working. Progress turns on by itself only in terminal versions known to
  support it. Idle details say `Done`; `tabStatus.detail: "reply"` shows the
  start of the last reply instead. Settings live under `tabStatus` in
  `pi-extras.json`.

## 0.16.0 - 2026-10-01

### Changed

- Phase Spinner is redesigned: the line under the conversation reads like
  `⢌⡱⢎ Proofing… (12s, ↓ 212 tokens, thinking)`. The verb comes from a list
  of pie and π words and lasts the whole prompt; `phaseSpinner.verbs` sets your
  own. Each kind of work has its own spinner: a ping while the request goes
  out, a helix while the model thinks, a print head while it writes a tool
  call, an orbit while tools run, and a wave that follows the token rate while
  the reply streams. While the model thinks, its newest three lines show under
  the spinner. When a prompt finishes, a dotted π waves in and out and the
  transcript keeps `π Proofed for 41s, done 9:14 PM`, or `π Stopped after 12s`.
  These lines are only drawn; the model never sees them.
- Tool Display: finished calls fold into one line such as
  `● Read 2 files, ran 1 shell command`. Click it to open that run; ctrl+o
  opens every row; `/tool-display fold off` turns folding off. Running and
  failed calls never fold. Tool rows share the bullet column with the agent's
  text, a running call's bullet says what kind of call it is, and details are
  separated by commas instead of `·`. Finished thinking rests as one
  `∴ Thought for Ns` row.

## 0.15.1 - 2026-10-01

### Fixed

- Failure-log lines (for example `rate-limit-recovery.log`) are written before
  the call returns, so a line logged during shutdown is no longer lost. This
  also ends an intermittent test failure on CI.

## 0.15.0 - 2026-10-01

### Added

- Subagents survive `/reload`, restarts and crashes. A saved index brings back
  each child's name, task, settings and run count, so `message` reaches
  finished children again. Children that a `/reload` interrupted resume on
  their own, once; after a restart or crash they come back paused and main
  gets one notice. `/subagents resume <name>` continues a paused child, and
  `/subagents` lists orphaned child sessions. Change the policy with
  `subagents.resumePolicy` (`"reload"`, `"always"` or `"notify"`).

## 0.14.1 - 2026-09-30

### Fixed

- Subagents: reports longer than 12,000 characters are no longer cut short.
  Each finished run saves its full report to a private Markdown file beside
  the child session, and the completion message gives that path next to the
  preview. `/subagents report <name>` shows the latest one. Failed and stopped
  runs save any final text too. If saving fails, the message still arrives
  and points to the session file as before.

## 0.14.0 - 2026-09-30

### Added

- Cache Compaction (on by default): compaction summaries reuse the session's
  prompt cache. The summary request is the session's next turn with a
  summarization instruction added, instead of Pi's separate summarization
  prompt, which pays for the whole context again. In local tests a summary
  cost a third as much at 15k tokens of context and a sixteenth or less at
  42k. Automatic compaction needs room in the context window for the summary:
  at Pi's default `compaction.reserveTokens` (16,384), later compactions in
  long sessions often don't have it and use Pi's compaction as before, and a
  reserve of 32,768 gives them room. Anything uncertain falls back to Pi's
  compaction. Turn it off with `cacheCompaction.enabled: false` in
  `pi-extras.json`.

## 0.13.0 - 2026-09-30

### Changed

- pi-extras requires Pi 0.99.2 and from now on follows Pi's latest release.
  Older Pi versions are no longer tested; update Pi along with pi-extras.
- Phase Spinner shows what the agent is doing on a line of its own right
  under the conversation, instead of at the left of the editor border.
  Messages queued for the agent show below that line, and the border keeps
  tokens per second, time to first token and the run's time. Phases read as
  a sentence: Preparing, Sending request, Waiting for first token, Thinking,
  Writing, Calling `<tool>`, Running `<tools>`. The line relies on Pi's
  interactive layout; if a Pi update changes it, the phase goes back to the
  border.
- Transcript rows (tool calls, background jobs, subagents, agent mail and
  compaction) keep two columns at their left, and their content moves two
  columns right. A spinner turns there while the model writes the call or it
  runs, in step with the main spinner; a still dot marks a call waiting its
  turn.
- Copy Blocks: code blocks and quotes ten rows or taller have a `copy` label
  at their foot too, so one is in view from either end.

### Fixed

- Rows in the transcript no longer draw wider than a very narrow terminal,
  which made Pi stop drawing.

## 0.12.7 - 2026-09-30

### Fixed

- Cross-agent communication uses a shared purple band: mesh `agent_send` and
  `agent_request`, subagent `message` calls and incoming mail. Questions and
  delivery failures keep amber or red rail words; reports keep outcome colors.
- Incoming remote-pi mesh messages render as expandable Markdown with a readable
  sender and reply rail, instead of a raw custom-message block. Transport
  instructions stay in model context but are hidden from the human view.
- Numbered bash steps and codemode calls keep one cell width past nine, so the
  chips, commands and step output stay aligned (for example 9 and 10).
- Subagent and mesh mail bodies no longer reach the Markdown parser when they
  are very large or deeply nested: 2,000 nested list items could exhaust the
  heap and end the Pi process. Such bodies show as bounded plain text. Bodies
  are laid out once and reused across redraws instead of re-parsed each frame.

## 0.12.6 - 2026-09-30

### Fixed

- Usage Guard warnings stop reaching the model once their window resets. A
  delivered notice such as "5h is at 98%, sleep until the reset" previously
  stayed in every later request for the same provider, even hours after the
  reset. It remains in raw history but is omitted from the model's context.

## 0.12.5 - 2026-09-30

### Fixed

- Usage Guard no longer queues idle warnings that can reach a different model
  after a switch. Each request checks the active provider and model family,
  including background-job wakeups and queued follow-ups. Obsolete automatic
  notices remain in raw history but are omitted from unrelated models' context.
  Undelivered idle warnings do not count as fired; unknown models fail closed.
- Codemode no longer reports incomplete call history merely because a large
  nested-output preview was truncated. Genuinely missing calls or incomplete
  saved records still show the warning, including during live execution.

### Changed

- Codemode displays a bounded preview of the newest JavaScript lines while
  arguments stream, including collapsed rows. Before source arrives it shows
  “Writing JavaScript…”. Draft source never implies calls are queued or running.

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
