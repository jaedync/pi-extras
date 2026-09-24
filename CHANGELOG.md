# Changelog

Versioning rules are in [CONTRIBUTING.md](CONTRIBUTING.md#versioning).

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
