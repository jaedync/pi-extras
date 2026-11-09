# Formal check: subagent mail to main

This folder holds a Quint model of how subagent mail reaches the main session.
It also holds the TLC checks, the traces that a test replays against the code,
and a live repro. The `formal-verification` skill made it
(`skills/formal-verification`).

## The promise

The doc comment of `lib/subagents/deliver.ts` and the owner's brief say this:

- Each note, question, answer, relay and report that a child sends to main
  reaches main's transcript one time. It is not lost, and it does not come two times.
- This stays true across main's turns, the settle check, `agent_settled`,
  Esc, `/compact`, a failed send, a retry and a `/reload` hand-over.
- Mail that must wake main wakes it. A `/compact` that stops main's turn gets
  a reminder for the mail that landed in that turn (`remind`).
- The mailbox becomes idle (`idle()`, `HostState.quiet()`) only when nothing
  is left to deliver.

The harm when the promise breaks: main does not see a report, sees it two
times, or does not reply to a question. A child that waits for an answer then
waits until its reply timeout.

## Why this target

Ten fix commits touch this code (e80d68e, 475866a, 8d54da9, bcad086, 642ba00,
09cff98, 2f2efa6, 35c15ac, dffc11f, 29401a8). The code has a retry timer,
an outbox, a batch, held mail during a reload and a reminder after a
compaction. Each of these depends on the order of Pi events. Example tests
check some orders. TLC checks all of them within the bounds.

## Properties

| Invariant | In plain words |
|---|---|
| `landedOnce` | No mail item is in main's transcript two times. |
| `noLoss` | Each mail item that a child sent, or that the mail made, is in one of these places: the outbox, the batch, a Pi queue, the index, or the transcript. |
| `noCopy` | Each mail item is in one place only. |
| `ackMeansLanded` | The widget removes a pending item only after the item is in the transcript. |
| `idleMeansLanded` | When the host from before a reload is idle, every item (but the hidden reminder) is in the transcript. |
| `wokenForMail` | When nothing is left to run (no run, no deferred action, no timer, no compaction, no reload), main has replied after each waking item in the transcript, unless the user stopped that run with Esc. |

## What the model covers

Each action is one synchronous segment of the code: the code between two
`await`s. TLC tries every order of these segments.

Source files covered (for a mutation-testing tool):

- `lib/subagents/deliver.ts`
- `lib/subagents/main-watch.ts`
- `lib/subagents/contract.ts`
- `lib/subagents/host-state.ts` (`rebind`, `quiet`, `close`, `handOverMail`, `postKeptMail`)
- `lib/subagents/host.ts` (`PortBinding`: `send`, `route`, `bind`, `park`, `beginClose`, `close`)
- `lib/subagents/serve.ts` (`serve`, `Service.start`, `Service.park`)
- `extensions/subagents.ts` (the `message_end`, `turn_end`, `agent_end`, `agent_settled` and `session_shutdown` handlers, `watchPending`)

The parts of Pi 1.4.0 that the mail depends on. Each was read in
`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
(as) and `pi-agent-core/dist/agent-loop.js`:

- `sendCustomMessage` (as:1844-1883). With `triggerTurn`, it steers into an
  active run, defers while `agent_settled` handlers run, or starts a run.
  Without `triggerTurn`, it holds the message in `_pendingCustomMessages`
  while a run is active, else it appends the message at once. An append
  sends no extension event, so only a reconcile can acknowledge it.
- `isStreaming` and the run flag are the same flag (as:1068-1074). So the
  route `wake` (Pi is idle) never steers. The model keeps a steering queue to
  show this: `mutant-steer-while-working` puts mail there, and Esc loses it.
- `_startRun` (as:1424-1471). It flushes the held messages before
  `agent_start`. The starting messages then get `message_end`
  (agent-loop.js:55-60). The extension handlers run before Pi persists the
  message (as:752-760).
- The held messages are flushed after the `turn_end` handlers (as:796-798),
  after the `agent_before_settle` handlers (as:1573), and in the `finally` of
  a run (as:1467-1470).
- The settle boundary context holds the held messages as `pendingMessages`
  (as:612-614).
- `_emitAgentSettled` runs the deferred actions one at a time, and each one
  can start a run with its own `agent_settled` (as:683-701).
- `/compact` aborts the run without a clear of the queues and waits for idle
  (as:2230-2232). Esc in the TUI clears the queues and aborts
  (interactive-mode.js:3853, as:1971-1982).
- `/reload` refuses while a run is active or Pi compacts
  (interactive-mode.js:5328-5336). It emits `session_shutdown`, then builds
  the new runtime, then emits `session_start` (as:2998-3031).
- A prompt checks for a compaction only before its input handlers
  (as:1648-1652).
- An abort during the settle check only marks `_abortDuringBeforeSettle`
  (as:1978-1979). The other `agent_before_settle` handlers still run. The
  boundary then ends with no continue and with no new `agent_end`
  (as:1572-1580). `agent_settled` says `aborted: true` (as:686-688).
  `repro-f3.mts boundary` confirms this in a real `AgentSession`: the events
  are `agent_end stop`, then `agent_settled aborted=true`.
- A manual compaction that an extension cancels, that Esc aborts during the
  summary, or whose summary fails, sends `session_compact_failed` with
  `aborted` true for the first two (as:2263-2266, :2331-2350).
  `repro-f3.mts cancel` confirms the cancel in a real `AgentSession`.

## Bounds and what they leave out

The model has 3 child mail items (a note, a relay and one report), the
reminder, 1 user prompt, 1 Esc, 1 `/compact`, 1 `/reload` and 1 failed send.
Inside these bounds the check is exhaustive. The full bounds together did not
finish in 25 minutes on 2 TLC workers. So the pass checks split them:
`assume-fixes` (no reload, no failed send), `assume-fixes-fail` (no reload),
and `assume-fixes-reload` (no failed send, no `/compact`). The faithful check
and the `f` checks use the full bounds or a stated subset.

The model does not cover:

- More mail, more children, more prompts, aborts, compactions or reloads.
- Spawn groups (`groupWaitMs`, `release`), panels, quiet reports, questions
  that a restore rewrites (`keptForNow`), and the text of each message.
- Headless runs (`holding`, `takeAll`, `awaitChildren`).
- A quit, and a session switch (`/new`, `/resume`, `/fork`). These close the
  host with a module still bound, and `handOverMail` sends with `triggerTurn: false`.
- The renew swap of `serve.ts` (`lookForQuiet`, `renew`). The model checks
  only its condition (`idleMeansLanded`).
- An abort while a run is in `_prepareRun`, an abort in RPC mode that keeps
  the queues, automatic compaction, and a branch summary.
- A run that a prompt starts during a compaction (Pi allows it after the
  input handlers). The model drops that prompt.
- A failed `_prepareRun`: Pi then drops the starting message, and the
  rejection goes to `emitError` (as:2765-2771). Not checked.
- `RECONCILE_WINDOW` (200 entries), `STOP_WINDOW_MS`, `PENDING_INPUT_MS`.
  The model reads `lastSaid(ctx) === stopMark` as "nothing was appended since".
- The fake transcript has no aborted assistant message after Esc.
- An abort in the settle check that comes before our handler runs our
  handler in the same step. In the code, other segments can run between them.
- A report of a child that the user stopped does not wake main
  (deliver.ts:188). The model always lets the report wake main.
- Each turn end counts as a finished reply. The model has no error or retry
  turns, so it does not model `isReply` in `answered()` (deliver.ts:72-75).
- `/tree` (`navigateTree`, as:3262-3267) and the summary of a branch.
- Liveness: the model checks safety. `wokenForMail` checks the quiet states only.

## Results (sync commit `343e195`)

Run `node skills/formal-verification/scripts/fv.mjs check formal/subagents-mail --workers 1`.
`results.json` holds the last run. Other agents share the Apalache server on
port 8822. A check that gives `error` lost that port race; run it again with `--only`.
In the last run, no check gave `error`.

| Check | Expect | Result |
|---|---|---|
| `faithful` | violates `wokenForMail` | violation (path F1), depth 9 |
| `f1-wake-mail-no-reminder` | violates `wokenForMail` | violation (path F1), depth 9 |
| `f2-quiet-append-cancels-reminder` | violates `wokenForMail` | violation (path F2), depth 10 |
| `f3-abort-in-settle-check` | violates `wokenForMail` | violation (path F3), depth 12 |
| `f4-failed-compaction` | violates `wokenForMail` | violation (path F4), depth 9 |
| `assume-fixes` | pass | pass, 50,238 states |
| `assume-fixes-fail` | pass | pass, 120,491 states |
| `assume-fixes-reload` | pass | pass, 48,621 states |
| `mutant-failed-send-dropped` | violates `noLoss` | violation |
| `mutant-steer-while-working` | violates `noLoss` | violation |
| `mutant-no-owing` | violates `wokenForMail` | violation |
| `mutant-route-ignores-settling` | violates `wokenForMail` | violation |
| `mutant-not-remembered` | violates `ackMeansLanded` | violation |
| `mutant-reconcile-ignores-transcript` | violates `ackMeansLanded` | violation |
| `mutant-close-without-drain` | violates `noLoss` | violation |
| `mutant-kept-mail-not-forgotten` | violates `noCopy` | violation |
| `mutant-drain-skips-batch` | violates `noLoss` | violation |
| `mutant-send-keeps-outbox` | violates `landedOnce` | violation |
| `mutant-idle-ignores-pending` | violates `idleMeansLanded` | violation |
| `survivor-idle-ignores-outbox` | pass | pass |
| `survivor-stop-mark-ignores-checked` | pass | pass |

Each invariant has at least one mutant that breaks it. Four mutants copy the
code before a fix: `mutant-failed-send-dropped` (642ba00),
`mutant-steer-while-working` (e80d68e), `mutant-close-without-drain` (bcad086)
and `mutant-drain-skips-batch` (bcad086).

One mutant survived: `survivor-idle-ignores-outbox` (idle() without
`this.outbox.length === 0`, deliver.ts:204). Each item in the outbox is also
pending, because the mail remembers it before it posts it. The exception is
the hidden reminder, and `idleMeansLanded` leaves the reminder out. Without
the check, a held reminder lets the host go quiet, and the renew swap
(serve.ts `renew`) then disposes it. The model does not model `renew`, so no
property sees this. The guard is needed; the model is too small to show it.

A second survivor: `survivor-stop-mark-ignores-checked` (the stop mark
without `|| !checked`, main-watch.ts:124). In the code, `!checked` marks a
run that ended between turns, for example while it waited to retry. The
model has no such run (no error or retry turns), so no behavior needs the
guard. The replay did not catch this change either.

The earlier scan said "A failed send to main loses the message and keeps the
mail busy". Commit 642ba00 fixed it. `assume-fixes-fail` passes with a failed
send, and `mutant-failed-send-dropped` shows the old code lost the item.

Model errors that the checks found and that were fixed (each one judged against the code):

- `idleMeansLanded` first included the reminder. The code does not keep the
  reminder as pending on purpose (deliver.ts:309-314). The property now leaves it out.
- A prompt started a run during a compaction, and then Esc and the end of the
  compaction came in a rare order. Pi allows the first step, but the case is
  outside the promise. The model now drops that prompt (see the bounds).
- The replay showed two more errors: `agent_end`'s reconcile runs before the
  `finally` flush, and `resend` runs `sendWaiting` after each item.
- The review found this error: `userAbort` and `compactMidRun` set
  `stoppedRun` on each abort. Pi sends no new `agent_end` for an abort in the
  settle check. The model and the replay's fake Pi copied the error, so the
  replay could not catch it, and `assume-fixes` passed with a false result.
  The model now follows Pi, and F3 is the bug that the error hid.

## Finding F1: waking mail that starts main's turn gets no reminder after /compact

Status: confirmed in a real Pi `AgentSession` (Pi 1.4.0, faux provider, the
real `MainMail` and `watchMain`). TLC checks `faithful` and `f1-wake-mail-no-reminder`, depth 9.

1. Main is idle. A child sends a note (or a question). `dispatch` sends it
   with `triggerTurn: true`, because the route is `wake` (deliver.ts:393).
   It does not add the note to `owing`. Only the route `queue` does that (deliver.ts:394).
2. Pi starts a run with the note as its starting message. The note lands.
3. Before main replies, the user runs `/compact`. Pi aborts the turn and
   waits for idle (as:2230-2232).
4. `agent_settled` sets the stop mark. `session_before_compact` sets
   `compactionStopped` (main-watch.ts:137-140).
5. `session_compact` calls `remind()` (main-watch.ts:80). `owing` is empty, so
   `remind` returns at once (deliver.ts:316).
6. Nothing wakes main again. Main never replies to the note.

**Harm.** Low to medium. The user ran `/compact`, so the user is at the
keyboard. But main does not answer the child. A question then waits for the
reply timeout. The same mail that lands one moment later, while main works,
gets the reminder. So the rule depends on a race.

**Live repro.** `node formal/subagents-mail/repro-f1.mts`:

```json
{
  "path": "bug: note started the turn",
  "seen": ["turn (sees note)", "summary"],
  "turnsAfterCompaction": 0,
  "reminded": false,
  "transcript": "system > user > assistant > user > assistant > note > assistant > COMPACTION"
}
```

The last `assistant` is the aborted reply. The control
`node formal/subagents-mail/repro-f1.mts --control` puts the note into a user
turn instead:

```json
{
  "path": "control: note during a user turn",
  "seen": ["turn", "summary", "turn (sees note) (reminded)"],
  "turnsAfterCompaction": 1,
  "reminded": true,
  "transcript": "system > user > assistant > user > assistant > user > assistant > note > COMPACTION > note > assistant"
}
```

**Fix options (not made; the owner decides).**

- In `dispatch`, add waking mail that starts a turn to `owing` too. Then
  `owed()` must keep an owed id that is not in the context yet (it can wait
  in Pi's deferred actions). The variant `OWE_WAKE_MAIL = true` models both
  parts. All properties hold with it (`assume-fixes*`). With only the first
  part, TLC finds a new path: `owed()` drops the id while Pi still defers it.
  Risk: when Pi drops the starting message (a failed `_prepareRun`,
  as:1428-1434), the id never lands. `owed()` then returns true at each
  settle check, and main never settles. This removes the guarantee that
  owed mail "can't loop" (deliver.ts:275-279). The model leaves out a failed
  `_prepareRun`, so it cannot show this. A fix must drop an owed id that has
  not landed by a later point, for example when the run that it started settles.
- Neither option corrects F3.
- Or let `compacted()` remind for any waking mail after main's last finished
  reply, read from the branch, not from `owing`.

## Finding F2: a quiet append cancels the reminder

Status: confirmed in a real Pi `AgentSession` (Pi 1.4.0, faux provider, the
real `MainMail` and `watchMain`). TLC check `f2-quiet-append-cancels-reminder`, depth 10.

1. Main works on a user turn. A note arrives. The route is `queue`, so the
   note is owed (deliver.ts:394).
2. The user runs `/compact`. Pi aborts the turn. The note lands in the
   run's `finally` flush. `agent_settled` sets `stopMark` to the last entry
   (main-watch.ts:124).
3. Before the compaction starts, a message that does not wake main is
   appended: for example a relay of what the user told a child
   (deliver.ts:157-162), sent with `triggerTurn: false` while Pi is idle.
4. `session_before_compact` compares `lastSaid(ctx)` with `stopMark`
   (main-watch.ts:138). They differ, so `compactionStopped` is false.
5. `session_compact` sends no reminder. Main never replies to the note.

**Harm.** Low. The window is the time between the stopped turn and the start
of the compaction, usually milliseconds. An append from another extension in
that window has the same effect.

**Live repro.** `node formal/subagents-mail/repro-f2.mts` appends the relay
from an `agent_settled` handler that runs after main-watch's handler:

```json
{
  "path": "relay appended as the stopped run settles",
  "seen": ["turn", "summary (sees note)"],
  "turnsAfterCompaction": 0,
  "reminded": false,
  "transcript": "system > user > assistant > user > assistant > user > assistant > note > note > COMPACTION"
}
```

The control `node formal/subagents-mail/repro-f2.mts --control` has no relay,
and main is reminded: `"seen": ["turn", "summary", "turn (sees note) (reminded)"]`.

**Fix options.** Compare the stop mark with the last entry that is not a
quiet message from this extension. Or keep "a /compact stopped this run" as
a flag that main's next reply or the user's next prompt clears. The variant
`QUIET_KEEPS_MARK = true` models the first option.

Note from the review: the repro forces the relay from another
`agent_settled` handler. The review found no path where MainMail itself puts
quiet mail into that window. The first option ignores only this extension's
quiet messages, so appends from other extensions still cancel the reminder.
The second option, a flag, is more robust.

## Finding F3: a /compact during the settle check gets no reminder

Status: confirmed in a real Pi `AgentSession` (Pi 1.4.0, faux provider, the
real `MainMail` and `watchMain`). TLC check `f3-abort-in-settle-check`,
depth 12. The review of this record found it (R1).

1. A note lands while main works on a user turn. The route is `queue`, so
   the note is owed (deliver.ts:394).
2. Main's last turn ends. The settle check starts. Main-watch's
   `agent_before_settle` handler finds the owed note and returns
   `continue: true` (main-watch.ts:103-114). Another extension's handler
   then awaits I/O.
3. The user runs `/compact`. Pi aborts during the settle check
   (as:1978-1979). The boundary ends with no continue, and Pi sends no new
   `agent_end` (as:1572-1580).
4. `stoppedRun` is false (from the earlier `agent_end`) and `checked` is
   true. So `agent_settled` sets no stop mark (main-watch.ts:124).
5. `session_before_compact` does not set `compactionStopped`
   (main-watch.ts:137-140). No reminder comes, and main never replies.

**Harm.** Low. No handler in pi-extras awaits I/O at that point, so the
window needs another extension. But the reminder rule then depends on a race.

**Live repro.** `node formal/subagents-mail/repro-f3.mts boundary` (exit 1):

```json
{
  "mode": "boundary",
  "piEvents": ["agent_end stop", "agent_settled aborted=true"],
  "seen": ["turn", "summary"],
  "reminded": false,
  "replied": false,
  "transcript": "system > user > assistant > user > assistant > user > assistant > note > COMPACTION"
}
```

The control `node formal/subagents-mail/repro-f3.mts control` (exit 0) runs
`/compact` while the turn streams:
`"piEvents": ["agent_end aborted", "agent_settled aborted=true", "agent_end stop", "agent_settled aborted=false"]`,
`"seen": ["turn", "summary", "turn (sees note) (reminded)"]`.

**Fix option.** Set the stop mark also when `agent_settled`'s
`event.aborted` is true (as:686-688). The variant
`STOP_FROM_SETTLED_EVENT = true` models it, and `assume-fixes*` assume it.

## Finding F4: a cancelled /compact gets no reminder

Status: confirmed in a real Pi `AgentSession`. TLC check
`f4-failed-compaction`, depth 9. The review of this record found it (R2).

1. A note lands while main works on a user turn. It is owed.
2. The user runs `/compact`. Pi stops the turn, and the note lands.
   `compactionStopped` becomes true (main-watch.ts:137-140).
3. An extension returns `cancel` from `session_before_compact`, or the user
   presses Esc during the summary. Pi sends `session_compact_failed` with
   `aborted: true` (as:2263-2266, :2331-2350).
4. `compacted(event.reason === "manual" && !event.aborted)` gets false
   (main-watch.ts:142). No reminder comes, and main never replies.

A summary that fails (`aborted` false) does send the reminder.

**Harm.** Medium for a cancel by an extension: the user did not stop main.
Low for Esc during the summary: the user stopped something, but it was the
compaction, not main's reply.

**Live repro.** `node formal/subagents-mail/repro-f4.mts` (the `cancel` mode
of `repro-f3.mts`, exit 1):

```json
{
  "mode": "cancel",
  "compactError": "Compaction cancelled",
  "piEvents": ["agent_end aborted", "agent_settled aborted=true"],
  "seen": ["turn"],
  "reminded": false,
  "replied": false,
  "transcript": "system > user > assistant > user > assistant > user > assistant > note"
}
```

The control is `repro-f3.mts control` (exit 0, reminded).

**Fix options.** Remind on `session_compact_failed` too when the compaction
stopped main's turn. The variant `REMIND_ON_FAILED_COMPACT = true` models
it. Or remind only when an extension cancelled (Pi does not tell the two
cases apart in the event; the code must read `fromExtension` or keep its own record).

## Other points from the review (no repro)

- **`/tree`, medium-low.** `navigateTree` refuses while a run is active or
  Pi compacts (as:3262-3267), and held mail waits on the route, so no mail is
  lost. One gap: a quiet append at idle (a relay or a quiet report) is
  acknowledged only by the 1 s reconcile (extensions/subagents.ts:49,
  :327-336). If the user goes to another branch with `/tree` before that tick,
  the entry is not on the branch. The pending item then stays, the widget
  shows it, and `idle()` stays false, so no renew swap happens.
- **Session switch, medium-low.** `teardownCurrent` waits for `abort()`,
  then sends `session_shutdown` (agent-session-runtime.js:102-113). The wait
  includes the deferred actions, so mail deferred in `agent_settled` starts a
  full run in the old session while the user switches. `Host.close` then
  posts the outbox with `triggerTurn: false` (host-state.ts:317-323). The
  mail lands one time in the old session, but main does not reply to it.
  `owing` is cleared, so a `/resume` back sends no reminder. Nothing goes to
  the index, so nothing comes two times.

## Five weakest points of the model

1. Until the review, `stoppedRun` was forced true on each abort (now fixed; F3).
2. Until the review, it had no `session_compact_failed` (now added; F4).
3. Each turn end counts as a finished reply: no error or retry turns, and no
   `isReply` in `answered()`.
4. A macrotask gap is allowed between the abort and `compactStart`, and
   between `compactIdle` and `compactStart`. In the code, `compact()`
   continues in microtasks after `abort()` resolves (as:2231-2232). This only
   adds paths, so it is safe for a pass. It can give a path that the code
   cannot take, so each violation was judged against a live repro.
5. The replay's fake Pi copies the model's Pi rules. Only the repros check
   Pi itself. The replay does not compare the main-watch flags (`running`,
   `settling`, `checked`, `stoppedRun`, `stopMark`, `compactionStopped`).
   They are private to `watchMain`, and the replay sees them only through
   the route and through the reminder that the mail posts.

## How the model stays true to the code

- `tests/subagents-mail-conformance.test.mts` replays 159 model traces (150
  random, 9 witnesses) against the real `MainMail`, the real `watchMain` and
  the real `PortBinding`. After each step it compares the outbox, the pending
  items, `owing`, the batch, both timers, `closed`, the route, `idle()`, the
  index, and where Pi holds each message.
- The test copies a few lines that it cannot run: the event handlers of
  `extensions/subagents.ts:337-360`, `Host.rebind`, the drain and
  `handOverMail` of `Host.close`, and the resend of `postKeptMail`. Each copy
  names its source line. The replay does not check these copies.
- Its Pi is a fake that follows the model's Pi rules. `repro-f1.mts`, `repro-f2.mts` and
  `repro-f3.mts` (with `repro-f4.mts`) check the rules of F1 to F4 in a real
  `AgentSession`. The replay does not compare the main-watch flags (see the
  weakest points). The other rules are checked by
  reading Pi's source only.
- The second test replays the F1 witness and confirms that the code ends in
  the state of the finding.
- The replay caught 8 of 9 one-guard changes to the real code, and
  `git diff -- lib extensions` was empty after each restore:
  1. no `this.outbox.unshift` after a failed send (deliver.ts:267);
  2. `wakes` alone choosing `triggerTurn` (deliver.ts:393);
  3. no `this.owing.set` (deliver.ts:394);
  4. `running` instead of `running && !settling` (main-watch.ts:149);
  5. `acknowledge` without the `pendingItems.delete` (deliver.ts:339);
  6. `drain` returning nothing (deliver.ts:229);
  7. `compacted` without `remind()` (main-watch.ts:80);
  8. `session_compact_failed` without `!event.aborted` (main-watch.ts:142).
  It missed one: the stop mark without `|| !checked` (main-watch.ts:124).
  No model behavior needs that guard (see `survivor-stop-mark-ignores-checked`).

## Test coverage table

Input for a later task that deletes tests after mutation testing. No test was
deleted or changed.

| Test file (tests) | Covered by | Verdict |
|---|---|---|
| `tests/subagents-deliver.test.ts`: "notes, questions and replies all wake main", "what the user said to a child directly is recorded without waking main" | the replay (send options of each kind), `wokenForMail` | keeps value: it checks the message text and the kinds `question` and `reply`, which the model leaves out; guards 2f2efa6 |
| same file: "everything stays pending until Pi appends it", "messages Pi appended silently are found in the transcript" | `ackMeansLanded`, `mutant-reconcile-ignores-transcript`, replay | covered by the model |
| same file: "nothing is sent or scheduled after dispose", "held mail is dropped with the session" | none: the model never calls deliver, flush or retry on a closed mail, and calls dispose only through drain | keeps value |
| same file: the batch and group tests ("reports close together...", "a report waits for the rest of its group...", "a held report is released after groupWaitMs...") | the batch only (one report) | keeps value: groups and batching of several reports are outside the model |
| same file: "a report of a child the user stopped does not wake main", "a report whose run already answered main...", "an ordinary report summary carries tokens..." | none | keeps value: report text and wake rules from records (dffc11f, 09cff98) |
| same file: "while main compacts, mail waits...", "held mail goes out on its own, in order..." | replay, `noLoss`, the order of the outbox | covered by the model |
| same file: "while main works, mail lands at its next turn boundary...", "a report that wakes main is owed a reply when it lands mid-run" | `mutant-steer-while-working`, `mutant-no-owing`, replay | covered by the model |
| same file: "mail main need not answer is never owed, and mail compacted away stops being owed..." | `compactEnd(drop)` and `owed` in the replay, partly | keeps value: the stopped report that does not wake main is not in the model |
| same file: "after a /compact stops main, a hidden reminder wakes it...", "with nothing owed there is no reminder", "mail main has replied after... is no longer owed" | `wokenForMail`, replay, change 7 | partly covered: the replay does not compare the main-watch flags, so these rows are weaker than they look; keeps value for the reminder text and the names it lists |
| same file: "main's reply to mail it owed is a change..." (29401a8), "mail that leaves the outbox on a retry tells the listener..." (475866a) | none (the model does not model `onChange`) | keeps value: guards 29401a8 and 475866a |
| same file: "a send that fails keeps the mail to main...", "a failed send is tried again on the retry timer" | `mutant-failed-send-dropped`, change 1 | covered by the model; guards 642ba00 |
| `tests/subagents-main-watch.test.ts` (7) | the route in every replay step, changes 4, 7 and 8 (the flags only through the route) | covered by the model for the route; keeps value for `STOP_WINDOW_MS`, `PENDING_INPUT_MS` and the headless `hold` (d6ffa9f) |
| `tests/subagents-main-mail-sdk.test.mts` (9) | the same paths as model traces, but against real Pi | keeps value: it checks the Pi rules that the replay's fake Pi assumes (e80d68e) |
| `tests/subagents-host.test.ts`: the tests of bcad086 (mail held during a /reload when the takeover falls back) | `mutant-close-without-drain`, `mutant-drain-skips-batch`, `mutant-kept-mail-not-forgotten`, change 6 | covered by the model for the order; keeps value for the index file I/O |
| `tests/subagents-host.test.ts`: the other tests | none | keeps value: restore, lease and notice rules outside this model |
| `tests/subagents-reload-sdk.test.mts` (5) | `assume-fixes-reload` | keeps value: it runs a real Pi reload (bcad086, 75bd3f5) |
| `tests/subagents-serve.test.ts` (7) | none | keeps value: scope, trust and settings, outside this model |
| `tests/subagents-swap-mail.test.ts` (6) | none | keeps value: swap mail in team.ts (8d54da9), outside this model |
| `tests/subagents-resume-mail.test.ts` (12) | none | keeps value: a child's inbox, not main's mail |
| `tests/subagents-panel.test.ts`, `subagents-budget.test.ts`, `subagents-peer-runs.test.ts`, `subagents-review-loop.test.ts`, `subagents-team-status.test.ts`, `subagents-sdk.test.mts`, `subagents-ux-sdk.test.mts`, `subagents-host-contract.test.ts`, `link-context-host-guard.test.ts` | none | keeps value: they use `MainMail` for team behavior, text or the contract version |

## Open items

- A fresh reviewer read the actions against the code and Pi. This version
  applies its corrections (F3, F4, the citations and the coverage table).
  No second review read the corrected model.
- The full bounds in one pass check do not finish in 25 minutes on 2 workers.

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs check formal/subagents-mail --workers 1
node skills/formal-verification/scripts/fv.mjs check formal/subagents-mail --only faithful --trace
node skills/formal-verification/scripts/fv.mjs traces formal/subagents-mail
node --import ./tests/support/keep-alive.mjs --test tests/subagents-mail-conformance.test.mts
node formal/subagents-mail/repro-f1.mts
node formal/subagents-mail/repro-f1.mts --control
node formal/subagents-mail/repro-f2.mts
node formal/subagents-mail/repro-f2.mts --control
node formal/subagents-mail/repro-f3.mts boundary
node formal/subagents-mail/repro-f3.mts cancel
node formal/subagents-mail/repro-f3.mts control
node formal/subagents-mail/repro-f4.mts
node skills/formal-verification/scripts/fv.mjs drift formal/subagents-mail
```
