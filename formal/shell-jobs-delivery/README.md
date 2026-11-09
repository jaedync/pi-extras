# Formal check: shell job completion delivery

This folder holds a model of the shell-jobs delivery code in Quint, the
checks that TLC runs on it, and the traces that a test replays against the
code. The `formal-verification` skill made it. The skill folder is
`skills/formal-verification`.

## The promise

The `shell_job` tool says: "One completion message per job is delivered
automatically, except for killed jobs." (`extensions/shell-jobs.ts:708`).

The harm when the promise breaks: the model gets a job result two times, or
gets the result of a job that the user stopped, or the widget shows a wrong
count of attempts.

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
Pi's source (1.4.0 and 1.5.0, `dist/core/agent-session.js`):

- `sendCustomMessage` with `triggerTurn`: it steers into an active run, or
  starts a run. While `agent_settled` handlers run, it waits
  (`_deferredSettledActions`) and runs after the last handler.
- `isIdle` and `isStreaming` are false only while a run is active.
- `/reload` (`handleReloadCommand`) refuses only while `isStreaming` is true.
- An abort drops the messages that the run did not take yet.

## Bounds and what they leave out

The default checks use 2 jobs, 1 reload, 2 user runs or aborts, and 3
attempts. The `-wide` check uses 3 jobs, 2 reloads and 3 runs (3,038,808
states, about 30 s with all cores). Inside these bounds the check is
exhaustive. It does not cover:

- More jobs, reloads or runs than the bounds.
- Quit, restart hand-over (`lib/shell-jobs-adopt.ts`), and `beginClosing`.
- `trimRetained`, which can drop a job record.
- Compaction, which makes `isIdle()` false.
- A history that cannot be read (`lookupCompletion` returns "unknown").
- A failed `pi.sendMessage` or a failed run start.
- A second kill of the same job.
- Liveness: the model checks that nothing bad happens, not that each
  completion arrives in the end.

## Results (sync commit `b96bac5`)

Run `node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery`.

| Check | Expect | Result |
|---|---|---|
| `faithful` | violates `oneCompletion` | violation: finding F1, 11 steps |
| `no-reload-during-settle` | pass | pass, 11,916 states |
| `no-reload-during-settle-wide` | pass | pass, 3,038,808 states |
| `mutant-send-ignores-binding` | violates `oneCompletion` | violation |
| `mutant-reconcile-ignores-outbox` | violates `attemptsCountSends` | violation |
| `mutant-claim-unchecked` | violates `stoppedMeansSilent` | violation |
| `mutant-finalize-ignores-claim` | violates `attemptsCountSends` | violation |
| `survivor-start-ignores-busy` | pass | pass |
| `survivor-reconcile-history` | pass | pass |

A mutant is a change to the model that copies a change to the code, for
example a removed check. Each mutant must break a property. This shows that
the check can fail. A survivor is a mutant that breaks no property. It shows
a guard that no behavior in the model needs:

- The `isIdle()` check in `reconcileDeliveries` guards compaction, which the
  model leaves out.
- The history lookup in `reconcileDeliveries` is needed only when a message
  lands while the runtime is parked. With reload refused during
  `agent_settled`, that cannot happen in the model. The lookup also guards
  the restart hand-over, which the model leaves out.
- The claim is checked two times: in `finalize` and in `sendCompletion`.
  Without the `finalize` check, the send still stops, but the attempt count
  is wrong (`mutant-finalize-ignores-claim`). Without both, a stopped job
  gets a completion (`mutant-claim-unchecked`).

## Finding F1: a reload during agent_settled delivers a completion two times

Status: confirmed in a real Pi `AgentSession` (Pi 1.4.0 and 1.5.0) with
`repro-f1.mts`. Impact: low. It needs another extension whose
`agent_settled` handler waits for I/O, and a `/reload` in that time.

The path that TLC found:

1. Job j1 ends while a run is active. `finalize` counts attempt 1, puts j1
   in the outbox, and starts the log tail read.
2. The run ends. Pi sets the run inactive and emits `agent_settled`. The
   shell-jobs handler reconciles (j1 is in the outbox, so it skips j1) and
   waits for the read.
3. The read ends. `sendCompletion` removes j1 from the outbox and calls
   `pi.sendMessage`. Pi defers the send, because `agent_settled` handlers
   still run.
4. The handler of another extension still runs. The user runs `/reload`.
   Pi allows it, because no run is active.
5. The new `session_start` reconciles. `isIdle()` is true, the session holds
   no completion for j1, and the outbox does not hold j1. So it counts
   attempt 2 and sends again. Pi defers this send too.
6. The last handler ends. Pi runs both deferred sends. The session now holds
   two completion messages for j1.

Cause: `reconcileDeliveries` takes `isIdle()` to mean "Pi holds no message
that it has not put in the session yet" (`lib/shell-jobs-delivery.ts:118`).
While `agent_settled` handlers run, `isIdle()` is true but Pi can hold
deferred sends. Pi's own comment on `isIdle` says that it also means no
"queued continuation".

Fix options (not made; the owner decides):

- In Pi: make `isIdle` false while `_isEmittingAgentSettled` is true or
  `_deferredSettledActions` is not empty. This matches its doc comment.
- In shell-jobs: mark a job when its send may be deferred, and let the
  `session_start` reconcile skip it until the next `agent_settled`.

The faithful check keeps the finding. The `no-reload-during-settle` check
assumes the Pi fix, and every other property holds there.

## How the model stays true to the code

- `tests/shell-jobs-delivery-conformance.test.mts` replays 203 model traces
  (200 random, 3 witnesses) step by step against the real
  `lib/shell-jobs-delivery.ts` in `npm test`. After each step, the code state
  must equal the model state. The replay copies a few lines of the code it
  does not run (`finalize`, `stopJob`, `parkForReload`, the handlers) and
  uses a fake Pi with Pi's deferral rule. Each copy names its source line.
- A witness is an invariant that the simulator must break, so that the traces
  reach a rare state: a job marked "not delivered", a message that lands
  while parked, and the F1 duplicate.
- The replay caught 7 of 9 changes to the real code: the binding check, the
  outbox skip, the in-flight read check, the history lookup, the attempt cap,
  the `isIdle()` check, and the outbox removal before the send. It did not
  catch the `latest.claimed` check, which no model behavior needs, and the
  early return of `acknowledgeCompletion`, which changes nothing.
- `fv.mjs drift formal/shell-jobs-delivery` lists the covered files that
  changed after the sync commit. When it lists a file, read the change, update
  the model, run `check` and `traces`, run the replay test, and then move
  `syncCommit` in `fv.json`.

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs setup
node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery
node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery --only faithful --trace
node skills/formal-verification/scripts/fv.mjs traces formal/shell-jobs-delivery
node --test tests/shell-jobs-delivery-conformance.test.mts
node skills/formal-verification/scripts/fv.mjs drift formal/shell-jobs-delivery
node formal/shell-jobs-delivery/repro-f1.mts
```
