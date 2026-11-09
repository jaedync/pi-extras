# Formal check: shell job completion delivery

This folder holds a model of the shell-jobs delivery code in Quint, the
checks that TLC runs on it, the traces that a test replays against the code,
and two live repros. The `formal-verification` skill made it. The skill
folder is `skills/formal-verification`.

## The promise

The `shell_job` tool says: "One completion message per job is delivered
automatically, except for killed jobs." (`extensions/shell-jobs.ts:708`).

The harm when the promise breaks: the model gets a job result two times and
starts an extra turn for it, or gets the result of a job that the user
stopped, or the widget shows a wrong count of attempts.

## Properties

| Invariant | In plain words |
|---|---|
| `oneCompletion` | The session never holds two completion messages for one job. |
| `stoppedMeansSilent` | A kill that answered "stopped" never gets a completion message. |
| `boundedSends` | The code sends a completion at most 3 times (`MAX_COMPLETION_ATTEMPTS`). |
| `deliveredMeansSeen` | A job is marked delivered only when its message is in the session. |
| `attemptsCountSends` | Each counted attempt is one send, or one send that waits in the outbox (`lib/shell-jobs-delivery.ts:130-132`). |

## What the model covers

Each action is one synchronous segment of the code: the code between two
`await`s. TLC tries every order of these segments. The model covers this code:

- `lib/shell-jobs-delivery.ts`: `attachDelivery`, `flush`, `sendCompletion`,
  `acknowledgeCompletion`, `reconcileDeliveries`.
- `extensions/shell-jobs.ts`: `finalize`, and the `session_start`,
  `message_end`, `agent_settled` and `session_shutdown` (reload) handlers.
- `lib/shell-jobs-manage.ts`: `stopJob`.
- `lib/shell-jobs-process.ts`: `parkForReload`.

It also covers the parts of Pi that the delivery depends on. These come from
Pi's source (1.4.0; 1.5.0 is the same here):

- `sendCustomMessage` with `triggerTurn` (`dist/core/agent-session.js:1844-1872`):
  it steers into an active run, or starts a run. While `agent_settled`
  handlers run, it waits in `_deferredSettledActions`. A user prompt waits
  there too (`:1631-1634`).
- `_emitAgentSettled` (`:683-705`): after the handlers, Pi runs the waiting
  actions one at a time (`for (const action of deferred) await action()`).
  Each one starts a run, and that run's own `agent_settled` runs inside the
  `await`.
- The extension runner awaits each `agent_settled` handler in turn
  (`dist/core/extensions/runner.js:813-838`). The handler of an extension
  that loads before shell-jobs can await, so other segments can run before
  the shell-jobs handler.
- `isIdle` is `!_isAgentRunActive && !isCompacting`. It ignores the actions
  that wait.
- `/reload` (`dist/modes/interactive/interactive-mode.js:5328-5350`) refuses
  only while a run is active. It then awaits before shell-jobs parks.
- Esc clears the queues (`clearQueue`) and aborts the run. The messages that
  the run did not take are gone.

## Bounds and what they leave out

The default checks use 2 jobs, 1 reload, 2 user runs or aborts, and 3
attempts. `-wide` uses 3 jobs (3,644,040 states, about 40 s with all cores).
`-runs3` uses 3 user runs. Inside these bounds the check is exhaustive. It
does not cover:

- More jobs, reloads or runs than the bounds.
- Quit, restart hand-over (`lib/shell-jobs-adopt.ts`), and `beginClosing`.
- `trimRetained`, which can drop a job record.
- Compaction, which makes `isIdle()` false.
- A history that cannot be read (`lookupCompletion` returns "unknown").
- A failed `pi.sendMessage`, a failed run start, and a send through the old
  API after Pi invalidated it (it throws, `dist/core/extensions/loader.js:305-307`).
- A second kill of the same job.
- Liveness: the model checks that nothing bad happens, not that each
  completion arrives in the end.

## Results (sync commit `b96bac5`)

Run `node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery`.

| Check | Expect | Result |
|---|---|---|
| `faithful` | violates `oneCompletion` | violation (path F3), 13 steps |
| `f2-pi-extras-alone` | violates `oneCompletion` | violation (path F2b), 17 steps |
| `f2-two-jobs` | violates `oneCompletion` | violation (path F2a), 19 steps |
| `f1-one-job-reload` | violates `oneCompletion` | violation (path F1), 13 steps |
| `f2-one-job-prompt` | violates `oneCompletion` | violation (path F2b), 17 steps |
| `pi-idle-counts-deferred` | pass | pass, 101,272 states |
| `pi-idle-counts-deferred-wide` | pass | pass, 3,644,040 states |
| `pi-idle-counts-deferred-runs3` | pass | pass, 241,748 states |
| `survivor-send-ignores-binding` | pass | pass |
| `mutant-reconcile-ignores-outbox` | violates `attemptsCountSends` | violation |
| `mutant-claim-unchecked` | violates `stoppedMeansSilent` | violation |
| `mutant-finalize-ignores-claim` | violates `attemptsCountSends` | violation |
| `mutant-reconcile-ignores-idle` | violates `oneCompletion` | violation |
| `mutant-reconcile-ignores-history` | violates `oneCompletion` | violation |
| `mutant-attempt-cap-off-by-one` | violates `boundedSends` | violation |
| `mutant-ack-on-send` | violates `deliveredMeansSeen` | violation |

The mutants run on `pi-idle-counts-deferred`, the variant that assumes the
Pi fix, because the faithful model already breaks `oneCompletion`.

A mutant is a change to the model that copies a change to the code, for
example a removed check. Each mutant must break a property. This shows that
the check can fail. Each property has at least one mutant. A survivor is a
mutant that breaks no property:

- `survivor-send-ignores-binding`: the binding check in `sendCompletion`
  (`lib/shell-jobs-delivery.ts:71`). With the Pi fix, no reconcile runs while
  the old binding's send waits, so that send cannot make a second message.
  The check stops a send through the old API, which throws after Pi
  invalidates the old runner. The message then waits for the next reconcile.
  The model has no liveness property for that delay. The conformance replay
  catches this change.
- The claim is checked two times: in `finalize` and in `sendCompletion`.
  Without the `finalize` check, the send still stops, but the attempt count
  is wrong (`mutant-finalize-ignores-claim`). Without both, a stopped job
  gets a completion (`mutant-claim-unchecked`).

## Finding F: one completion can be delivered two times

**Cause.** `reconcileDeliveries` takes `ctx.isIdle()` to mean "Pi holds no
completion that it has not put in the session" (`lib/shell-jobs-delivery.ts:118-121`).
That is not true. While `agent_settled` handlers run, and while Pi runs the
actions that waited, `isIdle()` can be true while Pi holds a completion that
shell-jobs sent. `sendCompletion` removed the job from the outbox before the
send (`:90`), and the session does not hold the message yet. So the next
reconcile counts a new attempt and sends again. Then Pi delivers both.

Each path needs a second action that Pi defers. All four paths are TLC
counterexamples, and the conformance test replays one of them in the code.

**F2a: two jobs (no reload, no prompt, pi-extras alone).** TLC check
`f2-two-jobs` (it allows aborts but needs none). Status: confirmed in a
real Pi `AgentSession` with real model runs (Pi's faux provider), on Pi 1.4.0
and 1.5.0: `repro-f2.mts` gives `{"echo-a":1,"echo-b":2}`. The repro reaches
step 3 through Esc, which drops the two steered completions. The control
with one job (`--one-job`) gives 1 message.

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

**F2b: one job and a prompt (no reload, pi-extras alone).** TLC only
(`f2-one-job-prompt`); not reproduced live.

1. A job ends during a run. Its tail read is in flight when the run ends.
2. Pi emits `agent_settled`. The reconcile skips the job (it is in the
   outbox) and waits for the read.
3. The user sends a prompt. Pi defers it.
4. The read ends. `sendCompletion` sends; Pi defers it after the prompt.
5. Pi runs the prompt. Its run's `agent_settled` reconciles: the job is not
   in the session and not in the outbox, so it sends again. Pi defers that
   send and runs it: the job lands.
6. Pi runs the send of step 4. The job lands a second time.

**F1: a reload during agent_settled.** Status: confirmed in a real Pi
`AgentSession` with `repro-f1.mts` (Pi 1.4.0 and 1.5.0); the control with
`--no-reload` gives 1 message. The repro calls `session.reload()` and Pi's
own `_emitAgentSettled()`, because it has no model and no TUI. The job ends
during the emission, not during a run.

1. A job's send is deferred during `agent_settled`, as in F2b steps 1-4.
2. Another extension's handler still runs. The user runs `/reload`. Pi allows
   it, because no run is active.
3. The new `session_start` reconciles: `isIdle()` is true, and the job is
   neither in the session nor in the outbox. It sends again. Pi defers it.
4. The handlers end. Pi runs both sends.

**F3: an extension before shell-jobs awaits in agent_settled.** TLC only
(`faithful`, the shortest path). A read ends after Pi started
`agent_settled` but before the shell-jobs handler reconciles. Its send is
deferred, and the reconcile sends again.

**Impact.** Medium. F2a needs only pi-extras and two jobs that end near the
end of the same run, or two completions that Esc dropped. F2b needs a prompt in the few milliseconds of `agent_settled`.
F1 and F3 need another extension with a slow `agent_settled` handler. The
harm is a second copy of a job result and an extra model turn.

**Fix options (not made; the owner decides).**

- In Pi: make `isIdle` false while actions wait in `_deferredSettledActions`
  or while Pi runs them. Pi's doc comment on `isIdle` says that it also means
  no "queued continuation". The variant `pi-idle-counts-deferred` models
  this fix, and every property holds there, also at the wider bounds.
- In shell-jobs: keep a sent completion as "in flight" until it lands or a
  run that could hold it ends with an abort, and let reconcile skip it until
  then. This fix is not modeled yet. Model it before you build it.

## How the model stays true to the code

- `tests/shell-jobs-delivery-conformance.test.mts` replays 203 model traces
  (200 random, 3 witnesses) step by step against the real
  `lib/shell-jobs-delivery.ts` and `parkForReload` in `npm test`. After each
  step, the code state (attempts, delivered, failed, claimed, outbox, reads in
  flight, binding, sends, messages in the session) must equal the model state.
- The replay copies a few lines of the code that it does not run (`finalize`,
  `stopJob`, the event handlers). Each copy names its source line.
- Its Pi is a fake that follows the model's Pi rules. The replay does not
  check those rules against Pi. The live repros do: `repro-f2.mts` checks the
  one-at-a-time deferred runs and the Esc drop, and `repro-f1.mts` checks the
  deferral and the reload. An earlier version of this model put all deferred
  sends into one run; a review found the error by reading Pi's source, and
  `repro-f2.mts` confirmed it. Check each platform rule against the real
  platform.
- A witness is an invariant that the simulator must break, so that the traces
  reach a rare state: a job marked "not delivered", a message that lands
  while parked, and the duplicate.
- The replay caught 7 of 9 changes to the real code: the binding check, the
  outbox skip, the in-flight read check, the history lookup, the attempt cap,
  the `isIdle()` check, and the outbox removal before the send. It did not
  catch the `latest.claimed` check, which no model behavior needs, and the
  early return of `acknowledgeCompletion`, which changes nothing.
- The replay does not run the kill answer (`stopJob` after its wait). The
  model's rule that the answer wins over the timeout comes from reading
  `withTimeout` (`lib/shell-jobs-manage.ts:171-183`).
- `fv.mjs drift formal/shell-jobs-delivery` lists the covered files that
  changed after the sync commit. When it lists a file, read the change,
  update the model, run `check` and `traces`, run the replay test, and then
  move `syncCommit` in `fv.json`.

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs setup
node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery
node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery --only f2-pi-extras-alone --trace
node skills/formal-verification/scripts/fv.mjs traces formal/shell-jobs-delivery
node --import ./tests/support/keep-alive.mjs --test tests/shell-jobs-delivery-conformance.test.mts
node skills/formal-verification/scripts/fv.mjs drift formal/shell-jobs-delivery
node formal/shell-jobs-delivery/repro-f2.mts
node formal/shell-jobs-delivery/repro-f1.mts
```
