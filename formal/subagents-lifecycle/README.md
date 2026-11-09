# Subagent run lifecycle: formal verification record

This folder holds a Quint model of how the team starts, runs, stops,
relaunches and falls back a child agent. TLC checks the model. A replay test
runs the model's traces against the real code. Read this file for the
promise, the result, the four findings and the test coverage table.

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

## What the model covers

Each action is one synchronous segment of the code. Each action and helper
cites its file and line in `lifecycle.qnt`.

- `lib/subagents/team.ts`: `spawn` (enqueue and pump), `stop`,
  `goOnWhenFree`, `runWhenFree`, `start`, `open`, `run`, `work`, `gone`,
  `late`, `failOrFallBack`, `resumeFailed`, `settle`, `fail`, `unreadLeft`,
  `parkResume`, `takeInbox`, `finish`.
- `lib/subagents/slots.ts`: `enqueue`, `free`, `goOn`, `remove`, `pump`, `used`.
- `lib/subagents/routing.ts`: `deliver`, `wake`, `relaunch` for messages from main.
- `lib/subagents/sessions.ts`: `hold`, `release`, `ended` and its quiet-spell timer.
- `lib/subagents/resume-prompts.ts`: `set`, `has`, `message`, `take`, `park`.
- `lib/subagents/mailbox.ts`: `unreadToInbox`, `stillUnread`.
- `lib/subagents/child.ts`: the `prompt`, `steer`, `abort`, `takeQueued` and
  `dispose` of `handleFor` (only as the platform side; the replay uses a fake).

### Source files covered (for mutation testing)

- `lib/subagents/team.ts`
- `lib/subagents/slots.ts`
- `lib/subagents/routing.ts` (the `deliver`, `wake` and `relaunch` part)
- `lib/subagents/sessions.ts` (not `runText`: the report text is not modeled)
- `lib/subagents/resume-prompts.ts`
- `lib/subagents/mailbox.ts`

### Platform rules (Pi 1.4.0) and how each was checked

| Rule | Source | Check |
|---|---|---|
| P1. `AgentSession.abort()` before `_startRun` sets `_isAgentRunActive` finds no run. It resolves at once, and the prompt then runs in full. | `agent-session.js:1631-1689` (awaits in `prompt`), `:1971-1989` (`abort`) | `probe-pi-abort.mts input`: the abort resolves, then 2 model calls and 1 bash run follow. |
| P2. An abort during `_prepareRun` (compaction check, `before_agent_start`) waits. The `agent_start` listener then stops the run before the first request. | `:1423-1449`, `:709-713` | `probe-pi-abort.mts prepare`: the abort waits for the hook, and the model gets 0 calls. |
| P3. `dispose()` disconnects that listener. A prompt in `_prepareRun` then runs its loop on the disposed session. Its tools fail ("ctx is stale"). | `:1001-1006`, `:1011-1030` | `probe-pi-abort.mts dispose`: 10 model calls after dispose (the faux model ran out of replies), every tool call failed. |
| P4. `dispose()` calls `agent.abort()`, which stops an active loop. | `:1017`, `agent.js:221-222` | Read in the source only. |
| P5. `waitForIdle` resolves at the end of `_emitAgentSettled`, just before `prompt()` returns, with no macrotask between. So a stop goes on in the same chain as the end of the prompt. | `:683-707`, `:1464-1472` | Read in the source. `repro-f3.mts` and `repro-f4.mts` show a stop that waits for `agent_end` handlers. |
| P6. A steered message waits in the agent queue. The loop reads it at a turn boundary, or `clearQueue` hands it back. | `:1795-1807`, `:1944-1952` | Read in the source. |

## Bounds and what they leave out

- 2 children, `maxConcurrent` 1, 2 messages from main, 2 stops, 1 fallback model.
- Left out: questions and the `asking` state, the `waiting` state and
  grandchildren, `wait: true` parents, budgets and wrap-ups, check rounds,
  turn-boundary swaps (`swap.ts`), bash rests, panels, `after`, close and
  /reload hand-over, restore, stale sessions, and messages from peers and
  the user. The report text (`runText`) is not modeled.
- The quiet-spell timer fires at any time while the child is idle.
- A pass covers only the model within these bounds. It is safety only, not liveness.

## Results

`node skills/formal-verification/scripts/fv.mjs check formal/subagents-lifecycle`

| Check | Expected | Result | States | Depth |
|---|---|---|---|---|
| `faithful` | violates stopMeansStopped | violation of stopMeansStopped | 30 | 3 |
| `faithful-other-properties` | pass | pass | 231,320 | 31 |
| `f2-dispose-in-prep` | violates stopMeansStopped | violation of stopMeansStopped | 122 | 4 |
| `f3-second-stop-refused` | violates stopHonored | violation of stopHonored | 393 | 5 |
| `f4-old-stop-clears-ending` | violates reportOnEnd | violation of reportOnEnd | 20,777 | 11 |
| `assume-fixes` | pass | pass | 87,750 | 23 |
| `mutant-stop-keeps-launch` | violates oneReport | violation of oneReport | 1,095 | 6 |
| `mutant-stop-ignores-relaunch` | violates oneReport | violation of oneReport | 1,028 | 6 |
| `mutant-work-ignores-gone` | violates oneReport | violation of oneReport | 1,595 | 7 |
| `mutant-open-ignores-gone` | violates oneSession | violation of oneSession | 658 | 6 |
| `mutant-stop-keeps-resume` | violates mailKept | violation of mailKept | 158 | 5 |
| `mutant-stop-drops-unread` | violates mailKept | violation of mailKept | 400 | 5 |
| `survivor-pump-starts-any` | pass | pass | 87,750 | 23 |
| `mutant-resume-ignores-slots` | violates slotsBound | violation of slotsBound | 412 | 5 |
| `mutant-finish-keeps-waiters` | violates waitersSettle | violation of waitersSettle | 2 | 2 |
| `survivor-stop-twice` | pass | pass | 87,750 | 23 |
| `mutant-release-busy` | violates noStuck | violation of noStuck | 2,573 | 7 |
| `mutant-resume-failed-drops-message` | violates mailKept | violation of mailKept | 171 | 5 |
| `mutant-fallback-keeps-session` | violates oneSession | violation of oneSession | 638 | 6 |
| `mutant-late-skips-queue` | violates mailKept | violation of mailKept | 1,070 | 6 |
| `mutant-stop-no-abort` | violates stopMeansStopped | violation of stopMeansStopped | 30 | 3 |
| `mutant-settle-skips-finish` | violates reportOnEnd | violation of reportOnEnd | 128 | 4 |
| `mutant-stop-refuses-ending` | violates stopHonored | violation of stopHonored | 393 | 5 |

All 23 checks give the expected result. The checks ran with 1 TLC worker. Six checks first gave `error` because two processes used the Apalache port 8822 at the same time. A rerun with `--only` gave the expected result for each of them.

## Findings

None of these is fixed here. Each one needs its own fix task.

### F1. A stop in the prompt's pre-run window does not stop the prompt

1. A child starts a prompt (`work`, team.ts:712). Pi's `prompt()` awaits an
   `input` handler, an extension command or a login check before it sets
   `_isAgentRunActive` (P1).
2. Main or the user stops the child. `stop` sets the state to `stopped` and
   calls `handle.abort()` (team.ts:415-417).
3. Pi finds no active run. The abort resolves at once.
4. `stop` sees no relaunch and calls `finish` (team.ts:426). The parent gets a
   "stopped" report, and `sessions.ended` releases and disposes the session.
5. Pi's `prompt()` goes on and runs the agent loop on the disposed session
   (P3). It calls the model with no listener. Each tool call fails.

- Harm: model calls that nobody sees or pays attention to, after a stop. Before
  the dispose ends (it awaits `session_shutdown` handlers first), the tools
  still work, so a stopped child can still change files.
- Likelihood: low in pi-extras today. The child's own extensions have only
  synchronous `input` handlers, so the window is microtasks long. It opens
  for a task that starts with `/` (an extension command), a lazy login check,
  or an extension with an async `input` handler. `close()` (a /reload) takes
  the same path: abort, then dispose.
- Live repro: `node formal/subagents-lifecycle/repro-f1.mts` gives
  `{"stopResolvedBeforeTheRun":true,"modelCallsAtStop":0,"modelCallsAfter":12,"disposed":true,"state":"stopped"}`
  (exit 1). The control `--no-stop` gives one normal run with 2 model calls.
- Fix options: (a) In Pi, make `abort()` set a flag that `prompt()` checks
  before `_startRun`. (b) In child.ts, keep an "aborted" flag in the handle
  that `prompt()` checks after `session.prompt` starts, and call
  `session.abort()` again once `isStreaming` is true. (c) In `stop`, after the
  abort resolves, wait until `session.isIdle` holds and no prompt is pending.

### F2. A message during a stop's abort disposes a preparing session, and its loop runs anyway

1. A child's prompt is in `_prepareRun` (a compaction check or a slow
   `before_agent_start` hook).
2. A stop calls `handle.abort()`. Pi records the abort and waits for the
   `agent_start` listener to stop the run (P2). The state is `stopped`.
3. Main messages the child. `deliver` sees an ended child and releases the
   held session (routing.ts:231), then relaunches the child.
4. `release` disposes the session. Dispose disconnects the `agent_start`
   listener (P3).
5. `_prepareRun` ends. The agent loop of the old session starts with no
   listener and calls the model. The stop also keeps waiting for it.

- Harm: as F1, plus the old stop waits for the whole loop, which F4 then uses.
- Likelihood: needs a stop and a message within the prepare window. A
  compaction before the prompt makes the window seconds long.
- Live repro: `node formal/subagents-lifecycle/repro-f2.mts` gives
  `{"stopWaits":true,"oldSessionDisposedBeforeRun":true,"oldSessionModelCalls":12,"launches":2,"newSessionModelCalls":2}`
  (exit 1). The control `--no-message` gives 0 model calls.
- Fix options: (a) In Pi, let `dispose()` set `_agentRunAbortRequested` and
  have `_startRun` check it before `agent.prompt`. (b) In routing.ts, do not
  release the session of a child that is in `ending`. Let the stop's own
  `finish` release it.

### F3. A second stop of a child that a message relaunched during the first stop is refused

1. A stop waits for the abort of a running child (team.ts:417). The child is in `ending`.
2. Main messages the child. Routing relaunches it, and it starts and runs again.
3. Main or the user stops it again. `stop` returns `undefined` at once
   (team.ts:400), because the child is still in `ending`.
4. `/subagents stop` tells the user "has already ended; there is nothing to
   stop" (extensions/subagents.ts:448). The child runs to the end of its run.

- Harm: a stop does nothing for a child that works.
- Likelihood: needs a slow abort (an `agent_end` or `agent_settled` handler
  that awaits I/O, or a tool that is slow to abort) and a message in that time.
- Live repro: `node formal/subagents-lifecycle/repro-f3.mts` gives
  `{"stateBeforeSecondStop":"running","secondStopRefused":true,"finalState":"idle","newSessionBashRuns":1}`
  (exit 1). The control `--no-message` gives one stop and a stopped child.
- Fix options: refuse only when the child is in `ending` and its state is
  still `stopped`. That alone is not enough: see F4. The check
  `assume-fixes` uses both changes.

### F4. An old stop clears the `ending` mark of a newer stop

1. Stop 1 waits for a slow abort of session 1 (as in F3, or the loop of F2).
2. A message relaunches the child in session 2, and that run ends idle.
   `finish` deletes `ending` (team.ts:912).
3. A second message starts a run in session 2. Stop 2 starts: it adds the
   child to `ending` and waits for session 2's abort.
4. Session 1's abort resolves. Stop 1 sees a newer launch number and runs
   `this.ending.delete(name)` (team.ts:420).
5. Stop 2 still waits, but the child is not in `ending`. `stopping()` is
   false and `quiet()` is true.

- Harm: a headless run that waits on `stopping()` (2cc5b89) can exit before
  stop 2 hands its report up, and a host that checks `quiet()` before a
  hand-over sees no work in flight.
- Live repro: `node formal/subagents-lifecycle/repro-f4.mts` gives
  `{"afterFirstStop":{"stopping":false,"quiet":true,"secondStopInFlight":true}}` (exit 1).
- Fix options: keep the launch number of the stop that owns `ending` (a map
  from name to launch), and let a stop delete the mark only when it owns it.
  `finish` must then delete it only for the owning stop or a run of the same
  launch.

## Mutants and survivors

Each mutant copies one code change into the model, on top of `assume-fixes`.

| Mutant | Copies this code change | Breaks | Replay with the same code change |
|---|---|---|---|
| `mutant-stop-keeps-launch` | `lib/subagents/team.ts:411-412` without the new launch number: `const launch = this.launches.get(name) ?? 0` and no `launches.set` | violation of oneReport | fails (caught) |
| `mutant-stop-ignores-relaunch` | `lib/subagents/team.ts:419` without the check: the stop always finishes after the abort | violation of oneReport | fails (caught) |
| `mutant-work-ignores-gone` | `lib/subagents/team.ts:713` without `if (this.gone(name, launch)) return false` | violation of oneReport | fails (caught) |
| `mutant-open-ignores-gone` | `lib/subagents/team.ts:669-672` without the gone check: a stale launch holds its session | violation of oneSession | fails (caught) |
| `mutant-stop-keeps-resume` | `lib/subagents/team.ts:406` without `this.parkResume(name)` | violation of mailKept | fails (caught) |
| `mutant-stop-drops-unread` | `lib/subagents/team.ts:415` without `...this.unreadLeft(name)` | violation of mailKept | fails (caught) |
| `survivor-pump-starts-any` | `lib/subagents/slots.ts:89` without the `state !== "queued"` drop | nothing (survivor) | passes (missed) |
| `mutant-resume-ignores-slots` | `lib/subagents/team.ts:521` runWhenFree without `this.slots.free()`: a message to an idle child runs it at once | violation of slotsBound | fails (caught) |
| `mutant-finish-keeps-waiters` | `lib/subagents/team.ts:925` without `this.settleWaiters(name, record)` | violation of waitersSettle | fails (caught) |
| `survivor-stop-twice` | `lib/subagents/team.ts:400` without `this.ending.has(name)`, on the fixed model | nothing (survivor) | fails (caught): the replay uses `faithful` traces, where the guard matters |
| `mutant-release-busy` | `lib/subagents/sessions.ts:142` without `this.options.idle(name)`: the quiet-spell timer releases a child that a message woke | violation of noStuck | not run: the replay calls the timer body by hand, past this guard |
| `mutant-resume-failed-drops-message` | `lib/subagents/team.ts:625` without `this.parkResume(name)` in resumeFailed | violation of mailKept | fails (caught) |
| `mutant-fallback-keeps-session` | `lib/subagents/team.ts:826` without `this.sessions.release(name)` in failOrFallBack | violation of oneSession | fails (caught) |
| `mutant-late-skips-queue` | `lib/subagents/team.ts:794` without `handle.takeQueued()`: steering that came too late stays in the Pi queue | violation of mailKept | fails (caught) |
| `mutant-stop-no-abort` | `lib/subagents/team.ts:417` without `await handle?.abort()` | violation of stopMeansStopped | fails (caught) |
| `mutant-settle-skips-finish` | `lib/subagents/team.ts:870` without `this.finish(name)`: the run ends idle and hands no report up | violation of reportOnEnd | fails (caught) |
| `mutant-stop-refuses-ending` | `lib/subagents/team.ts:400` as it is at HEAD (`this.ending.has(name)` refuses), on the model with the Pi fixes | violation of stopHonored | no code change: this is the code at HEAD |

The survivors:

- `survivor-pump-starts-any`: no path in the model leaves a child in line in a state other than `queued`. The guard at `slots.ts:89` is defense in depth. The replay also misses this code change.
- `survivor-stop-twice`: with the fix of F3, the LIVE check refuses a stopped child, so `ending.has` adds nothing. At HEAD the guard is the cause of F3 (`mutant-stop-refuses-ending`).

## Conformance test

`tests/subagents-lifecycle-conformance.test.mts` replays every trace in
`traces.itf.jsonl.gz` (210 traces from the `faithful` model: 200 random and
10 witnesses, 2,400 steps) against the real `Team`. After each step it
compares the state of each child, its launch number, place in line, held
session, inbox, resume prompt, unread steering, the stops that wait, the
prompts in flight, the reports, the waiters and the message counts.

The fake Pi session follows the rules P1 to P6. The replay cannot tell
whether these rules are true of Pi: the probe and the repro scripts check
them in a real `AgentSession`.

Code changes that make the replay fail (one at a time, each restored, `git
diff` clean after):

| Code change | Replay |
|---|---|
| team.ts:411-412 no new launch number | fails (caught) |
| team.ts:419 no relaunch check | fails (caught) |
| team.ts:713 no `gone` check | fails (caught) |
| team.ts:669-672 no `gone` check | fails (caught) |
| team.ts:406 no `parkResume` | fails (caught) |
| team.ts:415 no `unreadLeft` | fails (caught) |
| team.ts:521 no `slots.free()` | fails (caught) |
| team.ts:925 no `settleWaiters` | fails (caught) |
| team.ts:625 no `parkResume` | fails (caught) |
| team.ts:826 no `sessions.release` | fails (caught) |
| team.ts:794 no `takeQueued` | fails (caught) |
| team.ts:417 no `abort()` | fails (caught) |
| team.ts:870 no `finish` | fails (caught) |
| team.ts:400 no `ending.has` | fails (caught) |
| slots.ts:89 no `state !== "queued"` drop | passes (missed): no model behavior needs the guard, see survivor-pump-starts-any |

14 of 15 changes make the replay fail. The script is `code-mutants.py` in this folder.

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs check formal/subagents-lifecycle
node skills/formal-verification/scripts/fv.mjs traces formal/subagents-lifecycle
node --test tests/subagents-lifecycle-conformance.test.mts
node formal/subagents-lifecycle/probe-pi-abort.mts input|prepare|dispose|running
node formal/subagents-lifecycle/repro-f1.mts   # also repro-f2, repro-f3, repro-f4
node skills/formal-verification/scripts/fv.mjs drift formal/subagents-lifecycle
python3 formal/subagents-lifecycle/code-mutants.py "$PWD"
```

## Test coverage table

Input for the test-suite-cull task. No test was deleted or changed. "Covered
by the model" means: the test's scenario is inside the model's bounds, its
assertions are about state that the replay compares, and a mutant that
copies the guard it protects is caught by the replay. "Keeps value" gives
the reason.

| Test file | Test | Guards fix | Covered by | Verdict | Reason |
|---|---|---|---|---|---|
| `subagents-stop.test.ts` | a stop while the child starts, then a message: only the new launch runs, and the old session goes | 16b4817 | `oneSession`, `oneReport`; mutant-open-ignores-gone; replay compares `held` and `opening` | covered by the model |  |
| `subagents-stop.test.ts` | a message during a stop's abort relaunches the child, and the aborted run does not settle the new one | 16b4817 | `oneReport`, `noStuck`; mutant-work-ignores-gone, mutant-stop-ignores-relaunch | covered by the model |  |
| `subagents-stop.test.ts` | stopping an interrupted child keeps the report of its last run | a9267ec | stop of an interrupted child is modeled, the report text is not | keeps value | guards a past bug in the report text, which the model leaves out |
| `subagents-stop.test.ts` | a parent that is stopping can't start a subagent that would outlive the stop | bbe26b8 | none | keeps value | spawns by a child are not modeled |
| `subagents-stop.test.ts` | a second stop during a stop, as a budget stop gives, reports the parent once | bbe26b8 | survivor-stop-twice | keeps value | budget stops and a child parent are not modeled |
| `subagents-stop.test.ts` | the usage of the request a stop aborts reaches the record | bbe26b8 | none | keeps value | usage updates are not modeled |
| `subagents-stop.test.ts` | an agent that fails stops its subagents, and their reports go to main instead of being lost | 2f959df | none | keeps value | grandchildren are not modeled |
| `subagents-stop.test.ts` | the report of a subagent whose parent failed goes to the nearest live ancestor | 2f959df | none | keeps value | grandchildren are not modeled |
| `subagents-stop.test.ts` | stop all and a parent's stop end a held after spawn before what it waits for, so it never launches | 1eb7157 | none | keeps value | `after` and `stopOrder` are not modeled |
| `subagents-stop.test.ts` | stopOrder puts agents that have not started first | 1eb7157 | none | keeps value | a pure function outside the model |
| `subagents-stop.test.ts` | a refused message leaves the target's check as it was; a delivered one sets it | 2918e6f | none | keeps value | checks are not modeled |
| `subagents-stop.test.ts` | a message during a stop's abort that queues a relaunch behind a full team: the stop reports nothing over it | 4a8fa14 | `oneReport`; mutant-stop-ignores-relaunch (caught by the replay) | covered by the model |  |
| `subagents-stop.test.ts` | an aborted run whose prompt ends after a message queued a relaunch behind a full team does not settle over it | f20f490 | `oneReport`, `noStuck`; mutant-stop-keeps-launch (caught by the replay) | covered by the model |  |
| `subagents-stop.test.ts` | a failed parent's queued subagent is stopped, never launched only to be stopped | 389b938 | none | keeps value | grandchildren are not modeled |
| `subagents-stop.test.ts` | an older session's late usage during a later stop does not lower the usage | ed79b8b | none | keeps value | usage updates are not modeled |
| `subagents-lifecycle.test.ts` | its parent stopping a child gets the stopped record back, and no report follows | - | none | keeps value | a silent stop by the parent (`stoppedByParent`) is not modeled |
| `subagents-lifecycle.test.ts` | the user stopping a child still reports it to main | - | `reportOnEnd`, `oneReport`; the replay counts reports to main | covered by the model |  |
| `subagents-lifecycle.test.ts` | stopping a child that has already ended does nothing | - | the replay runs stops of ended children; no mutant removes the LIVE check | unsure | no mutant shows that the replay catches a stop of an ended child |
| `subagents-lifecycle.test.ts` | a stopped or failed child's session is released at once | - | the replay compares `held`; mutant-fallback-keeps-session | covered by the model |  |
| `subagents-lifecycle.test.ts` | a finished child's session is released after a quiet spell, and a message relaunches it from its file | - | `idleRelease` and the relaunch; the replay calls the timer body by hand | keeps value | the timer itself (sessions.ts:140-145) is not run by the replay |
| `subagents-lifecycle.test.ts` | a message before the quiet spell ends keeps the session and cancels the release | - | none | keeps value | the timer cancel (`keep`) is not replayed |
| `subagents-lifecycle.test.ts` | the four question tests (peer, ends without answering, parent's question, up the tree) | - | none | keeps value | questions are not modeled |
| `subagents-lifecycle.test.ts` | a failed child resumes from its session when its parent messages it, told how the last run ended | - | relaunch of a failed child; the text is not modeled | keeps value | the resume warning text |
| `subagents-lifecycle.test.ts` | a child its parent stopped resumes when the parent messages it again | - | relaunch of a stopped child by main | unsure | the test's parent is a child, not main |
| `subagents-lifecycle.test.ts` | a sibling's note can't resume a failed child; it says who can | - | none | keeps value | messages from peers are not modeled |
| `subagents-lifecycle.test.ts` | the team says a stop is under way until the stopped child's report is handed up | 2cc5b89 | `reportOnEnd` (F4 breaks it) | keeps value | guards a past real bug; the replay does not compare `stopping()` |
| `subagents-slots.test.ts` | a message to an idle child with a held session waits for a free slot | b0250ee | `slotsBound`; mutant-resume-ignores-slots (caught by the replay) | covered by the model |  |
| `subagents-slots.test.ts` | a stop of an agent that waits for a slot keeps its message and ends its wait | b0250ee | `mailKept`; the replay compares `goingOn` and the inbox | covered by the model |  |
| `subagents-slots.test.ts` | the other 13 tests (wait: true, woken parents, askers, bash rests, place in line, activity) | b0250ee, f26726c, 0dd9cb6 | none | keeps value | wait: true, waiting, asking and bash rests are not modeled |
| `subagents-fallback.test.ts` | all 17 tests | 937c27e, 8df55fd, 0bc6246, 0dd9cb6, bd4dca1, 7993713 | fallback to one model, then failure; mutant-fallback-keeps-session | keeps value | they test which errors and which models a fallback takes (fallback.ts), the report text and budgets; the model has one fallback model and one error kind |
| `subagents-durable-inbox.test.ts` | a message steered into a child that fails before reading it reaches its next run | - | `mailKept`: `fail` moves unread mail to the inbox | unsure | the test also checks the saved index, which the model leaves out |
| `subagents-durable-inbox.test.ts` | a run that ends normally keeps nothing it was steered | - | the replay compares unread steering | unsure | the test also checks the saved index |
| `subagents-durable-inbox.test.ts` | the other 4 tests | - | none | keeps value | restart, restore and the index are not modeled |
| `subagents-resume-mail.test.ts` | stopping a child whose relaunch is queued keeps the message in its inbox | d00e37f | `mailKept`; mutant-stop-keeps-resume (caught by the replay) | covered by the model |  |
| `subagents-resume-mail.test.ts` | a helper's report to a waiting lead waits in its inbox when the lead's relaunch fails | d00e37f | `mailKept`; mutant-resume-failed-drops-message | unsure | the test goes through a waiting lead and a helper, which are not modeled |
| `subagents-resume-mail.test.ts` | a relaunch reads older inbox mail before the message that started it, after the resume note | 92eee03 | none | keeps value | the model counts messages; it does not check their order |
| `subagents-resume-mail.test.ts` | mail that comes while a relaunch waits in line follows the message that started the relaunch; a parked message keeps its place | 1d8a389 | none | keeps value | mail order is not modeled |
| `subagents-resume-mail.test.ts` | the other 7 tests (close, grandchildren, careful note, spawn group, swap) | d00e37f, 6843f40, 7afe51c, c93ae44, 1d8a389 | none | keeps value | close, grandchildren, note text, groups and swaps are not modeled |
| `subagents-interrupted.test.ts` | all 6 tests | c5ab4ec | stop of an interrupted child only | keeps value | restore and close are not modeled |
| `subagents-stale-session.test.ts` | all 4 tests | - | none | keeps value | stale sessions are not modeled |
| `subagents-team.test.ts` | a child runs its task and reports to main once | - | `oneReport`; the replay counts reports | covered by the model |  |
| `subagents-team.test.ts` | children beyond maxConcurrent queue and start as slots free up | - | `slotsBound`; the replay compares the line | covered by the model |  |
| `subagents-team.test.ts` | main steers a running child and resumes a finished one with its context | - | steering and a run in the held session | unsure | it also checks the text that reaches the child |
| `subagents-team.test.ts` | steering that lands as a run ends starts another run instead of being lost | - | `mailKept`; mutant-late-skips-queue (caught by the replay) | covered by the model |  |
| `subagents-team.test.ts` | launch and run failures report as failed | - | `launchFails`, `piEnds` error; the replay compares the state and the reports | covered by the model |  |
| `subagents-team.test.ts` | stop aborts the child and its children, and reports it stopped | - | stop of one child | keeps value | children of the child are not modeled |
| `subagents-team.test.ts` | the other 31 tests (report text, questions, answers to main, blocking parents, depth, broadcast, inspector, timing) | e72e55c, d782a83, af2848e, 09cff98, dffc11f, eeb8a58, 83b54c4 | none | keeps value | outside the model |
| `tests/subagents-*.test.* not named here` | all | - | none | keeps value | outside the model: questions, budgets, wrap-ups, swaps, worktrees, tools, checks, rendering, host and reload |
