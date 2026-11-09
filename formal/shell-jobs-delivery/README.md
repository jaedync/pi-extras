# Formal check: shell job completion delivery

This folder holds a model of the shell-jobs delivery code in Quint, the
checks that TLC runs on it, the traces that a test replays against the code,
two live repros and a probe of the Pi rules. The `formal-verification` skill
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
| `steered` | An agent loop runs, and it is not aborted. Pi steers the message into the run's queue. | A run that settles with no abort: it drained its queue. An aborted run in the TUI: the TUI clears the queue before each abort. |
| `kept` | The loop is being aborted (`signal.aborted`). Pi keeps the message for the next run in every mode, also in the TUI. | A run that settles with no abort. |
| `pending` | No agent loop runs: Pi is idle, agent_settled handlers run, or the run is between loops. Pi starts a run for the message, at once or after the handlers. | `before_agent_start` names the message as the start of a run: then it is `steered`. |

An abort outside the TUI (the RPC `abort`, or `ctx.abort()` in RPC, print or
SDK mode) keeps the queue, so it releases nothing. A completion that lands
(`message_end`, or the history lookup of a later reconcile) leaves `held`.

Two choices are trades. They make the fix safe for every Pi rule that the
model has:

- After an abort outside the TUI, the completion lands in the next run. It
  does not start a run of its own. Shell-jobs cannot tell a kept queue from a
  cleared one (an RPC client can send `clear_queue` and then `abort`). If the
  queue was cleared, the completion is sent again when the next run settles.
- `isIdle()` does not tell a deferred send from a send that starts a run. A
  first version of the fix used it. The check `pi-idle-counts-deferred` then
  found a duplicate: if Pi makes `isIdle()` count deferred actions (one half
  of the Pi fix below), that version sent a deferred completion again.
  `ctx.signal` does not have this problem.

`pi-probe.mts` checks the Pi rules that the fix uses, on any Pi version.

## What the model covers

Each action is one synchronous segment of the code: the code between two
`await`s. TLC tries every order of these segments. The model covers this code:

- `lib/shell-jobs-delivery.ts`: `attachDelivery`, `flush`, `sendCompletion`,
  `noteRunStart`, `acknowledgeCompletion`, `settleDeliveries`,
  `reconcileDeliveries`.
- `extensions/shell-jobs.ts`: `finalize`, and the `session_start`,
  `message_end`, `before_agent_start`, `agent_settled` and `session_shutdown`
  (reload) handlers.
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
  (`pi-agent-core/dist/agent.js`). It is undefined when no loop runs, and
  `abort()` aborts it at once. While the session is busy, a loop can run or
  not (during `_prepareRun` and between loops): the model tries both.
- An abort is two steps: `AgentSession.abort()` sets
  `_agentRunAbortRequested`, and later the run ends. A send between the two
  goes into the queue. The run then ends with the message still in the queue.
- In the TUI, every abort clears the queues first: Esc, tree navigation and
  an extension's `ctx.abort()`, which goes through the TUI's `abortHandler`.
  All three call `clearAllQueues` (`restoreQueuedMessagesToEditor`,
  `dist/modes/interactive/interactive-mode.js`). The clear comes before the
  abort, so a send after the clear stays in the queue.
- Other modes keep the messages. The RPC `abort` command and `ctx.abort()` in
  a mode with no `abortHandler` (RPC, print, SDK) call `AgentSession.abort()`
  alone. It and `Agent.abort()` do not touch the queues, and the next run
  takes the messages.
- `/reload` refuses only while a run is active. It then awaits before
  shell-jobs parks. `runtime.held` survives the reload.
- Pi emits each event to the handlers of the runner that started the
  emission. After a reload parks shell-jobs, its old handlers do nothing.

## Bounds and what they leave out

The default checks use 2 jobs, 1 reload, 2 user runs or aborts, and 3
attempts. `faithful-wide` uses 3 jobs (20,553,032 states). `faithful-runs3`
uses 3 user runs or aborts. The TUI flag is chosen at the start, so each
check covers the TUI and the other modes. Inside these bounds the check is
exhaustive. It does not cover:

- More jobs, reloads or runs than the bounds.
- Quit, restart hand-over (`lib/shell-jobs-adopt.ts`), and `beginClosing`.
  A restart starts a new Pi process with no held messages, and a new runtime
  with an empty `held` map.
- `trimRetained`, which can drop a job record (and its `held` entry).
- Compaction, which makes `isIdle()` false.
- A history that cannot be read (`lookupCompletion` returns "unknown").
- A failed `pi.sendMessage`, and a send through the old API after Pi
  invalidated it. The code then removes the `held` entry.
- A failed run start (`_prepareRun` throws). A unit test covers it: the
  completion is sent again after the next run settles.
- A second kill of the same job.
- A `clear_queue` while no run is active (RPC), or a TUI Esc while Pi is
  settling. These drop a message. A kept completion then lands only after a
  later run settles and reconcile sends it again. This affects only liveness.
- The model lets a run's first message be dropped by an abort that clears the
  queue. Pi does not drop it. This only adds behavior to the model.
- Liveness: the model checks that nothing bad happens, not that each
  completion arrives in the end.

## Results

Run `node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery`.
The `old-` checks set `HELD_GUARD` to false: the code before the fix.

| Check | Expect | Result |
|---|---|---|
| `faithful` | pass | pass, 453,016 states |
| `faithful-wide` | pass | pass, 20,553,032 states |
| `faithful-runs3` | pass | pass, 1,191,816 states |
| `old-faithful` | violates `oneCompletion` | violation, 12 steps |
| `f2-pi-extras-alone` / `old-` | pass / violates `oneCompletion` | pass / violation (F4), 12 steps |
| `f2-two-jobs` / `old-` | pass / violates `oneCompletion` | pass / violation (F2a), 23 steps |
| `f1-one-job-reload` / `old-` | pass / violates `oneCompletion` | pass / violation (F1), 14 steps |
| `f2-one-job-prompt` / `old-` | pass / violates `oneCompletion` | pass / violation (F2b), 19 steps |
| `f3-earlier-handler` / `old-` | pass / violates `oneCompletion` | pass / violation (F3), 15 steps |
| `f4-abort-keeps-queue` / `old-` | pass / violates `oneCompletion` | pass / violation (F4), 12 steps |
| `f5-send-after-abort` / `old-` | pass / violates `oneCompletion` | pass / violation (F5), 12 steps |
| `pi-idle-counts-deferred` | pass | pass |
| `old-pi-idle-counts-deferred` | violates `oneCompletion` | violation (F4) |
| `pi-idle-counts-pending` (and `-wide`, `-runs3`) | pass | pass (21,383,088 states wide) |
| `old-pi-idle-counts-pending` | pass | pass: the Pi fix alone also closes finding F |
| `survivor-send-ignores-binding` | pass | pass |
| `survivor-reconcile-ignores-idle` | pass | pass |
| `mutant-reconcile-ignores-outbox` | violates `attemptsCountSends` | violation |
| `mutant-claim-unchecked` | violates `stoppedMeansSilent` | violation |
| `mutant-finalize-ignores-claim` | violates `attemptsCountSends` | violation |
| `mutant-reconcile-ignores-history` | violates `oneCompletion` | violation |
| `mutant-attempt-cap-off-by-one` | violates `boundedSends` | violation |
| `mutant-ack-on-send` | violates `deliveredMeansSeen` | violation |
| `mutant-release-pending` | violates `oneCopy` | violation |
| `mutant-release-ignores-abort` | violates `oneCompletion` | violation |
| `mutant-pending-as-steered` | violates `oneCopy` | violation |
| `mutant-kept-as-steered` | violates `oneCompletion` | violation |
| `mutant-session-start-releases` | violates `oneCompletion` | violation |

Each `f` check turns off the other sources of the duplicate, so that its
`old-` twin shows one path. The `old-f1` to `old-f4` checks also stop reads
from ending while an aborted run winds down (`SEND_AFTER_ABORT`). Without
that, TLC finds the shorter path F5 first.

On a loaded machine (load average near 50), a few checks ended with "error"
in the Apalache compile step. Each one gave the expected result when it ran
again alone.

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
gave `{"echo-a":2}` before the fix and `{"echo-a":1}` with it (the completion
lands in the next user run).

1. A job ends during a run. Its completion is steered into the run.
2. The run is aborted without a clear of the queue: an RPC client sends
   `abort`, or an extension calls `ctx.abort()` in RPC, print or SDK mode.
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
an abort outside the TUI. F2a needed two jobs that end near the end of the
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
  reads in flight, held completions, binding, sends, messages in the session)
  must equal the model state.
- The same file has one regression test for each path of finding F (F1, F2a,
  F2a through Esc, F2b, F3, F4, F5), and tests for the trades: an abort that
  clears the queue outside the TUI, and a run that fails to start.
- The trace replay alone caught 13 of 13 changes to the real code: the held
  skip, the release that ignores the abort or the mode, the release of
  `pending` sends, `kept` held as `steered`, `pending` held as `steered`, a
  `noteRunStart` that does nothing, an acknowledgement that keeps the held
  entry, the binding check, the outbox skip, the history lookup, the attempt
  cap, the `isIdle()` check, and the outbox removal before the send.
- The replay copies a few lines of the code that it does not run (`finalize`,
  `stopJob`, the event handlers). Each copy names its source.
- Its Pi is a fake that follows the model's Pi rules. The replay does not
  check those rules against Pi. The live scripts do: `pi-probe.mts` checks the
  five rules of the fix and the three rules behind finding F with a minimal
  extension, `repro-f2.mts` checks the one-at-a-time deferred runs, the Esc
  drop, the abort that keeps the queue and the send after a TUI abort, and
  `repro-f1.mts` checks the deferral and the reload. An earlier version of
  this model put all deferred sends into one run, a later one let every abort
  clear the queue, and the one before the fix made an abort and the end of
  its run one step. Each time, a review or a live script found the error.
  Check each platform rule against the real platform.
- A witness is an invariant that the simulator must break, so that the traces
  reach a rare state: a job marked "not delivered", a message that lands
  while parked, a message that an abort kept while the reconcile runs, a
  second send after a release, a deferred send held while a nested
  `agent_settled` reconciles, and a send that went into a run being aborted.
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
```

Set `PI_TEST_AGENT_ROOT` to the folder of another
`@earendil-works/pi-coding-agent` to run the live scripts on that Pi version.
