# Formal check: shell job completion delivery

This folder holds a model of the shell-jobs delivery code in Quint, the
checks that TLC runs on it, the traces that a test replays against the code,
three live repros and a probe of the Pi rules. The `formal-verification` skill
made it. The skill folder is `skills/formal-verification`.

## The promise

The `shell_job` tool says: "One completion message per job is delivered
automatically, except for killed jobs." (`extensions/shell-jobs.ts`, the
`shell_job` description).

The harm when the promise breaks: the model gets a job result two times and
starts an extra turn for it, or gets the result of a job that the user
stopped, or the widget shows a wrong count of attempts.

## Properties

| Invariant | In plain words |
|---|---|
| `oneCompletion` | The session never holds two completion messages for one job. |
| `oneCopy` | Pi never holds two copies of a job's message: in the session, in the run's queue and in the deferred actions together. It breaks before `oneCompletion` does. |
| `stoppedMeansSilent` | A kill that answered "stopped" never gets a completion message. |
| `boundedSends` | The code sends a completion at most 3 times (`MAX_COMPLETION_ATTEMPTS`). |
| `deliveredMeansSeen` | A job is marked delivered only when its message is in the session. |
| `attemptsCountSends` | Each counted attempt is one send, or one send that waits in the outbox. |
| `noStuckHold` | A `pending` hold always has its copy in Pi: in the deferred actions, or as the message that starts a run. So no `pending` hold can stay with no end. |
| `noHoldPastSettle` | No hold lives past one `agent_settled` of a run with no abort while Pi has no copy of it. That settle releases it, and reconcile sends it again. In the faithful model `noStuckHold` breaks first for a `pending` hold, so this one guards the release (`mutant-release-never`). |
| `outboxMoves` | A completion that waits in the outbox always has a way out: a read in flight, an armed retry timer, an `agent_start` handler still to run, or a run or `agent_settled` that will flush the outbox. |

## The fix (finding F)

Before the fix, `reconcileDeliveries` sent a completion again when the job
was not in the session, not in the outbox, and `ctx.isIdle()` was true. Pi can
hold a sent message while `isIdle()` is true, so Pi then delivered both copies.
Finding F below gives the 6 paths.

With the fix, shell-jobs keeps each sent completion in `runtime.held` until
it lands, and reconcile skips a held job. `sendCompletion` reads `ctx.signal`
just before the send. The signal exists only while an agent loop runs. The
value tells where Pi puts the message:

| Held as | When | Released by |
|---|---|---|
| `steered` | An agent loop runs (`ctx.signal` is defined). Pi steers the message into the run's queue. | A run that settles with no abort: it drained its queue, so the message landed or was dropped. |
| `pending` | No agent loop runs and `ctx.isIdle()` is true: Pi is idle, or `agent_settled` handlers run. Pi starts a run for the message, at once or after the handlers. | `before_agent_start` names the message as the start of a run: then it is `steered`. |
| (not sent) | No agent loop runs and `ctx.isIdle()` is false: a gap of a run, or a compaction. | This is the gap wait, below. |

**The gap wait.** A run can be busy with no agent loop: while
`before_agent_start` handlers await (Pull Link auto-pull reads the links of
the user's message), and while `agent_before_settle` handlers await (a
subagent hand-over). Pi then puts a sent message in the run's queue
(`sendCustomMessage` steers while `isStreaming`, and `isStreaming` is true
from the start of `_startRun`). An Esc in the gap clears the queue, and the
message is gone with no proof. So `sendCompletion` does not send while
`ctx.signal` is undefined and `ctx.isIdle()` is false. It checks before the
tail read, so that a retry does not read a large log again, and after the
read, because a gap can start during the read. The completion stays in the
outbox, and reconcile skips it. Three things send it later:

- The `agent_start` handler flushes the outbox. The loop now exists, so the
  send is `steered` and goes into this loop.
- A retry timer (`GAP_RETRY_MS`, 500 ms) flushes again. It sends once the
  gap ends, also when no event comes (a run that fails in `_prepareRun`, or
  a compaction while Pi is idle).
- The `agent_settled` reconcile flushes the outbox, and Pi defers the send.

The wait sends nothing in the one state where shell-jobs cannot tell the
run's queue from Pi's deferred actions. A compaction that starts during
`agent_settled` handlers makes `isIdle()` false with no run, and a send then
is deferred. The wait waits there too, so that case does not matter.

An aborted run releases nothing, in every mode. Some aborts keep the queue
for the next run: the RPC `abort`, `ctx.abort()` with no `abortHandler`, and
in the TUI `/compact`, `/new`, `/resume`, `/fork`, `ctx.compact()` and
`ctx.newSession()`. Esc in the TUI clears the queue, but a send after the
clear and before the run stops stays in the queue (F5). Shell-jobs cannot see
which case it is. A completion that lands (`message_end`, or the history
lookup of a later reconcile) leaves `held`.

The fix makes trades, so that it is safe for every Pi rule that the model has:

- After an abort, a completion is not sent again at once. If the abort kept
  it, it lands in the next run. If the abort dropped it (Esc), shell-jobs
  sends it again when the next run settles with no abort; if no such run
  comes, it does not arrive. Before the fix, it was sent again at once, and
  that started a new turn right after the Esc.
- `/new`, `/resume`, `/fork`, `ctx.newSession()`, `ctx.fork()` and
  `ctx.switchSession()` abort the run, then close the old session
  (`teardownCurrent` calls `abort()`, emits `session_shutdown` and calls
  `session.dispose()`, `agent-session-runtime.js`). The kept completion goes
  with the old session, and the new session does not take over the jobs.
  Before the fix, it landed two times in the old session.
- The first version of this fix released `steered` sends after an aborted run
  in the TUI. It used the rule that every TUI abort clears the queue. A review
  found that `/compact`, `/new`, `/resume` and `/fork` do not, and a live
  repro (`repro-f2.mts --one-job --compact`) gave 2 messages with that
  version. The check `mutant-release-ignores-abort` copies that version.
- `isIdle()` does not tell a deferred send from a send that starts a run. An
  earlier version used it. The check `pi-idle-counts-deferred` then found a
  duplicate: if Pi makes `isIdle()` count deferred actions (one half of the
  Pi fix below), that version sent a deferred completion again. `ctx.signal`
  does not have this problem.
- A completion that ends in a gap waits until the next agent loop starts or
  the run settles. A gap lasts as long as the handlers: up to 15 s for a
  link read, and longer for a compaction or a retry delay. During the wait,
  the retry checks the session every 500 ms, with no log read.
- Old Pi cores with no `ctx.isIdle()` get no gap wait.
- A completion that ends in the gap after the last loop (`agent_before_settle`)
  is sent after the run settles. Pi defers it, and it starts a new run.
  Before the gap wait, the run went on with it in one more loop.
- Esc while `before_agent_start` handlers await: Pi aborts the loop at
  `agent_start` (`_handleAgentEvent` calls `agent.abort()`), so the
  `agent_start` flush sees a defined, aborted `ctx.signal`. The completion
  goes into the queue of the aborted run and lands in the next user run,
  as in `f5-send-after-abort`. It gives no duplicate. To count an aborted
  signal as a gap would send it after the settle, but that starts a new
  turn right after an Esc.
- The version before the gap wait held such a send as `pending`. With Esc
  in the gap, it never arrived, and the widget showed "pending" with no end.
  Live (`repro-gap.mts`, Esc during a 2 s link read): 0 messages with that
  version, 1 before the fix and 1 with the gap wait. The check
  `old-gap-pending` copies that version and breaks `noStuckHold` in 4 steps.

## Known limits of the fix

Reviews found these. The third one can give a duplicate. The first two can
stop a completion.

- `_emitAgentSettled` runs the deferred actions with `for (...) await
  action()` and no catch. If one throws (for example a deferred prompt with
  no model or API key), Pi drops the actions after it, also those of outer
  loops. A `pending` completion among them stays held, and the widget shows
  it as "pending" with no end. The check `pi-deferred-throws` shows this
  path (it breaks `noStuckHold`), and `pi-deferred-throws-no-duplicate`
  shows that the throw gives no duplicate. Pi drops the other extensions'
  messages and the user's deferred prompt there too. Shell-jobs gets no
  event for the throw, so it cannot release the hold safely: a deferred
  send that waits behind other deferred actions looks the same.
- A `/reload` passes its `isStreaming` check, and then a completion starts a
  run. Shell-jobs parks before that run's `before_agent_start`, so no
  shell-jobs handler names the message, and the hold stays `pending`. If
  that run then fails in `_prepareRun`, the message is lost and the hold
  stays with no end. The check `pi-run-start-fails` shows this path in 7
  steps. It needs a reload and a failed run start in the same few
  milliseconds. For a run that a completion starts, only an error in the
  tool loadout or the system prompt build (`_preparePromptAndToolLoadout`)
  makes the start fail, because `emitBeforeAgentStart` catches handler
  errors. Pi then reports a `send_message` error with no message id, so
  shell-jobs cannot know which send failed. The fix belongs in Pi (see the
  fact sheet). When the run does not fail, its message lands, and the next
  reconcile finds it in the history.
- A duplicate is possible when a run leaves its loop with a message still in
  the queue and no abort: an exception from `agent.continue()` ("No messages
  to continue from"), from `_handlePostAgentRun` or from
  `_runBeforeSettleBoundary`, or `_runBeforeSettleBoundary` that returns false
  because the context cannot continue. Pi then emits `agent_settled` with
  `aborted: false`, and the fix releases a `steered` message that is still
  queued. The known causes need a context with only system messages. No live
  repro exists. The Pi fix below (`isIdle` false while the agent's queue holds
  messages) closes it.

An earlier version had a third limit: a run that settles with no abort can
hold a message that came in the microtasks after its last queue check. With
the gap wait, no message is sent then: the send waits until the settle.

`pi-probe.mts` checks the Pi rules that the fix uses, on any Pi version.

## What the model covers

Each action is one synchronous segment of the code: the code between two
`await`s. TLC tries every order of these segments. The model covers this code:

- `lib/shell-jobs-delivery.ts`: `attachDelivery`, `flush`, `sendCompletion`,
  `noteRunStart`, `acknowledgeCompletion`, `settleDeliveries`,
  `reconcileDeliveries`.
- `extensions/shell-jobs.ts`: `finalize`, and the `session_start`,
  `message_end`, `before_agent_start`, `agent_start`, `agent_settled` and
  `session_shutdown` (reload) handlers.
- `lib/shell-jobs-manage.ts`: `stopJob`.
- `lib/shell-jobs-process.ts`: `parkForReload`.

It also covers the parts of Pi that the delivery depends on. These come from
Pi's source (1.4.0; 1.5.0 is the same here):

- `sendCustomMessage` with `triggerTurn` (`dist/core/agent-session.js`): it
  steers into an active run, or starts a run with the message as the run's
  first message (`_startRun`). While `agent_settled` handlers run, it waits
  in `_deferredSettledActions`. A user prompt waits there too.
- `_emitAgentSettled`: after the handlers, Pi runs the waiting actions one at
  a time (`for (const action of deferred) await action()`). Each one starts a
  run, and that run's own `agent_settled` runs inside the `await`. The event
  has `aborted`, which is `_agentRunAbortRequested`.
- `_prepareRun` emits `before_agent_start` with the message that starts the
  run (`messageType: "custom"`), before the run takes any message.
- The extension runner awaits each `agent_settled` handler in turn
  (`dist/core/extensions/runner.js`). The handler of an extension that loads
  before shell-jobs can await, so other segments can run before the
  shell-jobs handler.
- `isIdle` is `!_isAgentRunActive && !isCompacting`. It ignores the actions
  that wait, and the messages that wait in the agent's queues.
- `ctx.signal` is `agent.signal`: the abort signal of the agent loop
  (`pi-agent-core/dist/agent.js`). It is undefined when no loop runs. The
  model has the loop as the state `inLoop`: `loopStart` (`agent.prompt`
  after `_prepareRun`, or `agent.continue`) and `loopEnd` (the loop found no
  message in the queue, or the run was aborted). Only a loop takes messages
  from the queue, and a run ends only after its last loop.
- The message that starts a run (the `_startRun` trigger of an idle or
  deferred send) is the state `firstMsg`, not part of `queue`. It is not in
  the agent's queue, so a clear does not drop it, and it lands first when
  the loop starts, also after an abort (`agent-loop.js` `runAgentLoop`).
- The shell-jobs `agent_start` handler is the step `agentStartFlush` after
  `loopStart`; other extensions' handlers can run first. The retry timer is
  the state `armed` and the step `retryFire`: a flush in a gap arms it, and
  a parked binding's timer does nothing. A gap (`gapNow`) is no loop and
  `piIdle` false, the same test as `sendPlace` with `ctx.isIdle()`. In
  `faithful` that is a gap of a run; in the `pi-idle-counts-*` checks it
  also covers deferred or queued messages, as the code would on such a Pi.
- A run can fail in `_prepareRun` after `before_agent_start` (`startFails`):
  Pi clears `_isAgentRunActive` and emits no `agent_settled`. Only the retry
  timer then sends a completion that waited in that run's gap
  (`mutant-gap-no-timer`). In `faithful` only a user prompt's run fails.
  `RUN_START_FAILS` lets a run that a completion starts fail too, and then
  its first message is lost. With `DEFERRED_THROWS`, a run that a deferred
  action starts can fail, and Pi drops the deferred actions after it.
  `_checkCompaction`, before `before_agent_start`, catches its errors.
  A run that started a loop always ends through `_startRun`'s `finally`,
  which emits `agent_settled`, so `startFails` needs `not(runHadLoop)`.
- `DEFERRED_THROWS` (off in `faithful`): a deferred action throws, and Pi
  drops it and all the deferred actions after it.
- An abort is two steps: `AgentSession.abort()` sets
  `_agentRunAbortRequested`, and later the run ends. A send between the two
  goes into the queue. The run then ends with the message still in the queue.
- Some aborts clear the queues first: in the TUI, Esc, tree navigation and an
  extension's `ctx.abort()`, which goes through the TUI's `abortHandler`.
  They call `clearAllQueues` (`restoreQueuedMessagesToEditor`,
  `dist/modes/interactive/interactive-mode.js`). The clear comes before the
  abort, so a send after the clear stays in the queue.
- The other aborts keep the messages: the RPC `abort` command, `ctx.abort()`
  in a mode with no `abortHandler` (RPC, print, SDK), and in the TUI
  `/compact`, `/new`, `/resume`, `/fork`, `ctx.compact()`, `ctx.newSession()`,
  `ctx.fork()` and `ctx.switchSession()`. They call `AgentSession.abort()`
  alone. It and `Agent.abort()` do not touch the queues, and the next run
  takes the messages. The model lets each abort clear the queue or keep it.
- `/reload` refuses only while a run is active. It then awaits before
  shell-jobs parks. `runtime.held` survives the reload.
- Pi emits each event to the handlers of the runner that started the
  emission. After a reload parks shell-jobs, its old handlers do nothing.

## Bounds and what they leave out

The default checks use 2 jobs, 1 reload, 2 user runs or aborts, and 3
attempts. `faithful-wide` uses 3 jobs (20,826,360 states). `faithful-runs3`
uses 3 user runs or aborts. `faithful-one-job-runs6` uses 1 job and 6 user
runs or aborts. In `faithful`, a resend is always the first message of a
run, which Pi does not drop, so no job reaches the attempt cap.
`pi-deferred-throws-one-job-runs6` lets runs fail to start, so a job can
reach the cap there. Inside these bounds the
check is exhaustive. It does not cover:

- More jobs, reloads or runs than the bounds.
- Quit, restart hand-over (`lib/shell-jobs-adopt.ts`), and `beginClosing`.
  A restart starts a new Pi process with no held messages, and a new runtime
  with an empty `held` map.
- `trimRetained`, which can drop a job record (and its `held` entry).
- Compaction, which makes `isIdle()` false. With no signal, the gap wait
  then sends nothing, and the retry timer sends after the compaction.
- A history that cannot be read (`lookupCompletion` returns "unknown").
- A failed `pi.sendMessage`, and a send through the old API after Pi
  invalidated it. The code then removes the `held` entry.
- A failed start of a run that a completion starts, in `faithful`. The
  checks `pi-run-start-fails`, `pi-deferred-throws-no-duplicate` and
  `pi-deferred-throws-one-job-runs6` cover it, and so does a unit test: the
  completion is sent again after the next run settles.
- An exception from `agent.continue()` or the settle boundary with a message
  in the queue ("Known limits of the fix"). The model's `runEnds` needs an
  empty queue when no abort was requested. An exception in the deferred
  loop is in the model as `DEFERRED_THROWS`.
- A second kill of the same job.
- A `clear_queue` while no run is active (RPC), or a TUI Esc while Pi is
  settling. These drop a message. A kept completion then lands only after a
  later run settles and reconcile sends it again. This affects only liveness.
- Liveness, in part. There is no temporal property. `noStuckHold`,
  `noHoldPastSettle` and `outboxMoves` are the bounded form: every hold has
  its copy in Pi or the next `agent_settled` of a run with no abort releases
  it, and every waiting completion has a read, a timer or a flush to come.
  They assume that Pi in the end runs what it holds, that a later run
  settles with no abort, and that a timer fires.

## Results

Run `node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery`.
The `old-` checks set `HELD_GUARD` and `GAP_WAIT` to false: the code before
the fix. `old-gap-pending` sets only `GAP_WAIT` to false: the fix before the
gap wait.

| Check | Expect | Result |
|---|---|---|
| `faithful` | pass | pass, 600,264 states |
| `faithful-wide` | pass | pass, 20,826,360 states |
| `faithful-runs3` | pass | pass, 1,476,232 states |
| `faithful-one-job-runs6` | pass | pass, 215,336 states |
| `old-faithful` | violates `oneCompletion` | violation, 12 steps |
| `old-gap-pending` | violates `noStuckHold` | violation, 4 steps |
| `f2-pi-extras-alone` | pass | pass, 87,708 states |
| `old-f2-pi-extras-alone` | violates `oneCompletion` | violation (F4), 12 steps |
| `f2-two-jobs` | pass | pass, 22,932 states |
| `old-f2-two-jobs` | violates `oneCompletion` | violation (F2a), 27 steps |
| `f1-one-job-reload` | pass | pass, 3,252 states |
| `old-f1-one-job-reload` | violates `oneCompletion` | violation (F1), 12 steps |
| `f2-one-job-prompt` | pass | pass, 3,636 states |
| `old-f2-one-job-prompt` | violates `oneCompletion` | violation (F2b), 21 steps |
| `f3-earlier-handler` | pass | pass, 846 states |
| `old-f3-earlier-handler` | violates `oneCompletion` | violation (F3), 17 steps |
| `f4-abort-keeps-queue` | pass | pass, 830 states |
| `old-f4-abort-keeps-queue` | violates `oneCompletion` | violation (F4), 12 steps |
| `f5-send-after-abort` | pass | pass, 830 states |
| `old-f5-send-after-abort` | violates `oneCompletion` | violation (F5), 12 steps |
| `pi-run-start-fails` | violates `noStuckHold` | violation, 7 steps: a stuck path that Pi must fix |
| `pi-deferred-throws` | violates `noStuckHold` | violation, 6 steps: a stuck path that Pi must fix |
| `pi-deferred-throws-no-duplicate` | pass | pass, 1,019,044 states |
| `pi-deferred-throws-one-job-runs6` | pass | pass, 319,224 states |
| `pi-idle-counts-deferred` | pass | pass, 530,944 states |
| `old-pi-idle-counts-deferred` | violates `oneCompletion` | violation (F4), 12 steps |
| `pi-idle-counts-pending` | pass | pass, 525,744 states |
| `pi-idle-counts-pending-wide` | pass | pass, 16,736,904 states |
| `pi-idle-counts-pending-runs3` | pass | pass, 1,235,892 states |
| `old-pi-idle-counts-pending` | pass | pass, 420,396 states: the Pi fix alone also closes finding F |
| `survivor-send-ignores-binding` | pass | pass, 766,640 states |
| `mutant-reconcile-ignores-outbox` | violates `attemptsCountSends` | violation, 4 steps |
| `mutant-claim-unchecked` | violates `stoppedMeansSilent` | violation, 5 steps |
| `mutant-finalize-ignores-claim` | violates `attemptsCountSends` | violation, 4 steps |
| `survivor-reconcile-ignores-idle` | pass | pass, 555,704 states |
| `mutant-reconcile-ignores-history` | violates `oneCompletion` | violation, 17 steps |
| `mutant-attempt-cap-off-by-one` | violates `boundedSends` | violation, 23 steps: on `pi-deferred-throws-one-job-runs6` |
| `mutant-ack-on-send` | violates `deliveredMeansSeen` | violation, 3 steps |
| `mutant-release-pending` | violates `oneCopy` | violation, 6 steps |
| `mutant-release-never` | violates `noHoldPastSettle` | violation, 12 steps |
| `mutant-settle-no-flush` | violates `outboxMoves` | violation, 5 steps |
| `mutant-gap-no-timer` | violates `outboxMoves` | violation, 3 steps |
| `mutant-release-ignores-abort` | violates `oneCompletion` | violation, 14 steps |
| `mutant-pending-as-steered` | violates `oneCopy` | violation, 6 steps |
| `mutant-session-start-releases` | violates `oneCompletion` | violation, 16 steps |

Each `f` check turns off the other sources of the duplicate, so that its
`old-` twin shows one path. The `old-f1` to `old-f4` checks also stop reads
from ending while an aborted run winds down (`SEND_AFTER_ABORT`). Without
that, TLC finds the shorter path F5 first.

A few checks ended with "error" in the Apalache compile step while another
session on the machine ran Quint at the same time (the `quint verify` runs
share one local Apalache server). Each one gave the expected result when it
ran again.

A mutant is a change to the model that copies a change to the code, for
example a removed check. Each mutant must break a property. This shows that
the check can fail. Each property has at least one mutant. A survivor is a
mutant that breaks no property:

- `survivor-send-ignores-binding`: the binding check in `sendCompletion`.
  With the fix, no reconcile sends while the old binding's send waits, so
  that send cannot make a second message. The check stops a send through the
  old API, which throws after Pi invalidates the old runner. The conformance
  replay catches this change.
- `survivor-reconcile-ignores-idle`: the `ctx.isIdle()` check in
  `reconcileDeliveries`. Before the fix, its removal broke `oneCompletion`.
  With the fix, a completion that Pi holds is held, so reconcile skips it
  also while Pi is busy. The check stays: it keeps reconcile out of a
  compaction, which the model does not cover.
- The claim is checked two times: in `finalize` and in `sendCompletion`.
  Without the `finalize` check, the send still stops, but the attempt count
  is wrong (`mutant-finalize-ignores-claim`). Without both, a stopped job
  gets a completion (`mutant-claim-unchecked`).

## Finding F: one completion could be delivered two times

**Status.** Fixed in pi-extras (the fix above). Each path has an `old-` TLC
check, a regression test in `tests/shell-jobs-delivery-conformance.test.mts`,
and, where noted, a live repro. Live results are for Pi 1.4.0 and 1.5.0, with
the code before the fix (cf08a6a) and with the fix.

**Cause.** Before the fix, `reconcileDeliveries` took `ctx.isIdle()` to mean
"Pi holds no completion that it has not put in the session". That is not
true. `isIdle()` can be true while Pi holds a completion that shell-jobs sent:
while `agent_settled` handlers run, while Pi runs the actions that waited, and
after an abort that kept the queue. `sendCompletion` removed the job from the
outbox before the send, and the session did not hold the message yet. So the
next reconcile counted a new attempt and sent again. Then Pi delivered both.

**F5: Esc in the TUI, and a job that ends before the run stops.** TLC check
`old-f5-send-after-abort`, 12 steps. Live: `repro-f2.mts --one-job --job-after-abort`
gave `{"echo-a":2}` before the fix and `{"echo-a":1}` with it. This path
needs only one job and the TUI. The first version of this model made the
abort and the end of the run one step, so it could not find F5.

1. A run is active. The user presses Esc. The TUI clears the queue and calls
   `abort()`. The run winds down (for example, the model or a tool has not
   stopped yet).
2. A job ends in that time. Its completion is steered into the queue, after
   the clear.
3. The run ends. Pi emits `agent_settled` with `aborted: true`. The reconcile
   finds the job in neither the session nor the outbox, and `isIdle()` is
   true. It sends again.
4. The second send starts a run. That run also takes the kept message. The
   job lands two times.

**F4: one job and an abort that keeps the queue.** TLC check
`old-f4-abort-keeps-queue`, 12 steps. Live: `repro-f2.mts --one-job --keep-queue`
(RPC) and `repro-f2.mts --one-job --compact` (`/compact` in the TUI) gave
`{"echo-a":2}` before the fix and `{"echo-a":1}` with it (the completion
lands in the next user run). The first version of the fix also gave
`{"echo-a":2}` for `--compact`.

1. A job ends during a run. Its completion is steered into the run.
2. The run is aborted without a clear of the queue: an RPC client sends
   `abort`, an extension calls `ctx.abort()` in RPC, print or SDK mode, or
   the user enters `/compact`, `/new`, `/resume` or `/fork` in the TUI.
3. Pi emits `agent_settled`. The reconcile finds the job in neither the
   session nor the outbox, and `isIdle()` is true. It sends again.
4. The next run takes both messages.

**F2a: two jobs.** TLC check `old-f2-two-jobs`, 23 steps. Live: `repro-f2.mts`
(Esc in the TUI) gave `{"echo-a":1,"echo-b":2}` before the fix and
`{"echo-a":1,"echo-b":1}` with it.

1. Two jobs end late in a run. Their tail reads are in flight when the run
   ends. (Or: their completions were steered into the run, and the user
   pressed Esc, which drops them.)
2. Pi emits `agent_settled`. The shell-jobs handler waits for the reads (or,
   after Esc, sends both again).
3. Both sends happen while the handler runs, so Pi defers both.
4. Pi runs the first deferred send. It starts a run, and j1 lands.
5. That run's own `agent_settled` reconciles. j2 is not in the session and not
   in the outbox, so it counts a new attempt and sends j2. Pi defers that
   send and runs it: j2 lands.
6. Pi runs the second deferred send of step 3. j2 lands a second time.

**F2b: one job and a prompt.** TLC check `old-f2-one-job-prompt`, 19 steps;
not reproduced live.

1. A job ends during a run. Its tail read is in flight when the run ends.
2. Pi emits `agent_settled`. The reconcile skips the job (it is in the
   outbox) and waits for the read.
3. The user sends a prompt. Pi defers it.
4. The read ends. `sendCompletion` sends; Pi defers it after the prompt.
5. Pi runs the prompt. Its run's `agent_settled` reconciles: the job is not
   in the session and not in the outbox, so it sends again. The job lands.
6. Pi runs the send of step 4. The job lands a second time.

**F1: a reload during agent_settled.** TLC check `old-f1-one-job-reload`,
14 steps. Live: `repro-f1.mts` gave 2 messages before the fix and 1 with it;
the control with `--no-reload` gives 1. The repro calls `session.reload()`
and Pi's own `_emitAgentSettled()`, because it has no model and no TUI.

1. A job's send is deferred during `agent_settled`, as in F2b steps 1, 2
   and 4.
2. Another extension's handler still runs. The user runs `/reload`. Pi allows
   it, because no run is active.
3. The new `session_start` reconciles: `isIdle()` is true, and the job is
   neither in the session nor in the outbox. It sends again.
4. The handlers end. Pi runs the deferred send. The second send lands too.

**F3: an extension before shell-jobs awaits in agent_settled.** TLC check
`old-f3-earlier-handler`, 15 steps; not reproduced live. A read ends after Pi
started `agent_settled` but before the shell-jobs handler reconciles. Its send
is deferred, and the reconcile sends again.

**Impact before the fix.** High for F5: one job and Esc in the TUI. F4 needed
an abort that keeps the queue, for example `/compact` during a run in the TUI. F2a needed two jobs that end near the end of the
same run. F2b needed a prompt in the few milliseconds of `agent_settled`. F1
and F3 needed another extension with a slow `agent_settled` handler. The harm
was a second copy of a job result and an extra model turn.

**A fix in Pi.** Pi can also close finding F: make `isIdle` false while
actions wait in `_deferredSettledActions` or while Pi runs them, and while
messages wait in the agent's queues (`agent.hasQueuedMessages()`).
`old-pi-idle-counts-pending` shows that this closes every path for the code
before the fix. The first half alone is not enough (`old-pi-idle-counts-deferred`).
The pi-extras fix holds with each half and with both
(`pi-idle-counts-deferred`, `pi-idle-counts-pending`). `pi-issue-fact-sheet.md`
has the facts for a Pi issue.

## How the model stays true to the code

- `tests/shell-jobs-delivery-conformance.test.mts` replays 206 model traces
  (200 random from `faithful-runs3`, 6 witnesses) step by step against the
  real `lib/shell-jobs-delivery.ts` and `parkForReload` in `npm test`. After
  each step, the code state (attempts, delivered, failed, claimed, outbox,
  reads in flight, held completions, binding, sends, messages in the session,
  the retry timer) must equal the model state. The replay records the timer
  that each binding arms, and `retryFire` runs that timer's real callback.
- The same file has one regression test for each path of finding F (F1, F2a,
  F2a through Esc, F2b, F3, F4, F5), a test for a run that fails to start, a
  test for the attempt cap, three tests for the gap wait (Esc during
  `before_agent_start`, the `agent_before_settle` gap, and Esc in that gap)
  and a test for the retry timer. `tests/shell-jobs-reload.test.mts` checks
  the gap wait through the whole extension: no send in a gap, also past the
  retry, the `agent_start` flush, and the retry after a gap with no event.
- The trace replay alone caught 11 of 12 changes to the real code: the held
  skip, a release after an aborted run, the release of `pending` sends,
  `pending` held as `steered`, a `noteRunStart` that does nothing, an
  acknowledgement that keeps the held entry, the binding check, the outbox
  skip, the history lookup, the `isIdle()` check, and the outbox removal
  before the send. It missed the attempt cap plus one: with the fix, the cap
  needs more aborts than `faithful-runs3` allows, so no trace reaches it. The
  attempt-cap test catches that change.
- For the gap wait, the replay catches a removed gap wait, a removed check
  before the read and a timer that never arms. Two gap-path tests also
  catch the removed check before the read. The tests above catch an `idle`
  probe that is always true, a timer that never arms, a timer that arms only once, no
  `agent_start` flush, and no fallback flush in `session_start`. One change
  survives: a second flush after the reconcile in `session_start`. It only
  flushes again, and the replay copies that handler, so it cannot see it.
- The replay copies a few lines of the code that it does not run (`finalize`,
  `stopJob`, the event handlers). Each copy names its source.
- Its Pi is a fake that follows the model's Pi rules. The replay does not
  check those rules against Pi. The live scripts do: `pi-probe.mts` checks the
  six rules of the fix and the four rules behind finding F and the gap wait
  with a minimal extension, `repro-f2.mts` checks the one-at-a-time deferred runs, the Esc
  drop, the abort that keeps the queue and the send after a TUI abort, and
  `repro-f1.mts` checks the deferral and the reload, and `repro-gap.mts`
  checks Esc during a slow `before_agent_start` handler. An earlier version of
  this model put all deferred sends into one run, a later one let every abort
  clear the queue, the one before the fix made an abort and the end of
  its run one step, and the first gap-wait version (`3fa6099`) let an Esc
  drop a run's first message. Each time, a review or a live script found the
  error. At `3fa6099`, `fv.json` also did not list the two new invariants, so
  `faithful` passed without them; a review found that too. List each new
  invariant in `fv.json` before the run that is to check it.
  Check each platform rule against the real platform.
- A witness is an invariant that the simulator must break, so that the traces
  reach a rare state: a message that lands while parked, a message that an
  abort kept while the reconcile runs, a second send after a release, a
  deferred send held while a nested `agent_settled` reconciles, a send
  into a run whose abort was requested, and a read that ends in a gap and
  waits.
- `fv.mjs drift formal/shell-jobs-delivery` lists the covered files that
  changed after the sync commit. When it lists a file, read the change,
  update the model, run `check` and `traces`, run the replay test, and then
  move `syncCommit` in `fv.json`.

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs setup
node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery
node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery --only old-f5-send-after-abort --trace
node skills/formal-verification/scripts/fv.mjs traces formal/shell-jobs-delivery
node --import ./tests/support/keep-alive.mjs --test tests/shell-jobs-delivery-conformance.test.mts
node skills/formal-verification/scripts/fv.mjs drift formal/shell-jobs-delivery
node formal/shell-jobs-delivery/pi-probe.mts
node formal/shell-jobs-delivery/repro-f2.mts
node formal/shell-jobs-delivery/repro-f2.mts --one-job --keep-queue
node formal/shell-jobs-delivery/repro-f2.mts --one-job --job-after-abort
node formal/shell-jobs-delivery/repro-f1.mts
node formal/shell-jobs-delivery/repro-gap.mts
node formal/shell-jobs-delivery/repro-gap.mts --no-esc
```

Set `PI_TEST_AGENT_ROOT` to the folder of another
`@earendil-works/pi-coding-agent` to run the live scripts on that Pi version.
