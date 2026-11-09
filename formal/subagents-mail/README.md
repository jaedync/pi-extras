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
- Pi stops the `session_before_compact` emit at the first handler that
  returns `cancel` (`core/extensions/runner.js:820-824`). The handlers of
  extensions that load later do not run. `repro-f4-order.mts` confirms this.
- Pi clears the compaction state (as:2335) before it emits
  `session_compact_failed` (as:2344). So Pi is idle in that event, and the
  route is `wake`.

## Bounds and what they leave out

The model has 3 child mail items (a note, a relay and one report), the
reminder, 1 user prompt, 1 Esc, 1 `/compact`, 1 `/reload` and 1 failed send.
Inside these bounds the check is exhaustive. The full bounds together did not
finish in 25 minutes on 2 TLC workers. So the pass checks split them:
`faithful-no-reload` (no reload, no failed send), `faithful-fail` (no
reload), and `faithful-reload` (no failed send, no `/compact`). The
`faithful` and `before-fixes` checks use the full bounds. Each mutant uses
the bounds of its base check.

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
  (deliver.ts:196). The model always lets the report wake main.
- Each turn end counts as a finished reply. The model has no error or retry
  turns, so it does not model `isReply` in `answered()` (deliver.ts:73-76).
- `/tree` (`navigateTree`, as:3262-3267) and the summary of a branch.
- Liveness: the model checks safety. `wokenForMail` checks the quiet states only.

## Results (sync commit `86b79d5`, after the fixes)

Run `node skills/formal-verification/scripts/fv.mjs check formal/subagents-mail --workers 1`.
`results.json` holds the last run (23 of 23 checks gave the expected result).
Other agents share the Apalache server on port 8822. A check that gives
`error` lost that port race; run it again with `--only`.

The model now describes the code with the fixes of F1 to F4. The fix
switches (`OWE_STARTED_MAIL`, `CUSTOM_KEEPS_MARK`, `STOP_FROM_SETTLED_EVENT`,
`REMIND_FROM_STOP_MARK`) are `true` in `mail.qnt`. A mutant turns one off.
The three pass checks have the bounds of the old `assume-fixes`,
`assume-fixes-fail` and `assume-fixes-reload` checks.

| Check | Expect | Result |
|---|---|---|
| `faithful` | violates `witnessNoFallback` | violation, depth 4 (the full bounds reach a fallback hand-over; the traces come from this variant) |
| `faithful-no-reload` | pass | pass, 77,471 states (no reload, no failed send) |
| `faithful-fail` | pass | pass, 182,231 states (no reload) |
| `faithful-reload` | pass | pass, 65,229 states (no failed send, no `/compact`) |
| `before-fixes` | violates `wokenForMail` | violation (path F1), depth 9 |
| `mutant-f1-started-mail-not-owed` | violates `wokenForMail` | violation (path F1), depth 9 |
| `mutant-f2-custom-message-clears-mark` | violates `wokenForMail` | violation (path F2), depth 10 |
| `mutant-f3-stop-mark-ignores-aborted` | violates `wokenForMail` | violation (path F3), depth 12 |
| `mutant-f4-failed-compaction-no-reminder` | violates `wokenForMail` | violation (path F4), depth 9 |
| `mutant-f4-old-fix-handler-order` | violates `wokenForMail` | violation (path F4, cancel first), depth 9 |
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

Old check names, as the history below uses them: `faithful` (before the
fixes) is now `before-fixes`; `f1-wake-mail-no-reminder`,
`f2-quiet-append-cancels-reminder`, `f3-abort-in-settle-check`,
`f4-failed-compaction` and `f4-old-fix-handler-order` are now the
`mutant-f1` to `mutant-f4` checks; `assume-fixes`, `assume-fixes-fail` and
`assume-fixes-reload` are now `faithful-no-reload`, `faithful-fail` and
`faithful-reload`. Line numbers in this record are for `86b79d5`, also in
the text that describes the code before the fixes.

Each invariant has at least one mutant that breaks it. Each of the four
fixes has a mutant that turns it off and breaks `wokenForMail`. Four mutants
copy the code before an older fix: `mutant-failed-send-dropped` (642ba00),
`mutant-steer-while-working` (e80d68e), `mutant-close-without-drain` (bcad086)
and `mutant-drain-skips-batch` (bcad086).

The pass checks have the same bounds as before the fixes. They have more
states, because the model has the new variable `starting` and the
compaction failure now picks `aborted` as a free choice.

One mutant survived: `survivor-idle-ignores-outbox` (idle() without
`this.outbox.length === 0`). Each item in the outbox is also pending,
because the mail remembers it before it posts it. The exception is the
hidden reminder, and `idleMeansLanded` leaves the reminder out. Without the
check, a held reminder lets the host go quiet, and the renew swap
(serve.ts `renew`) then disposes it. The model does not model `renew`, so no
property sees this. The guard is needed; the model is too small to show it.

A second survivor: `survivor-stop-mark-ignores-checked` (the stop mark
without `|| !checked`). In the code, `!checked` marks a run that ended
between turns, for example while it waited to retry. The model has no such
run (no error or retry turns), so no behavior needs the guard. The replay
does not catch this change either.

The earlier scan said "A failed send to main loses the message and keeps the
mail busy". Commit 642ba00 fixed it. `faithful-fail` passes with a failed
send, and `mutant-failed-send-dropped` shows that the old code lost the item.

Model errors that the checks found and that were fixed (each one judged against the code):

- `idleMeansLanded` first included the reminder. The code does not keep the
  reminder as pending on purpose (deliver.ts `remind`). The property now leaves it out.
- A prompt started a run during a compaction, and then Esc and the end of the
  compaction came in a rare order. Pi allows the first step, but the case is
  outside the promise. The model now drops that prompt (see the bounds).
- The replay showed two more errors: `agent_end`'s reconcile runs before the
  `finally` flush, and `resend` runs `sendWaiting` after each item.
- The first review found this error: `userAbort` and `compactMidRun` set
  `stoppedRun` on each abort. Pi sends no new `agent_end` for an abort in the
  settle check. The model and the replay's fake Pi copied the error, so the
  replay could not catch it. The model now follows Pi, and F3 is the bug
  that the error hid.
- The round-2 review found two more errors. First, `compactStart` always ran
  our `session_before_compact` handler. Pi skips it when an extension that
  loads first cancels. The model now has `compactStartCancelFirst`.
  Second, `compactFail` sent the reminder with `compacting: true`. Pi is idle
  at that point, so the reminder wakes main at once. Both now follow Pi.
- The fix of F2 made one more gap visible. The replay's fake Pi saved no
  aborted reply after an abort, so a trace with no earlier turn had no
  `message` entry for the stop mark. Real Pi saves the stopped reply before
  `agent_end` (the F1 repro shows `note > assistant > COMPACTION`). The fake
  now saves it.

## The fixes of F1 to F4 (2026-11-09)

Each fix went into the model first. All pass checks then passed at the same
bounds as before, and each mutant still broke its invariant. Then the code
changed, the replay got the new state, and each live repro became a
regression test that failed on the old code. Commit `86b79d5`.

| Bug | Model change | Code change | Regression tests (failed on the old code) |
|---|---|---|---|
| F1 | `OWE_STARTED_MAIL`: waking mail that the route `wake` sends goes into the new set `starting`; `runStart` moves the starting messages to `owing` (the `message_end` acknowledge). The old variant `OWE_WAKE_MAIL` is gone: it made `owed()` keep an id that had not landed, which can loop. | `deliver.ts`: the map `starting`. `dispatch` puts waking mail on the route `wake` there. `acknowledge` (the `message_end` of the starting message) moves the id to `owing`. A failed send and `dispose` clear it. `reconcile` does not make mail owed. | `tests/subagents-main-mail-sdk.test.mts` "F1: ..."; `tests/subagents-deliver.test.ts` "mail that starts main's turn is owed once it lands..." and "mail that lands without a turn, or whose wake send failed, is not owed..." |
| F2 | `CUSTOM_KEEPS_MARK`: no landed mail item clears the stop mark (all mail in the model is a custom message). The old variant `QUIET_KEEPS_MARK` kept the mark only for our quiet mail. | `main-watch.ts` `lastSaid`: reads only `message` entries. A custom message from any extension (a relay, a quiet report) no longer cancels the reminder. This is the more robust option that the review asked for. | `tests/subagents-main-mail-sdk.test.mts` "F2: ..."; `tests/subagents-main-watch.test.ts` row "a relay appended as the run settled..." |
| F3 | `STOP_FROM_SETTLED_EVENT` on. | `main-watch.ts` `agent_settled`: `event.aborted` also sets the stop mark. | `tests/subagents-main-mail-sdk.test.mts` "F3: ..."; main-watch row "stopped in the settle check..." |
| F4 | `REMIND_FROM_STOP_MARK` on. `compactFail` now picks `aborted` as a free choice, and the replay passes that pick to the code. | `main-watch.ts`: `stoppedByCompaction(ctx)` is the stop-mark test. `session_compact_failed` reminds when `compactionStopped` or that test holds, whatever `aborted` says. `compacted(stopped)` no longer reads `compactionStopped` itself. | `tests/subagents-main-mail-sdk.test.mts` "F4: ... loaded after ...", "... loaded before ...", "... too small to compact ..."; main-watch rows "cancelled", "an extension that loads first cancelled it", "the session was too small" |

One changed test row: `tests/subagents-main-watch.test.ts` expected no
reminder for a cancelled compaction ("the user cancelled it too"). That row
encoded F4. Pi sends `aborted: true` for an extension's cancel and for Esc
during the summary, and it cannot tell them apart (see F4). The row now
expects the reminder. An Esc during the summary stopped the compaction, not
main's reply, so main still owes the reply.

The live repros now wire `message_end` to `acknowledge`, as
`extensions/subagents.ts` does. Before the fix the wiring changes nothing,
because `acknowledge` only cleared the widget's item.

**Repros before (code at `7936934`) and after (code at `86b79d5`).** Exit 1
means that main never replied to the note.

| Repro | Before | After |
|---|---|---|
| `repro-f1.mts` | exit 1, `seen: ["turn (sees note)", "summary"]`, no reminder | exit 0, `seen: [..., "summary", "turn (sees note) (reminded)"]` |
| `repro-f2.mts` | exit 1, `seen: ["turn", "summary (sees note)"]`, no reminder | exit 0, `seen: [..., "turn (reminded)"]` |
| `repro-f3.mts boundary` | exit 1, `replied: false` | exit 0, `replied: true`, reminded |
| `repro-f4.mts` (cancel) | exit 1, `Compaction cancelled`, `seen: ["turn"]` | exit 0, `seen: ["turn", "turn (sees note) (reminded)"]` |
| `repro-f4-order.mts before` | exit 1, our hook did not run, no reply | exit 0, reminded |
| `repro-f4-order.mts after` | exit 0 (the simulated first fix) | exit 0 |
| `repro-f4-small.mts` | exit 1, `Nothing to compact (session too small)`, no reply | exit 0, reminded |
| controls (`--control`, `repro-f3.mts control`) | exit 0 | exit 0 |

After the fix, `repro-f4-order.mts` no longer needs its simulation: the
real handler reminds in both orders.

Transcripts after the fix:

- F1: `system > user > assistant > user > assistant > note > assistant > COMPACTION > note > assistant`
- F2: `... > user > assistant > note > note > COMPACTION > note > assistant`
- F3: `... > user > assistant > note > COMPACTION > note > assistant`
- F4 (cancel, both orders, too small): `... > user > assistant > note > note > assistant`

The `note` after the compaction (or after the stopped reply) is the hidden
reminder. The last `assistant` is main's reply to the mail.

**Two side effects of the fixes.**

- Mail that starts main's turn is owed from its `message_end` until main
  replies after it. So `idle()` and `HostState.quiet()` stay false until
  that reply, and a renew swap (serve.ts) waits for it. Before the fix, the
  host was quiet as soon as Pi had shown the mail. One host test changed for
  this: `tests/subagents-host.test.ts` "the host is quiet only when ...
  been replied to" now expects `quiet()` false after the acknowledge and true
  after main's reply. The final review found that the test still had the
  old rule.
- Esc while a run that mail started is still in `_prepareRun` (a slow
  `before_agent_start`) leaves the mail owed. Pi still sends `message_end`
  for the starting messages after an abort at `agent_start`
  (agent-loop.js:55-60). Mail on the route `queue` acts the same way after
  Esc. The effect: `HostState.quiet()` stays false until main runs again,
  so a renew swap waits. The review measured this (probe E).
- `lastSaid` now ignores custom messages. So Esc, then a custom message with
  no turn (a relay, a quiet report, a usage-guard notice), then a `/compact`
  within `STOP_WINDOW_MS` gives a reminder. Before the fix, the custom
  message hid this reminder by chance; Esc and then `/compact` with nothing
  between gave it already. The cost is one extra turn of main. The review
  found no case where the change wrongly suppresses a reminder.

**Risk of the F1 fix.** Mail becomes owed only at its `message_end`, so a
run that Pi fails to start (a failed `_prepareRun`) never makes main owe it.
The id then stays in `starting` until the mail is disposed. It is also still
pending for the widget, as before the fix. Owed mail keeps main from
settling until main replies after it. A reminder that starts a run is owed
the same way, so main must reply after it.

## Finding F1: waking mail that starts main's turn gets no reminder after /compact

Status: fixed in `86b79d5` (see "The fixes of F1 to F4"). The text below
describes the code before the fix. Confirmed in a real Pi `AgentSession` (Pi 1.4.0, faux provider, the
real `MainMail` and `watchMain`). TLC checks `faithful` and `f1-wake-mail-no-reminder`, depth 9.

1. Main is idle. A child sends a note (or a question). `dispatch` sends it
   with `triggerTurn: true`, because the route is `wake` (deliver.ts:416).
   It does not add the note to `owing`. Only the route `queue` does that (deliver.ts:417).
2. Pi starts a run with the note as its starting message. The note lands.
3. Before main replies, the user runs `/compact`. Pi aborts the turn and
   waits for idle (as:2230-2232).
4. `agent_settled` sets the stop mark. `session_before_compact` sets
   `compactionStopped` (main-watch.ts:144-147).
5. `session_compact` calls `remind()` (main-watch.ts:82). `owing` is empty, so
   `remind` returns at once (deliver.ts:324).
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

**Fix options.** The fix took a third way (see "The fixes of F1 to F4").
It owes waking mail only once its `message_end` shows that it landed.

- In `dispatch`, add waking mail that starts a turn to `owing` too. Then
  `owed()` must keep an owed id that is not in the context yet (it can wait
  in Pi's deferred actions). The variant `OWE_WAKE_MAIL = true` models both
  parts. All properties hold with it (`assume-fixes*`). With only the first
  part, TLC finds a new path: `owed()` drops the id while Pi still defers it.
  Risk: when Pi drops the starting message (a failed `_prepareRun`,
  as:1428-1434), the id never lands. `owed()` then returns true at each
  settle check, and main never settles. This removes the guarantee that
  owed mail "can't loop" (deliver.ts:283-287). The model leaves out a failed
  `_prepareRun`, so it cannot show this. A fix must drop an owed id that has
  not landed by a later point, for example when the run that it started settles.
- Neither option corrects F3.
- Or let `compacted()` remind for any waking mail after main's last finished
  reply, read from the branch, not from `owing`.

## Finding F2: a quiet append cancels the reminder

Status: fixed in `86b79d5` (`lastSaid` reads only `message` entries). The
text below describes the code before the fix. Confirmed in a real Pi `AgentSession` (Pi 1.4.0, faux provider, the
real `MainMail` and `watchMain`). TLC check `f2-quiet-append-cancels-reminder`, depth 10.

1. Main works on a user turn. A note arrives. The route is `queue`, so the
   note is owed (deliver.ts:417).
2. The user runs `/compact`. Pi aborts the turn. The note lands in the
   run's `finally` flush. `agent_settled` sets `stopMark` to the last entry
   (main-watch.ts:128).
3. Before the compaction starts, a message that does not wake main is
   appended: for example a relay of what the user told a child
   (deliver.ts:165-170), sent with `triggerTurn: false` while Pi is idle.
4. `session_before_compact` compares `lastSaid(ctx)` with `stopMark`
   (main-watch.ts:145). They differ, so `compactionStopped` is false.
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

Status: fixed in `86b79d5` (`event.aborted` sets the stop mark). The text
below describes the code before the fix. Confirmed in a real Pi `AgentSession` (Pi 1.4.0, faux provider, the
real `MainMail` and `watchMain`). TLC check `f3-abort-in-settle-check`,
depth 12. The review of this record found it (R1).

1. A note lands while main works on a user turn. The route is `queue`, so
   the note is owed (deliver.ts:417).
2. Main's last turn ends. The settle check starts. Main-watch's
   `agent_before_settle` handler finds the owed note and returns
   `continue: true` (main-watch.ts:106-117). Another extension's handler
   then awaits I/O.
3. The user runs `/compact`. Pi aborts during the settle check
   (as:1978-1979). The boundary ends with no continue, and Pi sends no new
   `agent_end` (as:1572-1580).
4. `stoppedRun` is false (from the earlier `agent_end`) and `checked` is
   true. So `agent_settled` sets no stop mark (main-watch.ts:128).
5. `session_before_compact` does not set `compactionStopped`
   (main-watch.ts:144-147). No reminder comes, and main never replies.

The two paths take a different order. The TLC path aborts in the settle
check before our handler runs (`compactMidRun` in phase `bs`). Our handler
then runs in the same model step and finds the owed note. The live repro
takes the order above: our handler first, then the abort. Both orders give
the bug.

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

Status: fixed in `86b79d5` (the recommended option below). The text below
describes the code before the fix. Confirmed in a real Pi `AgentSession`. TLC check
`f4-failed-compaction`, depth 9. The review of this record found it (R2).
The round-2 review found that the first fix does not work in one extension
order (N1, `repro-f4-order.mts`).

1. A note lands while main works on a user turn. It is owed.
2. The user runs `/compact`. Pi stops the turn, and the note lands. The
   stop mark is set (main-watch.ts:128).
3. Pi emits `session_before_compact`. If our handler runs, it sets
   `compactionStopped` to true (main-watch.ts:144-147).
4. An extension returns `cancel` from `session_before_compact`, or the user
   presses Esc during the summary. Pi sends `session_compact_failed` with
   `aborted: true` (as:2263-2266, :2331-2350).
5. `compacted(event.reason === "manual" && !event.aborted)` gets false
   (now main-watch.ts:152). No reminder comes, and main never replies.

A failure before the hook takes the same path with no other extension
(round-3 review, M1). `compact()` aborts the run (as:2231), then throws
"Nothing to compact (session too small)", "Already compacted" or "No model
selected" before `session_before_compact` (as:2237-2249). Our handler does
not run, so `compactionStopped` stays false, and `session_compact_failed`
(`aborted` false) sends no reminder. With the default `keepRecentTokens`
(20000), a short session gives this error. `repro-f4-small.mts` shows it.
The model reaches the same outcome through `compactStartCancelFirst` and
`compactFail`, not through this path. A summary that fails after our
handler ran (`aborted` false) does send the reminder. The TLC path
of `f4-failed-compaction` runs our handler in step 3 (`compactStart`), then
the compaction fails with `aborted` true.

**Harm.** Medium. A `/compact` of a short session needs no other extension
(`repro-f4-small.mts`). A cancel by an extension: the user did not stop main.
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

**The first fix depends on the extension order (N1).** The variant
`REMIND_ON_FAILED_COMPACT = true` reminds on `session_compact_failed` when
`compactionStopped` is true. Only our `session_before_compact` handler sets
that flag. Pi stops the emit at the first handler that cancels
(runner.js:820-824). When the cancelling extension loads before subagents,
our handler does not run, and the flag keeps the `false` that `compacted()`
left (main-watch.ts:84). The model action `compactStartCancelFirst` takes
this step. The check `f4-old-fix-handler-order` (all other fixes assumed)
gives this path at depth 9:
`childMail(a) > runStart > compactMidRun > settledHandler > settleEnd > compactStartCancelFirst > compactFail(aborted) > retrySoonFire`.

`node formal/subagents-mail/repro-f4-order.mts <order>` simulates the first
fix in a real `AgentSession` (main-watch sees `aborted: false`). It loads a
cancelling extension before or after ours.

`before` (exit 1):

```json
{
  "mode": "before",
  "compactError": "Compaction cancelled",
  "mainWatchBeforeCompactRan": false,
  "seen": ["turn"],
  "replied": false,
  "transcript": "system > user > assistant > user > assistant > user > assistant > note"
}
```

`after` (exit 0):

```json
{
  "mode": "after",
  "compactError": "Compaction cancelled",
  "mainWatchBeforeCompactRan": true,
  "seen": ["turn", "turn (sees note) (reminded)"],
  "replied": true,
  "transcript": "system > user > assistant > user > assistant > user > assistant > note > note > assistant"
}
```

**Fix options.**

- Recommended: in `session_compact_failed`, compute "a compaction stopped
  this run" from the stop mark itself. Use the test of main-watch.ts:145
  again (`stopMark`, `settledAt`, `lastSaid(ctx)`). Remind when it holds,
  whatever `aborted` says. This does not depend on the handler order. The
  variant `REMIND_FROM_STOP_MARK = true` models it, and `assume-fixes*`
  assume it. In the model, no mail of this extension lands between the start
  of the compaction and its failure, because the route holds while Pi
  compacts. So the stop mark is still valid in that event. An append by
  another extension in that window cancels the reminder, as in F2. A simulation of `assume-fixes` with the
  failure step kept found a path where an earlier extension cancels, the
  reminder lands and main replies. So the pass covers this case.
- Do not use `REMIND_ON_FAILED_COMPACT` alone. It fails when the cancelling
  extension loads first (see above).
- A fix that reminds only for a cancel by an extension is not practical.
  The event does not tell a cancel from Esc. `fromExtension` is true only
  when an extension supplies the compaction (as:2268-2270). It is false for
  a cancel and also for Esc.

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

## Round 3 of the review

A third fresh reviewer read the round-2 changes (`review3-mail`). It found
no new critical or high issue, so the review loop stops here. It confirmed
that N1 to N5 are fixed, that `REMIND_FROM_STOP_MARK` reminds in a real
`AgentSession` on each failure path that it tried, and that `assume-fixes`
passes for the right reason. Its points:

- M1, medium: F4 also occurs with no other extension, when the session is
  too small to compact (see F4). `repro-f4-small.mts` (exit 1; control
  `--control`, exit 0). `REMIND_FROM_STOP_MARK` covers this path in the
  reviewer's run.
- L1, low, no repro: Pi emits `compaction_end` (as:2336) before
  `session_compact_failed` (as:2344), and the TUI can then send a prompt that
  waited during the compaction. The reminder on the idle route can race with
  it. The input grace (main-watch.ts:158) probably covers this.

## Round 2 of the review

A second fresh reviewer read the corrected record
(`review-mail-r2`). It confirmed the F3 changes, the replay (2 of 2) and the
claim for change 8. It found five new items. This version fixes all five:

- **N1, high.** The first F4 fix (`REMIND_ON_FAILED_COMPACT`) fails when the
  cancelling extension loads before subagents (runner.js:820-824). Changed:
  the new action `compactStartCancelFirst` and the flag `compactCancelled`;
  the sound fix switch `REMIND_FROM_STOP_MARK`, which `assume-fixes*` and the
  `f1` to `f3` checks now use; the new check `f4-old-fix-handler-order`
  (violates `wokenForMail`); the reviewer's `repro-f4-order.mts`; the
  witness `witnessNoCancelFirst`, so the replay runs the new action; and
  the F4 text above.
- **N2, medium.** `compactFail` sent with `compacting: true`, but Pi clears
  the compaction state (as:2335) before it emits `session_compact_failed`
  (as:2344). Changed: `compactFail` now sends on the idle route, so a
  reminder wakes main at once. The replay's fake Pi clears `compacting`
  before the emit, and it now passes the `throws` pick to that send. The
  old fake failed on the new traces (trace 94, step 17, `compactFail`).
- **N3, medium-low.** The F4 text said that `fromExtension` tells a cancel
  from Esc. It does not (as:2268-2270). Changed: the F4 fix options.
- **N4, low.** Two citations were wrong. Changed: `handOverMail` is
  host-state.ts:317-323 in the replay test, and `postKeptMail` is
  host-state.ts:326-332 in the `fallbackOpen` comment of `mail.qnt`.
- **N5, low.** The F3 text did not say that the TLC path and the live repro
  take a different order. Changed: the F3 text.

## Review of the fixes

A fresh Opus 5.5 reviewer (`review-mail-fixes`) read the three commits of
the task against Pi 1.4.0, with probes in a real `AgentSession`. It found no
critical or high issue. Its points:

- Medium, from before the fixes, no natural trigger: when `_prepareRun`
  throws, Pi drops the starting message. The note never lands, its id stays
  in `starting` and in the pending items, and `idle()` stays false for good.
  Main settles (no loop). The review showed it with a patched
  `_prepareRun`. Not fixed; an open item. A fix could put a starting id
  with no `message_end` back in the outbox at the `agent_settled` of the run
  that it started.
- Low: Esc during `_prepareRun` of a run that mail started leaves it owed;
  low: Esc, a custom message, then `/compact` gives a reminder. Both are in
  "Two side effects of the fixes".
- Low, no repro: the new loop in `team.ts` `run()` sent the late mail with
  no wrap-up check and no `swapBefore`, which `work()` does before each
  prompt. Fixed: `run()` now does both checks (commit `88972f9`). The test
  "a run whose budget ends as late mail lands ..." in
  `tests/subagents-settle-steer.test.ts` reaches this window: without the
  wrap-up check, the run at depth 3 is `stopped`; with it, the run ends
  `idle` at its budget and keeps the mail.
- Low: wrong citations (main-watch.ts, team.ts, a stale comment in
  `mail.qnt`). Fixed.

A second fresh reviewer (`review-mail-final`) read the final record and
commit `88972f9`. It found one high issue with a repro: the host test above
failed on each run, and the record did not say so. Fixed (the test and the
first side effect above). It also found three wrong citations in the
lifecycle record (fixed) and gave the probe that became the budget test. It
judged four event orders of `88972f9` against `work()` and found them
correct.

It confirmed: deferred mail in `agent_settled`, a reminder that starts a run
(owed, no loop), the `message_end` paths, the changed test row (a correct
change of the spec), the R1 fix (the test fails on the old code), the model
actions, three TLC checks, and all 12 repros (the "After" column).

## Five weakest points of the model

1. Until the review, `stoppedRun` was forced true on each abort (now fixed; F3).
2. Until the review, it had no `session_compact_failed` (now added; F4).
   Until round 2, our `session_before_compact` handler ran on each
   compaction, and the failed compaction kept the route `hold` (N1, N2).
3. Each turn end counts as a finished reply: no error or retry turns, and no
   `isReply` in `answered()`.
4. A macrotask gap is allowed between the abort and `compactStart`, and
   between `compactIdle` and `compactStart`. In the code, `compact()`
   continues in microtasks after `abort()` resolves (as:2231-2232). This only
   adds paths, so it is safe for a pass. It can give a path that the code
   cannot take, so each violation was judged against a live repro.
5. The replay's fake Pi copies the model's Pi rules. Only the repros and
   `tests/subagents-main-mail-sdk.test.mts` check Pi itself. The replay does not compare the main-watch flags (`running`,
   `settling`, `checked`, `stoppedRun`, `stopMark`, `compactionStopped`).
   They are private to `watchMain`, and the replay sees them only through
   the route and through the reminder that the mail posts.

## How the model stays true to the code

- `tests/subagents-mail-conformance.test.mts` replays 160 model traces (150
  random, 10 witnesses) against the real `MainMail`, the real `watchMain` and
  the real `PortBinding`. After each step it compares the outbox, the pending
  items, `owing`, `starting`, the batch, both timers, `closed`, the route, `idle()`, the
  index, and where Pi holds each message.
- The test copies a few lines that it cannot run: the event handlers of
  `extensions/subagents.ts:337-360`, `Host.rebind`, the drain and
  `handOverMail` of `Host.close`, and the resend of `postKeptMail`. Each copy
  names its source line. The replay does not check these copies.
- Its Pi is a fake that follows the model's Pi rules. `repro-f1.mts`, `repro-f2.mts` and
  `repro-f3.mts` (with `repro-f4.mts`) check the rules of F1 to F4 in a real
  `AgentSession`, and the F1 to F4 tests of
  `tests/subagents-main-mail-sdk.test.mts` keep them as regression tests.
  The fake saves an aborted reply before `agent_end`, as Pi does. `repro-f4-order.mts` checks that a cancel stops the emit
  of `session_before_compact` (N1). The replay does not compare the main-watch flags (see the
  weakest points). The other rules are checked by
  reading Pi's source only.
- The second test replays the witness `witnessNoReminderForStartedMail`: a
  note started the run, a `/compact` stopped it, and the code posts the
  reminder (F1, fixed). Before the fix, this test replayed the F1 path.
- `python3 formal/subagents-mail/code-mutants.py "$PWD"` makes 14 one-guard
  changes to the real code, one at a time, and runs the replay. The replay
  caught 13 of 14, and `git diff -- lib extensions` was clean after each restore:
  1. `acknowledge` without the move from `starting` to `owing` (F1);
  2. a failed send that keeps its id in `starting` (F1);
  3. `lastSaid` that counts `custom_message` entries again (F2);
  4. the stop mark without `event.aborted` (F3);
  5. `session_compact_failed` with `compactionStopped && !event.aborted` (F4, the old code);
  6. `session_compact_failed` with `compactionStopped` alone (F4, the rejected first fix);
  7. no `this.outbox.unshift` after a failed send (deliver.ts:275);
  8. `wakes` alone choosing `triggerTurn` (deliver.ts:416);
  9. no `owing` for mail on the route `queue` (deliver.ts:417);
  10. `running` instead of `running && !settling` (main-watch.ts:159);
  11. `landed` without the `pendingItems.delete` (deliver.ts:361);
  12. `drain` returning nothing (deliver.ts:237);
  13. `compacted` without `remind()` (main-watch.ts:82).
  It missed one: the stop mark without `|| !checked` (main-watch.ts:128).
  No model behavior needs that guard (see `survivor-stop-mark-ignores-checked`).

## Test coverage table

Input for a later task that deletes tests after mutation testing. The fix of
F1 to F4 deleted no test. It changed one row of
`tests/subagents-main-watch.test.ts` (see "The fixes of F1 to F4") and added
the tests in the last rows.

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
| `tests/subagents-main-mail-sdk.test.mts`: the 6 tests "F1: ..." to "F4: ..." | `mutant-f1` to `mutant-f4` and the code mutants 1 to 6, against a fake Pi | keeps value: the real Pi rules of F1 to F4 (who emits what, the handler order, the early failure of a small session) |
| `tests/subagents-deliver.test.ts`: "mail that starts main's turn is owed once it lands...", "mail that lands without a turn, or whose wake send failed, is not owed..." | `mutant-f1-started-mail-not-owed`, code mutants 1 and 2 | covered by the model, but they also check that a turn Pi never starts can't keep main from settling, which the model leaves out |
| `tests/subagents-main-watch.test.ts`: the rows of F2, F3 and F4 in "a reminder follows only a /compact..." | code mutants 3 to 6 | partly covered: the replay sees the flags only through the reminder; keeps value for `STOP_WINDOW_MS` with a skipped hook |

## Open items

- Three fresh reviewers read the record before the fixes (rounds 1 to 3).
  The fixes have their own review (see "Review of the fixes" below).
- A reminder after a cancel by an earlier extension is in the traces (the
  witness `witnessNoCancelFirst`, and the F4 test "loaded before"), but no
  check in `fv.json` asks TLC to reach it.
- The full bounds in one pass check do not finish in 25 minutes on 2 workers.
- A failed `_prepareRun` leaves a note in `starting` and pending for good
  (see "Review of the fixes"). The model leaves out a failed `_prepareRun`.

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs check formal/subagents-mail --workers 1
node skills/formal-verification/scripts/fv.mjs check formal/subagents-mail --only before-fixes --trace
python3 formal/subagents-mail/code-mutants.py "$PWD"
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
node formal/subagents-mail/repro-f4-order.mts before
node formal/subagents-mail/repro-f4-order.mts after
node formal/subagents-mail/repro-f4-small.mts       # and --control
node skills/formal-verification/scripts/fv.mjs drift formal/subagents-mail
```
