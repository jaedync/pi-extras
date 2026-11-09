# Subagent run lifecycle: formal verification record

This folder holds a Quint model of how the team starts, runs, stops,
relaunches and falls back a child agent. TLC checks the model. A replay test
runs the model's traces against the real code. Read this file for the
promise, the result, the five findings and their fixes, and the test
coverage table.

## The promise

The team (`lib/subagents/team.ts`) makes these promises to the parent:

- The parent hears of each run once. A stop, a relaunch or a fallback does
  not give a second report for one run, and it does not drop the report.
- `stop` stops the child. A stopped child makes no more model calls.
- A message to a child is not lost and does not reach the child twice.
- At most `maxConcurrent` children work at one time.

The harm when a promise breaks: a parent waits for a report that never comes,
reads a report twice, or pays for a child that it stopped. A stopped child
that still runs can also edit files that the user thinks are safe.

Why this area: `team.ts` has 43 `fix:` commits, the most of any file in
pi-extras. About 20 of them name an order bug: f20f490, 4a8fa14, 16b4817,
bbe26b8, ed79b8b, 83b54c4, eeb8a58, d00e37f, 1d8a389, 8d54da9 and others.

## Tool

Quint 0.33.1 with TLC (through `fv.mjs`). The question is about the order of
events across awaits, so a model checker that tries every order fits.

## Properties

| Invariant | What it says |
|---|---|
| `oneReport` | A run hands up at most one report (`handUp` or `handUpFailure`). |
| `reportOnEnd` | A child that ended, with no stop still at work, has handed its report up. |
| `waitersSettle` | `whenDone` resolves when the child is no longer live. |
| `noStuck` | A live child always has work in flight: a launch, a prompt of its current launch, or a place in line. |
| `slotsBound` | At most `maxConcurrent` children are starting or running. |
| `mailKept` | Each message from main is read once, or waits in the inbox, the resume prompt or the Pi queue. No message is lost or read twice. |
| `stopMeansStopped` | Each prompt that will still call the model belongs to the current run of a live child. |
| `oneSession` | The team holds a new session for a child only after the old one went. |
| `stopHonored` | A stop of a child that works is not refused. |
| `parentStopSilent` | A stop by the child's parent hands no report up, and every other end does. |

## What the model covers

Each action is one synchronous segment of the code. Each action and helper
cites its file and line in `lifecycle.qnt`.

- `lib/subagents/team.ts`: `spawn` (enqueue and pump), `stop` (by the user,
  or by main, the parent), `goOnWhenFree`, `runWhenFree`, `start`, `open`,
  `run`, `work`, `gone`, `late`, `failOrFallBack`, `resumeFailed`, `settle`,
  `fail`, `unreadLeft`, `parkResume`, `takeInbox`, `finish` (with the silent
  report of a stop by the parent).
- `lib/subagents/slots.ts`: `enqueue`, `free`, `goOn`, `remove`, `pump`, `used`.
- `lib/subagents/routing.ts`: `deliver`, `wake`, `relaunch` for messages from main.
- `lib/subagents/sessions.ts`: `hold`, `release`, `ended` and its quiet-spell timer.
- `lib/subagents/resume-prompts.ts`: `set`, `has`, `message`, `take`, `park`.
- `lib/subagents/mailbox.ts`: `unreadToInbox`, `stillUnread`.
- `lib/subagents/child-prompt.ts`: `promptGate` (`prompt`, `abort`,
  `steer`, `busy`), the fix of F1, F2 and F5. Four constants in the model
  stand for its parts (`GATE_REABORTS`, `GATE_ABORT_WAITS`, `DISPOSE_WAITS`,
  `PROMPT_WAITS_STEERS`). Each mutant at HEAD sets one of them false.
- `lib/subagents/child.ts`: the `prompt`, `steer`, `abort`, `takeQueued` of
  `handleFor`, and `childDisposer`. The replay runs the real gate and the real
  disposer over a fake Pi session.

### Source files covered (for mutation testing)

- `lib/subagents/team.ts`
- `lib/subagents/slots.ts`
- `lib/subagents/routing.ts` (the `deliver`, `wake` and `relaunch` part)
- `lib/subagents/sessions.ts` (not `runText`: the report text is not modeled)
- `lib/subagents/resume-prompts.ts`
- `lib/subagents/mailbox.ts`
- `lib/subagents/child-prompt.ts`
- `lib/subagents/child.ts` (only `childDisposer` and the handle's use of the gate)

### Platform rules (Pi 1.4.0) and how each was checked

| Rule | Source | Check |
|---|---|---|
| P1. `AgentSession.abort()` before `_startRun` sets `_isAgentRunActive` finds no run. It resolves at once, and the prompt then runs in full. | `agent-session.js:1631-1689` (awaits in `prompt`), `:1971-1989` (`abort`) | `probe-pi-abort.mts input`: the abort resolves, then 2 model calls and 1 bash run follow. |
| P2. An abort during `_prepareRun` (compaction check, `before_agent_start`) waits. The `agent_start` listener then stops the run before the first request. | `:1423-1449`, `:709-713` | `probe-pi-abort.mts prepare`: the abort waits for the hook, and the model gets 0 calls. |
| P3. `dispose()` disconnects that listener. A prompt in `_prepareRun` then runs its loop on the disposed session. Its tools fail ("ctx is stale"). | `:1001-1006`, `:1011-1030` | `probe-pi-abort.mts dispose`: 10 model calls after dispose (the faux model ran out of replies), every tool call failed. |
| P4. `dispose()` calls `agent.abort()`, which stops an active loop. It does not set `_agentRunAbortRequested`, so the `_startRun` loop can still retry, compact or continue on queued messages; no path in the model releases a running prompt that no stop aborted. | `:1017`, `:1450-1461`, `agent.js:221-222` | Read in the source only. |
| P5. `waitForIdle` resolves at the end of `_emitAgentSettled`, just before `prompt()` returns, with no macrotask between. So a stop goes on in the same chain as the end of the prompt. | `:683-707`, `:1464-1472` | Read in the source. `repro-f3.mts` and `repro-f4.mts` show a stop that waits for `agent_end` handlers. |
| P6. `steer()` first awaits the `input` handlers (`_queueUserInput`), and only then puts the message in the agent queue. child.ts:716-719 does not await it. The loop reads a queued message at a turn boundary, or `clearQueue` hands it back. Dispose does not clear the queue. | `:1752-1766`, `:1795-1807`, `:1944-1952`, `agent.js:203-206` | `repro-f5.mts`: with an input handler that waits, the message is on `unread` but not queued; it lands after the run ended. Added after the review (H1). |

## Bounds and what they leave out

- 2 children, `maxConcurrent` 1, 2 messages from main, 2 stops (each by the
  user or by main), 1 fallback model.
- Left out: questions and the `asking` state, the `waiting` state and
  grandchildren, `wait: true` parents, budgets and wrap-ups, check rounds,
  turn-boundary swaps (`swap.ts`), bash rests, panels, `after`, close and
  /reload hand-over, restore, stale sessions, and messages from peers and
  the user. The report text (`runText`) is not modeled.
- The quiet-spell timer fires at any time while the child is idle.
- Dispose is one step in the model. In the code, `childDisposer` first
  aborts the prompt in flight through the gate and waits for it, then awaits
  the `session_shutdown` handlers, and then calls Pi's dispose. In the model,
  `disposed` means "the dispose began".
- An aborted run ends with `stopReason "error"` in Pi, so `child.ts` throws.
  The model ends it as "aborted". In scope this changes nothing, because
  every aborted prompt is already `gone`.
- `session.prompt` can also reject (no model, no login). The model leaves
  that out: there the gate does not wait for steers in flight, and the
  failure path copies `unread` to the inbox.
- The model treats the code from the last `late()` to `settle()` as one
  segment. Since the fix of R1, the code does the same: `run()` takes the
  late mail again in the step of `settle()`. `SETTLE_GAP = true` gives the
  code before that fix (see R1).
- A pass covers only the model within these bounds. It is safety only, not liveness.

## Results

`node skills/formal-verification/scripts/fv.mjs check formal/subagents-lifecycle --workers 2`

| Check | Expected | Result | States | Depth |
|---|---|---|---|---|
| `faithful` | pass | pass | 494,863 | 29 |
| `pi-without-windows` | pass | pass | 273,133 | 23 |
| `mutant-gate-no-reabort` | violates stopMeansStopped | violation of stopMeansStopped | 94 | 5 |
| `mutant-dispose-no-wait` | violates stopMeansStopped | violation of stopMeansStopped | 331 | 5 |
| `survivor-abort-skips-pre` | pass | pass | 678,123 | 29 |
| `mutant-stop-refuses-ending` | violates stopHonored | violation of stopHonored | 1,155 | 6 |
| `mutant-old-stop-clears-ending` | violates reportOnEnd | violation of reportOnEnd | 20,184 | 10 |
| `mutant-old-stop-clears-parent-mark` | violates parentStopSilent | violation of parentStopSilent | 1,347 | 7 |
| `mutant-prompt-skips-steers` | violates mailKept | violation of mailKept | 11,857 | 9 |
| `mutant-stop-keeps-launch` | violates oneReport | violation of oneReport | 7,261 | 9 |
| `mutant-stop-ignores-relaunch` | violates oneReport | violation of oneReport | 5,997 | 9 |
| `mutant-work-ignores-gone` | violates oneReport | violation of oneReport | 6,364 | 9 |
| `mutant-open-ignores-gone` | violates oneSession | violation of oneSession | 830 | 6 |
| `mutant-stop-keeps-resume` | violates mailKept | violation of mailKept | 148 | 5 |
| `mutant-stop-drops-unread` | violates mailKept | violation of mailKept | 2,947 | 7 |
| `survivor-pump-starts-any` | pass | pass | 494,863 | 29 |
| `mutant-resume-ignores-slots` | violates slotsBound | violation of slotsBound | 3,661 | 8 |
| `mutant-finish-keeps-waiters` | violates waitersSettle | violation of waitersSettle | 2 | 2 |
| `mutant-release-busy` | violates noStuck | violation of noStuck | 14,664 | 9 |
| `mutant-resume-failed-drops-message` | violates mailKept | violation of mailKept | 199 | 5 |
| `mutant-fallback-keeps-session` | violates oneSession | violation of oneSession | 3,416 | 7 |
| `mutant-late-skips-queue` | violates mailKept | violation of mailKept | 11,394 | 9 |
| `mutant-stop-no-abort` | violates stopMeansStopped | violation of stopMeansStopped | 80 | 4 |
| `mutant-settle-skips-finish` | violates reportOnEnd | violation of reportOnEnd | 1,294 | 6 |
| `mutant-late-settle-gap` | violates mailKept | violation of mailKept | 20,549 | 9 |
| `mutant-late-settle-gap-no-stop` | violates mailKept | violation of mailKept | 560 | 9 |

All 26 checks give the expected result. The checks ran with 2 TLC workers on
a loaded host. Checks that first gave `error` (another process used the
Apalache port 8822 at the same time) gave the result above in a rerun with
`--only` and 1 worker. In the last run (task `fix-subagent-mail`), 6 checks
needed that rerun. With 2 workers, the states and the depth of a violation
can differ from run to run; the table shows one run.

At f194608 the record had 25 checks, and the findings were checks that
expected a violation (`faithful`, `faithful-mail`, `f2-dispose-in-prep`,
`f3-second-stop-refused`, `f4-old-stop-clears-ending`, `f5-steer-window`).
Now `faithful` (Pi 1.4.0 as it is, with the fixed code) passes all ten
properties at the same bounds. Each finding is a mutant of the fixed model
that copies the code at f194608.

## Findings and fixes

The sweep (`fv-sweep-extensions`) found F1 to F5 at commit f194608. The task
`fix-subagent-lifecycle` fixed all five. For each finding, this section gives
the path, the model change, the code change, and the live repro before and
after. "Before" is the repro script of this commit run on the code of
f194608. "After" is the same script on the fixed code. The repro scripts now
use the real `createLauncher` of `child.ts` (`repro-support.mts`), not a copy
of the handle, so they test the real fix.

The gate (`lib/subagents/child-prompt.ts`) is one fix for F1, F2 and F5. Pi
stays as it is. The gate gives the team the stop that Pi does not give.

### F1. A stop in the prompt's pre-run window did not stop the prompt

Path at f194608:

1. A child starts a prompt. Pi's `prompt()` awaits an `input` handler, an
   extension command or a login check before it sets `_isAgentRunActive` (P1).
2. A stop calls `handle.abort()`. Pi finds no active run, and the abort
   resolves at once.
3. The stop calls `finish`. The parent gets a "stopped" report, and the
   session is released and disposed.
4. Pi's `prompt()` goes on and runs the agent loop on the disposed session
   (P3). It calls the model with no listener.

Harm: model calls after a stop that nobody sees. Before the dispose ended,
the tools still worked, so a stopped child could still change files.

- Model change: the gate constants `GATE_REABORTS` and `GATE_ABORT_WAITS`.
  `abortOne` keeps an abort of a prompt in its pre window, the prompt keeps
  `abortReq` into `prep`, and `piAgentStart` stops it. `abortDone` (was
  `piIdle`) makes the stop wait for a prompt in its pre window.
  `willCallModel` of a pre prompt is now `not(prepStops(p))`.
- Code change: `child-prompt.ts` `prompt` passes `preflightResult` to Pi's
  `prompt()`. Pi calls it with `"started"` after its run exists and before
  the first request (`agent-session.js:1442`). When an abort came before
  that, the gate calls `session.abort()` again, and Pi's own agent_start
  check stops the run (P2). A compaction that Pi starts in `_prepareRun`
  comes before that point, so the gate also aborts at `compaction_start`
  (Pi's abort cancels the compaction). The gate's `abort` waits for Pi's
  abort and for the prompt in flight. Before the run started, it waits for
  at most `GATE_WAIT_MS` (10 s): a slow `input` or `before_agent_start`
  handler can't hang a stop. After the start, it waits as long as Pi's
  abort of the loop takes, as before. `child.ts` `handleFor` uses the gate
  for `prompt`, `abort` and `steering`.
- Mutant: `mutant-gate-no-reabort` breaks `stopMeansStopped` (depth 4).
- Repro `node formal/subagents-lifecycle/repro-f1.mts`:
  - Before (exit 1): `{"stopResolvedBeforeTheRun":true,"modelCallsAtStop":0,"modelCallsAfter":12,"disposed":true,"state":"stopped"}`
  - After (exit 0): `{"stopResolvedBeforeTheRun":false,"modelCallsAtStop":0,"modelCallsAfter":0,"disposed":true,"state":"stopped"}`
  - The control `--no-stop` gives one normal run with 2 model calls.

### F2. A message during a stop's abort disposed a preparing session, and its loop ran anyway

Path at f194608:

1. A child's prompt is in `_prepareRun` (a slow `before_agent_start` hook).
2. A stop calls `handle.abort()`. Pi records the abort and waits (P2).
3. Main messages the child. `deliver` sees an ended child, releases the
   held session (routing.ts:231) and relaunches the child.
4. `release` disposes the session. Dispose disconnects the `agent_start`
   listener (P3).
5. `_prepareRun` ends. The old session's loop starts with no listener and
   calls the model.

- Model change: the gate constant `DISPOSE_WAITS`. `disposeOne` aborts
  through the gate and marks the prompt disposed. `prepStops` stops it,
  because Pi's dispose comes only after the prompt ended. The model has no
  time, so the wait never ends at `GATE_WAIT_MS`, and the gate's agent
  listener (below) is not in the model.
- Code change: `child.ts` `childDisposer` takes the gate. When a prompt is
  in flight (`gate.busy()`), it first calls `gate.shut()`, which aborts and
  waits for the prompt for at most `GATE_WAIT_MS`. Only then it disposes the
  rate-limit guard, unsubscribes, runs the `session_shutdown` handlers and
  calls Pi's `dispose()`. For a dispose whose wait ended at `GATE_WAIT_MS`,
  the gate has its own listener on Pi's agent (`session.agent.subscribe`).
  Pi's dispose removes only the session's own agent listener, so the gate's
  listener stays. After `shut`, it calls `agent.abort()` at `agent_start` of
  an aborted run, as Pi's own check does (P2). A first version threw in
  `preflightResult("started")`. Pi calls it outside the try block of
  `_startRun`, so the run stayed active, Pi's idle wait never resolved, and
  the stop hung (the F2 repro found this).
- Mutant: `mutant-dispose-no-wait` breaks `stopMeansStopped` (depth 4).
- Repro `node formal/subagents-lifecycle/repro-f2.mts`:
  - Before (exit 1): `{"stopWaits":true,"oldSessionDisposedBeforeRun":true,"oldSessionModelCalls":12,"launches":2,"newSessionModelCalls":2}`
  - After (exit 0): `{"stopWaits":true,"oldSessionDisposedBeforeRun":false,"oldSessionModelCalls":0,"launches":2,"newSessionModelCalls":2}`
  - The control `--no-message` gives 0 model calls.
- Repro `node formal/subagents-lifecycle/repro-f2.mts --late` (from the
  review): the `before_agent_start` hook waits past `GATE_WAIT_MS`.
  - With `abort` unbounded (exit 0, but the test fails): `{"stopReturnedEarly":false,"oldSessionDisposedBeforeRun":false,"oldSessionModelCalls":0}`.
    The stop and the dispose wait for the hook.
  - Without the gate's agent listener (exit 1): `{"stopReturnedEarly":true,"oldSessionDisposedBeforeRun":true,"oldSessionModelCalls":12}`
  - After (exit 0): `{"stopReturnedEarly":true,"oldSessionDisposedBeforeRun":true,"oldSessionModelCalls":0,"launches":2,"newSessionModelCalls":2}`

### F3. A second stop of a child that a message relaunched during the first stop was refused

Path at f194608:

1. A stop waits for the abort of a running child. The child is in `ending`.
2. Main messages the child. Routing relaunches it, and it runs again.
3. A second stop returns `undefined` at once, because the child is still in
   `ending` (team.ts:400 at f194608). `/subagents stop` says that the child
   "has already ended". The child runs to the end of its run.

- Model change: `stop` refuses only a child that is not live and not
  interrupted. `ending` is now a map from the child to the launch number of
  the stop that owns the mark.
- Code change: `team.ts` `stop` (line 405) no longer refuses a child in
  `ending`. A child that a stop still aborts is `stopped`, which is not live,
  so the second stop of the same run still ends there. A child that a
  message relaunched works, and the stop goes on.
- Mutant: `mutant-stop-refuses-ending` (the code at f194608) breaks
  `stopHonored` (depth 6).
- Repro `node formal/subagents-lifecycle/repro-f3.mts` (the repro now starts
  the second stop without an await, because a stop that goes on waits for
  its abort):
  - Before (exit 1): `{"stateBeforeSecondStop":"running","secondStopRefused":true,"finalState":"idle","newSessionBashRuns":1}`
  - After (exit 0): `{"stateBeforeSecondStop":"running","secondStopRefused":false,"finalState":"stopped","newSessionBashRuns":0,"reports":[{"name":"kid","state":"stopped"}]}`
  - The control `--no-message` gives one stop and a stopped child.

### F4. An old stop cleared the `ending` and `stoppedByParent` marks of a newer stop

Path at f194608:

1. Stop 1 waits for a slow abort of session 1.
2. A message relaunches the child in session 2, and that run ends idle.
3. A second message starts a run in session 2. Stop 2 starts and waits.
4. Session 1's abort resolves. Stop 1 sees a newer launch number and runs
   `this.ending.delete(name)` and `this.stoppedByParent.delete(name)`.
5. Stop 2 still waits, but `stopping()` is false and `quiet()` is true.
   When stop 2 is by the parent, the parent gets a "stopped" report that it
   must not get.

This task found a third harm of the same set: when stop 1 is by the
parent, the run that the message started (step 2) ends with its report
silenced, because `finish` took any mark as silent.

- Model change: `ending` and `byParent` are maps from the child to the
  launch number of the stop that set them. `stopRest` clears a mark only
  when the mark is its own. `finish` is silent only when the mark is the
  current launch number. `stop` takes `byMain`. The ghost `parentStops` and
  the property `parentStopSilent` check the silence. The model counts in
  `reportsTotal` only the reports that main gets.
- Code change: in `team.ts`, `ending` and `stoppedByParent` are now
  `Map<string, number>`. `stop` sets both to its launch number. The
  relaunch branch deletes a mark only when it is the stop's own
  (`team.ts:426-427`). `finish` is silent only when the mark is the current
  launch number (`team.ts:948-950`).
- Mutants: `mutant-old-stop-clears-ending` breaks `reportOnEnd` (depth 10),
  and `mutant-old-stop-clears-parent-mark` breaks `parentStopSilent` (depth 7).
- Repro `node formal/subagents-lifecycle/repro-f4.mts`:
  - Before (exit 1): `"afterFirstStop":{"stopping":false,"quiet":true,"secondStopInFlight":true}`
  - After (exit 0): `"afterFirstStop":{"stopping":true,"quiet":false,"secondStopInFlight":true}`
- Repro `node formal/subagents-lifecycle/repro-f4-byparent.mts`:
  - Before (exit 1): `"reports":[{"name":"kid","state":"idle"},{"name":"kid","state":"stopped"}],"stoppedReports":1`
  - After (exit 0): `"reports":[{"name":"kid","state":"idle"}],"stoppedReports":0`
  - The control `--alone` (one stop by main) gives no report.

### F5. A message steered while the child's input handler waited was lost

Path at f194608:

1. Main sends a message to a running child. `deliver` calls `handle.steer`
   and puts the message on the record's `unread`.
2. Pi's `steer()` awaits the child's `input` handlers before it queues the
   message (P6).
3. The run ends in that time. `late` finds nothing in Pi's queue. `settle`
   clears `unread`, and the parent gets the report.
4. The input handlers end. The message lands in the idle session's queue.
5. The quiet-spell release drops the session and the message with it.

- Model change: the gate constant `PROMPT_WAITS_STEERS`, the prompt phase
  `"steers"` with its outcome `out`, and `promptReturns`. When steers of the
  session are in flight at the end of Pi's prompt, the prompt waits in
  `"steers"`. `steerLands` runs `afterPrompt` when the last steer lands.
  The stop's abort does not wait for this phase: Pi is idle then.
- Code change: the gate's `steer` keeps each steer's promise until Pi queued
  the message. The gate's `prompt`, after Pi's prompt returned, waits while
  any steer is in flight (also one that comes during the wait). With no
  steer in flight it does not await, so the team's continuation keeps its
  place in the event loop. `late` then takes the message from Pi's queue as
  the run's next prompt. The review found the same loss at the end of a
  check (`team.ts:740-743`): a steer that waits in the input handlers while
  the check runs. `work` now awaits `handle.steering()` after the check and
  before `late`. Checks are not in the model; `tests/subagents-check-steer.test.ts`
  covers this path.
- Mutant: `mutant-prompt-skips-steers` breaks `mailKept` (depth 9).
- Repro `node formal/subagents-lifecycle/repro-f5.mts` (the repro no longer
  needs the run to end before the steer lands):
  - Before (exit 1): `"atEnd":{"state":"idle","reports":1},"afterSteerLands":{"queued":true,"inTranscript":false},"afterIdleRelease":{"messageKeptAnywhere":false}`
  - After (exit 0): `"atEnd":{"state":"running","reports":0},"afterSteerLands":{"state":"idle","queued":false,"inTranscript":true},"afterIdleRelease":{"messageKeptAnywhere":true}`
  - The control `--no-hold` gives `messageKeptAnywhere: true`.

### R1. A message in the microtasks between `late()` and `settle()` was lost (fixed)

The task `fix-subagent-mail` fixed this residual (commit `d6e026a`).

- Path: the last `late()` of `work()` finds nothing. `work()` returns to
  `run()`, which calls `settle()` some microtasks later. Main sends a
  message in that gap. The team steers it, because the child still shows
  `running`. `settle()` clears `unread`, and the steer then lands in the
  queue of an idle session. A next run in the held session reads it, but the
  quiet-spell release drops it. A stop in the same gap was also overwritten:
  `settle()` made the stopped child idle.
- Model change: the switch `SETTLE_GAP` (false, as the code is now). True
  puts the prompt in the phase `settling`, and the new action
  `settleAfterGap` settles it later, with no gone check. Two mutants:
  `mutant-late-settle-gap` (all bounds, a path with a stop, depth 9) and
  `mutant-late-settle-gap-no-stop` (no stops: message, settle, steer lands,
  quiet-spell release, depth 9). Both break `mailKept`. `faithful` passes
  as before (494,863 states, depth 29).
- Code change (`team.ts` `run`): after each `await this.work(...)`, run()
  waits for steers in flight (`handle.steering()`), checks `gone()`, and
  takes the queue and the inbox again (`late()`). With mail, the run goes
  on with it as its next prompt. Without mail, `settle()` follows in the
  same synchronous step. Before that prompt, run() does the wrap-up and swap checks that
  work() does before each prompt (commit `88972f9`, from the review of the
  fixes).
- Repro: `tests/subagents-settle-steer.test.ts` runs the real prompt gate
  over a fake session whose steer takes one microtask to queue, as Pi's
  does. It sends the message after a chain of 0 to 9 microtasks.
  - Before (code at `86b79d5`): at depth 3 the run is `idle`, the
    message waits in the session's queue, and `unread` is empty. The test
    fails: `depth 3: nothing waits in the idle session's queue`.
  - After: at each depth the message starts the next prompt, and the run is
    `running`. The test passes.
- The replay misses a revert of this fix (`run-settles-without-late` in
  `code-mutants.py`): the traces of `faithful` have no gap step. The
  regression test catches it.

### Limits of the gate

- A prompt that Pi defers during `agent_settled` (`agent-session.js:1632-1635`)
  returns at once and runs later. The gate does not track it. No team path
  calls `handle.prompt` while a session settles.
- A run that Pi starts on its own (`sendMessage` with `triggerTurn`) is not
  a gate prompt: `busy()` is false for it.
- A steer whose input handler never ends keeps the run waiting. A stop
  still works then, because the gate's abort does not wait for steers.
- The waits before the start are bounded by `GATE_WAIT_MS`; the model has
  no time. A wait that ends early is the case of `survivor-abort-skips-pre`
  (it passes). The bound and the gate's agent listener are checked by
  `tests/subagents-child-prompt.test.ts` (mock timers) and by
  `repro-f2.mts --late`.
- After a dispose that did not wait to the end, Pi's dispose clears the
  session's listeners, also the gate's `compaction_start` listener. A prompt
  that waited in an `input` handler past both bounds (about 20 s) can then
  still run a compaction in `_prepareRun` and send its summary request. The
  run itself stops at `agent_start`. Round 2 of the review found this
  (medium, no repro). A fix would defer Pi's dispose until that prompt
  ended. It is a follow-up (see "Follow-ups").
- After a dispose that did not wait to the end, Pi's `agent_settled` emit
  runs on an invalidated extension runner. The run is stopped before its
  first request; what Pi does with the rest of it is Pi's.

## Review of the model (skill step 9, at f194608)

This review was of the model before the fixes. Names in it (`assume-fixes`,
`faithful-other-properties`, `survivor-stop-twice`) are of that record.
A fresh Opus 5.5 reviewer read each action against the code and Pi, ran the
probe, the repros and the replay, and ran Quint on copies of the model. It
found F5 (high, with a live repro). The model now has it. Other points and
what changed:

- M1 (medium): F4 also clears `stoppedByParent`. Added to F4 with
  `repro-f4-byparent.mts`.
- M2 (medium): F2 fix (b) leaks a session. Added to F2.
- M3 (medium): the traces did not reach a relaunch queued behind a full team
  during a stop, so the replay missed the `state !== "stopped"` half of
  team.ts:419 (the 4a8fa14 fix). The code change
  `stop-relaunch-ignores-state` is now in `code-mutants.py`, and the replay
  catches it. The round-2 review showed that only the random trace 111
  catches it. The witness `witnessNoQueuedRelaunchInStop` reaches the state,
  but its trace ends before the abort resolves. A new trace set can lose
  trace 111. A witness for the state after the abort resolves needs a ghost
  variable, and the record does not have it yet.
- M4 (medium): nothing checked the dispose of a stale launch's session
  (team.ts:670). The replay now compares `stray`, the sessions that are not
  held and not disposed. The code change `open-no-dispose` is in
  `code-mutants.py`.
- Round 2 (a second fresh Opus 5.5 reviewer, on the changes after round 1)
  found no new critical or high issue. It found the two medium points above
  (F5 fix (b), the witness of M3). Low points: `STEER_WINDOW = false` is not
  quite atomic (the await of `_runInputHandlers` takes one microtask even
  with no handlers; all `input` handlers in pi-extras have no await); the
  fake `dispose` clears the queue, which Pi's does not (no effect in scope);
  `steerInbox` (team.ts:583-589) steers with the same window and is out of
  scope.
- Low: `drop` removes every copy of a name, but `slots.remove` removes only
  the first (no path puts a name in line twice); `waiters` covers only the
  first `whenDone`; the goOn insert place (slots.ts:62) is not tested by the
  traces; the replay builds the stop tuples itself.

## Review of the fixes

A fresh Opus 5.5 reviewer read the fix commit against Pi's source, ran the
tests and the repros, and wrote probes. Its findings and what changed:

- H1 (high, with a repro): a steer in flight when a check ends was lost.
  Fixed: `work` awaits `handle.steering()` after the check
  (`tests/subagents-check-steer.test.ts`, which failed first). R1 is
  corrected.
- M1 (medium): the new waits had no time limit, so a stop, a dispose, a
  close or a /reload could hang on a prompt that never left its pre window.
  Fixed: before the run starts, `GATE_WAIT_MS` bounds the gate's wait,
  also the wait in Pi's own abort. After `shut`, the gate's agent listener
  stops an aborted run at `agent_start`. The wait for steers stays
  unbounded (see the limits of the gate): the next prompt waits for the
  same input handlers.
- M2 (medium): a compaction in `_prepareRun` ran after a stop in the pre
  window. Fixed: the gate aborts at `compaction_start`.
- M3 (medium): gate paths with no test (a deferred prompt, runs that Pi
  starts on its own). Written in "Limits of the gate".
- L1 (low): the usage of an aborted request is dropped when a relaunch is
  queued and a second stop follows (`team.ts:664` compares with
  `launches - 1`). Not fixed; a follow-up (see "Follow-ups").
- L2 (low): a stop of a child that `close()` interrupted while an earlier
  stop was in flight now goes on after close and reports once. Not fixed; a
  follow-up.
- L3 (low): wrong citations (`takeQueued`). Fixed.

Round 2 (a fresh Opus 5.5 reviewer, at cb4faf7) found no new critical or
high defect. It found one medium gap with no repro: a compaction after a
dispose whose waits ended (see "Limits of the gate"). The review loop
stops here.

## Follow-ups

The task `fix-subagent-mail` (2026-11-09) took the four open items of the
reviews. R1 fitted this model and is fixed (see R1). These three do not fit
the mail model or this model, so they stay open:

1. Medium, no repro: a compaction after a dispose whose waits ended (see
   "Limits of the gate"). Reason: the model has no compaction and no time,
   so it cannot show the wait that ends early. A fix would defer Pi's
   dispose until that prompt ended. A test needs a fake session with a
   compaction in `_prepareRun` and mock timers.
2. L1, low: the usage of an aborted request is dropped when a relaunch is
   queued and a second stop follows (the `launches - 1` test in `open`'s
   `update`, team.ts). Reason: the model has no usage. A fix would keep the
   launch number of each stop's aborted request, and a unit test with two
   stops can show it.
3. L2, low: a stop of a child that `close()` interrupted goes on after
   close and reports once. Reason: the model leaves out close and the
   /reload hand-over. A fix would end a stop's tail when the team closed.

## Mutants and survivors

Each mutant copies one code change into the model, on top of `faithful`.
The first six copy the code at f194608 (the findings). Each property has at
least one mutant that breaks it.

| Mutant | Copies this code change | Breaks | Replay with the same code change |
|---|---|---|---|
| `mutant-gate-no-reabort` | `child-prompt.ts` `prompt` without the abort at `preflightResult("started")` (F1) | violation of stopMeansStopped | fails (caught) |
| `mutant-dispose-no-wait` | `child.ts` `childDisposer` without `await gate.shut()` before Pi's dispose (F2) | violation of stopMeansStopped | fails (caught) |
| `survivor-abort-skips-pre` | `child-prompt.ts` `abort` that does not wait for the prompt in flight | nothing (survivor) | fails (caught) |
| `mutant-stop-refuses-ending` | `team.ts:405` with `this.ending.has(name)`, as at f194608 (F3) | violation of stopHonored | fails (caught) |
| `mutant-old-stop-clears-ending` | `team.ts:426` deletes `ending` for any stop, as at f194608 (F4) | violation of reportOnEnd | fails (caught), only by the witness `witnessNoStaleStopOverStop` |
| `mutant-old-stop-clears-parent-mark` | `team.ts:427` and `:948-950` with `stoppedByParent` as a set, as at f194608 (F4) | violation of parentStopSilent | fails (caught), only by the witness `witnessNoStaleStopOverStop` |
| `mutant-prompt-skips-steers` | `child-prompt.ts` `prompt` without the wait for steers in flight (F5) | violation of mailKept | fails (caught) |
| `mutant-stop-keeps-launch` | `team.ts:407` and `:417` without the new launch number | violation of oneReport | fails (caught) |
| `mutant-stop-ignores-relaunch` | `team.ts:424` without the check: the stop always finishes after the abort | violation of oneReport | fails (caught) |
| `mutant-work-ignores-gone` | `team.ts:731` without `if (this.gone(name, launch)) return false` | violation of oneReport | fails (caught) |
| `mutant-open-ignores-gone` | `team.ts:675-678` without the gone check: a stale launch holds its session | violation of oneSession | fails (caught) |
| `mutant-stop-keeps-resume` | `team.ts:413` without `this.parkResume(name)` | violation of mailKept | fails (caught) |
| `mutant-stop-drops-unread` | `team.ts:420` without `...this.unreadLeft(name)` | violation of mailKept | fails (caught) |
| `survivor-pump-starts-any` | `slots.ts:89` without the `state !== "queued"` drop | nothing (survivor) | passes (missed) |
| `mutant-resume-ignores-slots` | `team.ts:527` runWhenFree without `this.slots.free()` | violation of slotsBound | fails (caught) |
| `mutant-finish-keeps-waiters` | `team.ts:946` without `this.settleWaiters(name, record)` | violation of waitersSettle | fails (caught) |
| `mutant-release-busy` | `sessions.ts:142` without `this.options.idle(name)` | violation of noStuck | not run: the replay calls the timer body by hand, past this guard |
| `mutant-resume-failed-drops-message` | `team.ts:631` without `this.parkResume(name)` in resumeFailed | violation of mailKept | fails (caught) |
| `mutant-fallback-keeps-session` | `team.ts:847` without `this.sessions.release(name)` in failOrFallBack | violation of oneSession | fails (caught) |
| `mutant-late-skips-queue` | `team.ts:815` without `handle.takeQueued()` | violation of mailKept | fails (caught) |
| `mutant-stop-no-abort` | `team.ts:422` without `await handle?.abort()` | violation of stopMeansStopped | fails (caught) |
| `mutant-settle-skips-finish` | `team.ts:891` without `this.finish(name)` | violation of reportOnEnd | fails (caught) |

The survivors:

- `survivor-abort-skips-pre`: the gate still stops a prompt in its pre
  window at its start, and a dispose waits for it, so no property breaks.
  The wait makes `stop` return only after the prompt ended, as an abort of a
  running loop does. The replay catches the code change, because the stop
  then goes on before the model says.
- `survivor-pump-starts-any`: no path in the model leaves a child in line in
  a state other than `queued`. The guard at `slots.ts:89` is defense in
  depth. The replay also misses this code change.

The F4 mutants are caught only by witness traces of the state after the old
stop went on (`witnessNoStaleStopOverStop`,
`witnessNoStaleStopOverParentStop`). The random traces do not reach it. The
ghosts `staleOverStop` and `staleOverParentStop` exist only for these
witnesses.

## Conformance test

`tests/subagents-lifecycle-conformance.test.mts` replays every trace in
`traces.itf.jsonl.gz` (216 traces from the `faithful` model: 200 random and
16 witnesses) against the real `Team`. After each step it compares the state
of each child, its launch number, place in line, held session, inbox, resume
prompt, unread steering, steers in flight, the `ending` and
`stoppedByParent` marks with their launch numbers, the stops that wait, the
prompts in flight (with their phase and outcome), the reports that main got,
the waiters, the message counts, and `stray` (sessions that are neither held
nor disposed).

The child's handle in the replay runs the real gate (`promptGate`) and the
real `childDisposer` over a fake Pi session. The fake follows the rules P1
to P6: an abort in the pre window is lost, `_startRun` resets Pi's abort
flag, `preflightResult("started")` comes before agent_start, the
agent_start check stops a run while the listener is there, Pi's dispose
takes the listener away, and a steer reaches the queue only at the replay's
`steerLands`. The replay cannot tell whether these rules are true of Pi: the
probe and the repro scripts check them in a real `AgentSession`.

Eight tests replay the witness of each finding's path, so a new trace set
can't drop a path without a failure.

Code changes that make the replay fail (one at a time, each restored):

| Code change | Replay |
|---|---|
| team.ts:407 and :417 no new launch number | fails (caught) |
| team.ts:424 no relaunch check | fails (caught) |
| team.ts:731 no `gone` check | fails (caught) |
| team.ts:675-678 no `gone` check | fails (caught) |
| team.ts:413 no `parkResume` | fails (caught) |
| team.ts:420 no `unreadLeft` | fails (caught) |
| team.ts:527 no `slots.free()` | fails (caught) |
| team.ts:946 no `settleWaiters` | fails (caught) |
| team.ts:631 no `parkResume` | fails (caught) |
| team.ts:847 no `sessions.release` | fails (caught) |
| team.ts:815 no `takeQueued` | fails (caught) |
| team.ts:422 no `abort()` | fails (caught) |
| team.ts:891 no `finish` | fails (caught) |
| team.ts:405 with `this.ending.has(name)` (F3, as at f194608) | fails (caught) |
| team.ts:426 deletes `ending` for any stop (F4) | fails (caught) |
| team.ts:427 and :948-950 `stoppedByParent` as a set (F4) | fails (caught) |
| child-prompt.ts no abort at `"started"` (F1) | fails (caught) |
| child-prompt.ts `abort` without `await run?.ended` | fails (caught) |
| child-prompt.ts without the abort at `compaction_start` (missed: compaction is not modeled; tests/subagents-child-prompt.test.ts catches it) | passes (missed) |
| child.ts `childDisposer` without `gate.shut()` (F2) | fails (caught) |
| child-prompt.ts `abort` without the `GATE_WAIT_MS` bound (missed: the model has no time; tests/subagents-child-prompt.test.ts and repro-f2.mts --late catch it) | passes (missed) |
| child-prompt.ts without the agent_start listener after `shut` (missed: the model has no time; tests/subagents-child-prompt.test.ts and repro-f2.mts --late catch it) | passes (missed) |
| team.ts:740-743 without the wait for steers after the check (missed: checks are not modeled; tests/subagents-check-steer.test.ts catches it) | passes (missed) |
| child-prompt.ts `prompt` without the wait for steers (F5) | fails (caught) |
| slots.ts:89 no `state !== "queued"` drop | passes (missed): no model behavior needs the guard, see survivor-pump-starts-any |
| team.ts:424 without the `state !== "stopped"` half (the 4a8fa14 fix) | fails (caught) |
| team.ts:676 without `await handle.dispose()` for a stale launch | fails (caught) |
| team.ts `run` settling with no new `late()` (R1, `run-settles-without-late`; missed: the traces have no gap step; tests/subagents-settle-steer.test.ts catches it) | passes (missed) |

22 of 28 changes make the replay fail. Each file was restored after its change.

The script is `code-mutants.py` in this folder.

## Regression tests

Each live repro and each finding has a test that failed on the code of
f194608 and passes now:

| Test | Findings | On f194608 |
|---|---|---|
| `tests/subagents-lifecycle-repros-sdk.test.mts` | F1 to F5: runs each repro script and its control with real Pi sessions (about 15 s); `repro-f2.mts --late` (review) | 5 of 5 fail; the `--late` test is new |
| `tests/subagents-stop-relaunch.test.ts` | F3, F4 (both marks, and the silenced report of a relaunched run) on fake sessions | 4 of 4 fail |
| `tests/subagents-child-prompt.test.ts` | F1, F2, F5 on the gate and the disposer, with a fake session; the compaction abort, the `GATE_WAIT_MS` bounds and the agent listener after `shut` (review) | the module did not exist; with the first fix's gate (f597def), 5 of 10 fail: the compaction, the 3 bound and listener tests, and the F5 test, which calls the new `steering()` |
| `tests/subagents-check-steer.test.ts` | F5 at the check boundary (review, high) | fails |
| `tests/subagents-settle-steer.test.ts` | R1 (task `fix-subagent-mail`) | fails on `86b79d5` (depth 3) |
| `tests/subagents-lifecycle-conformance.test.mts` | the replay and the finding paths | the traces of the fixed model fail at the finding steps |

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs check formal/subagents-lifecycle
node skills/formal-verification/scripts/fv.mjs traces formal/subagents-lifecycle
node --test tests/subagents-lifecycle-conformance.test.mts tests/subagents-lifecycle-repros-sdk.test.mts tests/subagents-stop-relaunch.test.ts tests/subagents-child-prompt.test.ts
node formal/subagents-lifecycle/probe-pi-abort.mts input|prepare|dispose|running
node formal/subagents-lifecycle/repro-f1.mts   # also repro-f2 .. repro-f5, repro-f4-byparent; exit 1 while the finding is there
node skills/formal-verification/scripts/fv.mjs drift formal/subagents-lifecycle
python3 formal/subagents-lifecycle/code-mutants.py "$PWD"
```

## Test coverage table

Input for the test-suite-cull task. No test was deleted or changed; the
fix task added the tests at the end of the table. "Covered
by the model" means: the test's scenario is inside the model's bounds, its
assertions are about state that the replay compares, and a mutant that
copies the guard it protects is caught by the replay. "Keeps value" gives
the reason.

| Test file | Test | Guards fix | Covered by | Verdict | Reason |
|---|---|---|---|---|---|
| `subagents-stop.test.ts` | a stop while the child starts, then a message: only the new launch runs, and the old session goes | 16b4817 | `oneSession`, `oneReport`; mutant-open-ignores-gone; replay compares `held` and `opening` | keeps value | it asserts the dispose of the old session (`disposed == [1]`), which the replay checks only as `stray`; stops by main are modeled now |
| `subagents-stop.test.ts` | a message during a stop's abort relaunches the child, and the aborted run does not settle the new one | 16b4817 | `oneReport`, `noStuck`; mutant-work-ignores-gone, mutant-stop-ignores-relaunch | unsure | the stop is by main (silent), so its "0 reports" holds through the silence alone; the replay compares only the reports that main gets |
| `subagents-stop.test.ts` | stopping an interrupted child keeps the report of its last run | a9267ec | stop of an interrupted child is modeled, the report text is not | keeps value | guards a past bug in the report text, which the model leaves out |
| `subagents-stop.test.ts` | a parent that is stopping can't start a subagent that would outlive the stop | bbe26b8 | none | keeps value | spawns by a child are not modeled |
| `subagents-stop.test.ts` | a second stop during a stop, as a budget stop gives, reports the parent once | bbe26b8 | a second stop of a stopped child is refused by the LIVE check (team.ts:405); stop-refuses-ending is caught | keeps value | budget stops and a child parent are not modeled |
| `subagents-stop.test.ts` | the usage of the request a stop aborts reaches the record | bbe26b8 | none | keeps value | usage updates are not modeled |
| `subagents-stop.test.ts` | an agent that fails stops its subagents, and their reports go to main instead of being lost | 2f959df | none | keeps value | grandchildren are not modeled |
| `subagents-stop.test.ts` | the report of a subagent whose parent failed goes to the nearest live ancestor | 2f959df | none | keeps value | grandchildren are not modeled |
| `subagents-stop.test.ts` | stop all and a parent's stop end a held after spawn before what it waits for, so it never launches | 1eb7157 | none | keeps value | `after` and `stopOrder` are not modeled |
| `subagents-stop.test.ts` | stopOrder puts agents that have not started first | 1eb7157 | none | keeps value | a pure function outside the model |
| `subagents-stop.test.ts` | a refused message leaves the target's check as it was; a delivered one sets it | 2918e6f | none | keeps value | checks are not modeled |
| `subagents-stop.test.ts` | a message during a stop's abort that queues a relaunch behind a full team: the stop reports nothing over it | 4a8fa14 | `oneReport`; mutant-stop-ignores-relaunch; the code change `stop-relaunch-ignores-state` is caught by the replay, but only by the random trace 111 (round-2 review) | covered by the model, but the catch is fragile: a new trace set can lose it | |
| `subagents-stop.test.ts` | an aborted run whose prompt ends after a message queued a relaunch behind a full team does not settle over it | f20f490 | `oneReport`, `noStuck`; mutant-stop-keeps-launch (caught by the replay) | covered by the model |  |
| `subagents-stop.test.ts` | a failed parent's queued subagent is stopped, never launched only to be stopped | 389b938 | none | keeps value | grandchildren are not modeled |
| `subagents-stop.test.ts` | an older session's late usage during a later stop does not lower the usage | ed79b8b | none | keeps value | usage updates are not modeled |
| `subagents-lifecycle.test.ts` | its parent stopping a child gets the stopped record back, and no report follows | - | `parentStopSilent` for stops by main; mutant-old-stop-clears-parent-mark | keeps value | it asserts the returned record, and its parent may be a child, which the model leaves out |
| `subagents-lifecycle.test.ts` | the user stopping a child still reports it to main | - | `reportOnEnd`, `oneReport`; the replay counts reports to main | covered by the model |  |
| `subagents-lifecycle.test.ts` | stopping a child that has already ended does nothing | - | the replay runs stops of ended children; no mutant removes the LIVE check | unsure | no mutant shows that the replay catches a stop of an ended child |
| `subagents-lifecycle.test.ts` | a stopped or failed child's session is released at once | - | the replay compares `held`; mutant-fallback-keeps-session | covered by the model |  |
| `subagents-lifecycle.test.ts` | a finished child's session is released after a quiet spell, and a message relaunches it from its file | - | `idleRelease` and the relaunch; the replay calls the timer body by hand | keeps value | the timer itself (sessions.ts:140-145) is not run by the replay |
| `subagents-lifecycle.test.ts` | a message before the quiet spell ends keeps the session and cancels the release | - | none | keeps value | the timer cancel (`keep`) is not replayed |
| `subagents-lifecycle.test.ts` | the four question tests (peer, ends without answering, parent's question, up the tree) | - | none | keeps value | questions are not modeled |
| `subagents-lifecycle.test.ts` | a failed child resumes from its session when its parent messages it, told how the last run ended | - | relaunch of a failed child; the text is not modeled | keeps value | the resume warning text |
| `subagents-lifecycle.test.ts` | a child its parent stopped resumes when the parent messages it again | - | relaunch of a stopped child by main | unsure | the test's parent is a child, not main |
| `subagents-lifecycle.test.ts` | a sibling's note can't resume a failed child; it says who can | - | none | keeps value | messages from peers are not modeled |
| `subagents-lifecycle.test.ts` | the team says a stop is under way until the stopped child's report is handed up | 2cc5b89 | `reportOnEnd`; the replay compares `ending` with its launch numbers; mutant-old-stop-clears-ending | keeps value | the only test that calls `stopping()` itself |
| `subagents-slots.test.ts` | a message to an idle child with a held session waits for a free slot | b0250ee | `slotsBound`; mutant-resume-ignores-slots (caught by the replay) | keeps value | it also asserts `runs == 2` and the prompt text, which the replay does not compare; the slot rule itself is covered (`slotsBound`, mutant-resume-ignores-slots) (review) |
| `subagents-slots.test.ts` | a stop of an agent that waits for a slot keeps its message and ends its wait | b0250ee | `mailKept`; the replay compares `goingOn` and the inbox | covered by the model |  |
| `subagents-slots.test.ts` | the other 13 tests (wait: true, woken parents, askers, bash rests, place in line, activity) | b0250ee, f26726c, 0dd9cb6 | none | keeps value | wait: true, waiting, asking and bash rests are not modeled |
| `subagents-fallback.test.ts` | all 17 tests | 937c27e, 8df55fd, 0bc6246, 0dd9cb6, bd4dca1, 7993713 | fallback to one model, then failure; mutant-fallback-keeps-session | keeps value | they test which errors and which models a fallback takes (fallback.ts), the report text and budgets; the model has one fallback model and one error kind |
| `subagents-durable-inbox.test.ts` | a message steered into a child that fails before reading it reaches its next run | - | `mailKept`: `fail` moves unread mail to the inbox | unsure | the test also checks the saved index, which the model leaves out |
| `subagents-durable-inbox.test.ts` | a run that ends normally keeps nothing it was steered | - | the replay compares unread steering | unsure | the test also checks the saved index |
| `subagents-durable-inbox.test.ts` | the other 4 tests | - | none | keeps value | restart, restore and the index are not modeled |
| `subagents-resume-mail.test.ts` | stopping a child whose relaunch is queued keeps the message in its inbox | d00e37f | `mailKept`; mutant-stop-keeps-resume (caught by the replay) | keeps value | it uses `restore()` and asserts that the resume note is not in the inbox (text), which the model leaves out (review) |
| `subagents-resume-mail.test.ts` | a helper's report to a waiting lead waits in its inbox when the lead's relaunch fails | d00e37f | `mailKept`; mutant-resume-failed-drops-message | unsure | the test goes through a waiting lead and a helper, which are not modeled |
| `subagents-resume-mail.test.ts` | a relaunch reads older inbox mail before the message that started it, after the resume note | 92eee03 | none | keeps value | the model counts messages; it does not check their order |
| `subagents-resume-mail.test.ts` | mail that comes while a relaunch waits in line follows the message that started the relaunch; a parked message keeps its place | 1d8a389 | none | keeps value | mail order is not modeled |
| `subagents-resume-mail.test.ts` | the other 7 tests (close, grandchildren, careful note, spawn group, swap) | d00e37f, 6843f40, 7afe51c, c93ae44, 1d8a389 | none | keeps value | close, grandchildren, note text, groups and swaps are not modeled |
| `subagents-interrupted.test.ts` | all 6 tests | c5ab4ec | stop of an interrupted child only | keeps value | restore and close are not modeled |
| `subagents-stale-session.test.ts` | all 4 tests | - | none | keeps value | stale sessions are not modeled |
| `subagents-team.test.ts` | a child runs its task and reports to main once | - | `oneReport`; the replay counts reports | keeps value | it asserts the name, the prompt text, the report text and `sessionFile`, which the replay does not compare (review) |
| `subagents-team.test.ts` | children beyond maxConcurrent queue and start as slots free up | - | `slotsBound`; the replay compares the line | keeps value | outside the bounds: `maxConcurrent` 2 and 3 children (review) |
| `subagents-team.test.ts` | main steers a running child and resumes a finished one with its context | - | steering and a run in the held session | unsure | it also checks the text that reaches the child |
| `subagents-team.test.ts` | steering that lands as a run ends starts another run instead of being lost | - | `mailKept`; mutant-late-skips-queue (caught by the replay) | covered by the model |  |
| `subagents-team.test.ts` | launch and run failures report as failed | - | `launchFails`, `piEnds` error; the replay compares the state and the reports | keeps value | it asserts the error text, which the replay does not compare (review) |
| `subagents-team.test.ts` | stop aborts the child and its children, and reports it stopped | - | stop of one child | keeps value | children of the child are not modeled |
| `subagents-team.test.ts` | the other 31 tests (report text, questions, answers to main, blocking parents, depth, broadcast, inspector, timing) | e72e55c, d782a83, af2848e, 09cff98, dffc11f, eeb8a58, 83b54c4 | none | keeps value | outside the model |
| `tests/subagents-*.test.* not named here` | all | - | none | keeps value | outside the model: questions, budgets, wrap-ups, swaps, worktrees, tools, checks, rendering, host and reload |
| `subagents-lifecycle-repros-sdk.test.mts` | F1 to F5 (5 tests) | this task | `stopMeansStopped`, `stopHonored`, `reportOnEnd`, `parentStopSilent`, `mailKept` | keeps value | the only tests of the fixes with real Pi sessions |
| `subagents-stop-relaunch.test.ts` | F3, F4 (4 tests) | this task | `stopHonored`, `reportOnEnd`, `parentStopSilent`; the F3 and F4 mutants | covered by the model | fast checks of the same paths; the F4 catch in the replay needs witness traces |
| `subagents-child-prompt.test.ts` | the gate and the disposer (5 tests) | this task | the gate mutants (replay with the real gate) | keeps value | it checks the order of Pi calls, which the replay does not compare |
| `subagents-check-steer.test.ts` | a steer during the check (1 test) | this task | none: checks are not modeled | keeps value | the only test of the wait for steers after a check |
