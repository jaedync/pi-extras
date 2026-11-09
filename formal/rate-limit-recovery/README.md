# Rate-limit recovery: formal model

This folder holds a Quint model of the wait machines of Rate-limit Recovery,
the TLC results, a conformance replay against the real code, and live repro
scripts for four findings. The model describes the code at commit `343e195`
(`syncCommit` in `fv.json`).

## The promise

After a failed request (a quota limit, a short rate limit, or a local server
that does not answer), the controller:

1. Runs one wait at a time.
2. Resumes the run one time for each failure, and only for the failure of this
   session that nothing else carried on. It does not resume after the user
   started a new run, after another run took over, after a cancel or an Esc,
   or after a switch out of the limit's scope.
3. Stays within its attempt and wait budgets.
4. Leaves no wait and no `ready` flag that a later, unrelated run consumes.

A model switch during a short-rate-limit wait or a local idle wait ends the
wait and resumes at once with the new model. The code does this on purpose
(`controller.ts:134-140`, "Switching away from a limited model is a request to
go on with the new one now"). The model counts that resume as the one resume
of the failure.

**Harm when the promise breaks:** a run starts or a "continue the task" message
arrives when the user did not ask for it. The model then repeats or continues
work in a session where the task already went on.

## Why this target

The controller joins three wait machines (quota hibernation, the in-run
transient backoff, and the local idle wait). Each has its own `pending`,
`active` and `ready` state. About eight Pi events change them. The resume
decision ORs two `ready` flags. The local idle wait runs outside the run, so
other runs, reloads and forks can happen during it. Six `fix:` commits on these
files changed the order of these events (`e4c71a8`, `b96bac5`, `c9279cb`,
`69ac5c0`, `72d7077`, `47c2b3b`). Example tests check the orders that someone
wrote. TLC checks all of them within the bounds.

## The tool

Quint with TLC (`fv.mjs check`). The question is about the order of events in
async code, so a model checker of a state machine is the right tool. The
values are small (counts up to 4), so TLC has no state explosion.

## Properties

| Invariant | Statement |
|---|---|
| `oneWait` | At most one of the hibernation, the transient wait and the idle wait is active. |
| `resumeOwed` | Each resume (an `agent_before_settle` continue, or the idle wait's resume message) is for a failure that is still owed: no later request, new run, cancel, abort or fork came first. |
| `withinBudgets` | Hibernation attempts and wait time, and the short-rate-limit streak, stay within their limits. |
| `openEntryHasWait` | An open local-wait entry on the branch always has a live idle wait behind it. |

The ghost variable `owed` holds "a failure of this session waits for its one
resume". A wait start sets it. A resume, a new request (`context`), a new run
that the user or another extension starts, a cancel, an Esc and a fork clear it.

## What the model covers

Each action is one synchronous segment of the code, with a file:line comment.

- `lib/rate-limit-recovery/controller.ts`: the `context`, `model_select`,
  `before_agent_start`, `session_start` and `session_shutdown` handlers,
  `messageEnd`, `cancel`, `hibernate`, `turnEnd`, `beforeSettle`, the `cancel`
  command, `restoreIdleWait`.
- `lib/rate-limit-recovery/transient.ts`: `TransientBackoff` (`resume`, `reset`,
  `cancel`, `skip`, `messageEnd`, `turnEnd`, `handedToIdle`, `consumeReady`).
- `lib/rate-limit-recovery/idle-wait.ts`: `LocalIdleWait` (`start`, `restore`,
  `yieldToRun`, `cancel`, `skip`, `stop`, `run`) and its open and closed entries.
- `lib/rate-limit-recovery/wait.ts`: the cancel keys of `waitUI`.
- `lib/rate-limit-recovery/core.ts`: the attempt and budget refusals of `planWait`.
- `lib/rate-limit-recovery/local.ts`: only the end values of `waitUntilAnswering`.
- Pi 1.4.0: the run loop (`agent-loop.js`, `agent.js`), `AgentSession`
  (`_startRun`, `_handlePostAgentRun`, `_runBeforeSettleBoundary`,
  `sendCustomMessage`, `prompt`, `abort`, `reload`, `navigateTree`),
  `AgentSessionRuntime.fork`, `newSession` and `switchSession`, and the TUI's
  Esc, `/reload`, `/clone`, `/resume` and `/tree` handlers.

The error classification is not modeled. Each failed request picks one kind:
`ok`, `quota`, `cloud` (a short rate limit), `local` (a local server that does
not answer), or `other`.

### Source files covered

For a mutation-testing tool such as Stryker:

- `lib/rate-limit-recovery/controller.ts`
- `lib/rate-limit-recovery/transient.ts`
- `lib/rate-limit-recovery/idle-wait.ts`
- `lib/rate-limit-recovery/wait.ts`
- `lib/rate-limit-recovery/core.ts` (`planWait` only)
- `lib/rate-limit-recovery/local.ts` (`waitUntilAnswering` only)
- `extensions/rate-limit-recovery.ts`

## Bounds and what they leave out

Bounds: 3 model requests, 2 user prompts or extension messages, 1 model switch,
1 Esc or cancel command, 1 `/reload`, 1 `/clone`, and 1 navigation (a
return to the session through `session_start(resume)`, or a `/tree` while idle). Quota waits: at most 2 per
run (`maxRecoveries`) and a budget of 2 waits. Short-rate-limit streak: 2 waits.
The check `assume-fix-wide` uses 4 requests and 3 inputs.

The model leaves out:

- Larger counts. A pass covers only these bounds.
- The rule `MAX_FAILURES_AFTER_ANSWER` (3 failures in a row while the server
  answers). It needs 4 local failures, more than 3 requests.
- The connection streak and the proxy streak of `TransientBackoff` (only the
  rate-limit streak is in the model), the hint from `Retry-After`, the outage
  clock and `localStreak`.
- Virtual models and routed scopes (`inScope` is "the selected model is
  anthropic"), the transport guard, `cache_warming_decision`, the config
  commands `on` and `off`.
- Subagents, print mode, RPC mode: the model is an interactive TUI main session.
- The 48 h age limit after a reload: the model assumes that the entry is young
  enough. The 10 min limit after a return to the session is in the model
  (`leave(late)`).
- A failure inside the wait UI or in `appendEntry`.
- Pi's one-at-a-time steering mode: the model lets one request take all
  queued messages. With one-at-a-time, extra messages go to later requests of
  the same run.
- A process restart (`pi --continue`) is `leave` (reason `startup` has the
  same code path as `resume`, `controller.ts:158`).
- `/fork` from an earlier message, and `/clone` while a run is active (the
  fork aborts the run first, `agent-session-runtime.js:102-105`).
- The window in `_prepareRun` before `before_agent_start` (a compaction
  before the prompt, `agent-session.js:1424-1488`). The model makes the run
  start and our handler one step. See "Review (skill step 9)".
- Liveness. The model checks only safety.

## Results

`node skills/formal-verification/scripts/fv.mjs check formal/rate-limit-recovery --workers 1`

| Check | Expected | Result | States |
|---|---|---|---|
| faithful | violates resumeOwed | violation of resumeOwed | 3936 |
| faithful-one-wait | violates oneWait | violation of oneWait | 7000 |
| faithful-open-entry | violates openEntryHasWait | violation of openEntryHasWait | 2136 |
| f1-clone-reload | violates resumeOwed | violation of resumeOwed | 7440 |
| f2-run-continues | violates resumeOwed | violation of resumeOwed | 3936 |
| f2-run-continues-one-wait | violates oneWait | violation of oneWait | 6980 |
| f2-no-steer | violates resumeOwed | violation of resumeOwed | 2089 |
| f3-late-return | violates resumeOwed | violation of resumeOwed | 7457 |
| f4-tree-away | violates resumeOwed | violation of resumeOwed | 4267 |
| assume-fix | pass | pass | 255030 |
| assume-fix-wide | pass | pass | 1357134 |
| assume-fix-no-other-continue | pass | pass | 160636 |
| mutant-user-run-keeps-idle-wait | violates resumeOwed | violation of resumeOwed | - |
| mutant-carried-run-keeps-idle-wait | violates resumeOwed | violation of resumeOwed | 4239 |
| mutant-cancel-keeps-entry-open | violates openEntryHasWait | violation of openEntryHasWait | 2131 |
| mutant-ready-survives-new-run | violates resumeOwed | violation of resumeOwed | 15484 |
| survivor-context-keeps-ready | pass | pass | 255894 |
| survivor-start-keeps-ready | pass | pass | 255414 |
| survivor-message-end-keeps-ready | pass | pass | 255030 |
| mutant-no-attempt-cap | violates withinBudgets | violation of withinBudgets | 78926 |
| mutant-no-wait-budget | violates withinBudgets | violation of withinBudgets | 98455 |
| mutant-no-streak-budget | violates withinBudgets | violation of withinBudgets | 98691 |
| survivor-transient-wait-ignores-abort | pass | pass | 269390 |
| survivor-model-switch-keeps-hibernation | pass | pass | 294722 |
| mutant-model-switch-resumes-out-of-scope | violates resumeOwed | violation of resumeOwed | 2048 |

All 25 checks give the expected result. Three checks first gave `error`
because two processes used the Apalache port 8822 at the same time. A rerun
with `--only` gave the expected result for each of them. (The states of
`mutant-user-run-keeps-idle-wait` come from a rerun with `--trace`, which does
not print the count.) `assume-fix` assumes all four fixes
(`CONTEXT_ENDS_IDLE_WAIT`, `FORK_CLOSES_ENTRY`, `START_CLOSES_STALE_ENTRY`
and `TREE_ENDS_IDLE_WAIT`). Under those fixes, all four properties hold.

## Findings

All four findings have a live repro in Pi's real `AgentSession`. The repros fake
only the model (a faux provider at `http://localhost:0`), the server check and
the timers.

### F1: a /clone during an idle wait starts a run on its own after a /reload in the clone

Steps (`f1-clone-reload`, 9 steps):

1. The user sends a prompt. The request to the local server fails with
   `Connection error.`
2. `TransientBackoff.turnEnd` hands the wait to `LocalIdleWait.start`. It writes
   an open `local-wait` entry (`idle-wait.ts:97-103`). The run ends.
3. The user runs `/clone`. Pi copies the whole branch, with the open entry, into
   a new session (`agent-session-runtime.js:174-235`,
   `session-manager.js:1205-1237`).
4. The new session gets `session_start` with reason `fork`. The controller does
   not restore the wait (`controller.ts:157-158`). The open entry stays on the
   clone's branch with no wait behind it.
5. The user works in the clone. No new `local-wait` entry is written, so the
   copied open entry stays the last one.
6. Within 48 h, the user runs `/reload` in the clone. `session_start` with
   reason `reload` calls `restoreIdleWait`. `openWait` finds the copied open
   entry, and `LocalIdleWait.restore` starts a wait (`controller.ts:168-180`).
7. The server answers. `run` sends "The local model server ... answers again.
   Continue the task from where it stopped." with `triggerTurn: true`. A run
   starts in the clone that nobody asked for.

Harm: an unrequested run in a session where the user does other work. The
model continues the old task of the first session there.

Live repro:

```
$ node formal/rate-limit-recovery/repro-f1.mts
{ "clone": true, "localWaitEntriesAfterFailure": ["open"], "localWaitEntriesBeforeReload": ["open"],
  "modelCallsBeforeReload": 2, "modelCallsAfterReload": 3, "runsStartedOnTheirOwn": 1,
  "resumeMessages": 1, "lastReply": "I continue the old task.", "extensionErrors": 0 }   (exit 1)
$ node formal/rate-limit-recovery/repro-f1.mts --no-clone
{ "clone": false, "localWaitEntriesBeforeReload": ["open", "closed"], "modelCallsBeforeReload": 2,
  "modelCallsAfterReload": 2, "runsStartedOnTheirOwn": 0, "resumeMessages": 0, ... }   (exit 0)
```

Fix options:

1. At `session_start` with reason `fork` or `new`, write a closed entry when the
   last `local-wait` entry on the branch is open. This is `FORK_CLOSES_ENTRY` in
   the model.
2. Put the session id in the entry, and restore only an entry of the same session.
3. Restore only an entry that this process or the process before it suspended
   (the `stop(true)` record), not the first open entry of `start`.

### F2: a message that steers into the failing run leaves the idle wait running, and it resumes a second time

Steps (`faithful`, 9 steps):

1. The user sends a prompt. The request to the local server is in flight.
2. The user types a second message, or a shell job report arrives. Pi queues it
   as a steer, because a run is active (`interactive-mode.js:2676-2681`,
   `agent-session.js:1857-1862`).
3. The request fails with `Connection error.` The idle wait starts, and the
   failed reply leaves the context.
4. After `agent_end`, Pi sees the queued message and continues the same run with
   `agent.continue()` (`agent-session.js:1440-1456`, `:1531-1561`). No
   `before_agent_start` fires, so `controller.ts:142-153` does not end the idle
   wait.
5. The continued request reaches the server and succeeds. The task goes on.
6. The idle wait's check answers. It sends its resume message with
   `triggerTurn: true` (`idle-wait.ts:172-178`). If the run still streams, the
   message steers into it. If not, a new run starts on its own.

The same root gives two waits at once (`faithful-one-wait`): the continued
request fails with a quota error or a short rate limit, and an in-run wait
starts while the idle wait goes on. Another extension's `agent_before_settle`
continue gives the same path with no steer (`f2-no-steer`).

Harm: a second "continue the task from where it stopped" for one failure. The
model gets an extra run or an extra message after the task already went on.

Live repro:

```
$ node formal/rate-limit-recovery/repro-f2.mts
{ "steer": true, "modelCallsBeforeRelease": 2, "localWaitEntriesBeforeRelease": ["open"],
  "modelCallsAfterRelease": 3, "resumeMessages": 1, "runsAfterTheTaskWentOn": 1,
  "lastReply": "I continue the task from where it stopped.", "extensionErrors": 0 }   (exit 1)
$ node formal/rate-limit-recovery/repro-f2.mts --report      (a shell job style report steers in: same result, exit 1)
$ node formal/rate-limit-recovery/repro-f2.mts --no-steer
{ "steer": false, "modelCallsBeforeRelease": 1, "modelCallsAfterRelease": 2, "resumeMessages": 1,
  "runsAfterTheTaskWentOn": 0, ... }   (exit 0)
```

Fix options:

1. In the `context` handler, end the idle wait with `yieldToRun()` when it is
   active: a new request carries the task on. This is `CONTEXT_ENDS_IDLE_WAIT`
   in the model.
2. In `TransientBackoff.turnEnd`, hand the wait to the idle wait only when Pi has
   no queued messages (`ctx.hasPendingMessages()`). This does not cover a
   continue from another extension's `agent_before_settle`.
3. In `LocalIdleWait.run`, before the resume, check that no request ran after
   the wait started (for example, a request counter that the `context` handler
   moves).

### F3: a late return to the session leaves the entry open, and a later /reload starts a run on its own

Found by the step-9 review (outside the first model's bounds). The model now
has the action `leave(late)`.

1. A local request fails, and the idle wait writes an open entry.
2. The user leaves the session (`/resume` to another one, or quits). The
   `session_shutdown` handler calls `idleWait.stop(true)`, which keeps the
   entry open (`controller.ts:160`).
3. The user comes back more than 10 min later (`/resume`, or
   `pi --continue`). `session_start(resume)` calls `restoreIdleWait` with
   the 10 min limit (`controller.ts:158`). `openWait` refuses the entry
   (`idle-wait.ts:63`). Nothing closes it.
4. The user works in the session. `before_agent_start` closes only a live
   wait (`idle-wait.ts:116-119`), so the open entry stays the last one.
5. A `/reload` within 48 h restores the wait (`controller.ts:168-180`).
   When the server answers, a "continue the task" run starts.

- Harm: an unrequested run that continues a task that the user gave up.
- Live repro: `node formal/rate-limit-recovery/repro-f3.mts` prints
  `runsStartedOnTheirOwn: 1` and `lastReply: "I continue the old task."`
  (exit 1). The control `--soon` (back at once) restores the wait at the
  return, the next prompt closes the entry, and no run starts (exit 0). The
  11 min gap is a patch of `Date.now`.
- Model: `f3-late-return` violates `resumeOwed` with the F1, F2 and F4 fixes on.
- Fix: at each `session_start` that does not restore an open entry (reason
  `fork` or `new`, or a restore that the age limit refuses), write a closed
  entry when the last entry is open (`START_CLOSES_STALE_ENTRY`). This also
  fixes F1, in place of `FORK_CLOSES_ENTRY`.

### F4: /tree while idle does not end the idle wait, and it resumes a task that is not on the branch

Found by the step-9 review. The model now has the action `tree(keepsEntry)`.

1. A local request fails, and the idle wait starts.
2. The user runs `/tree` and goes back to the first prompt. The TUI aborts
   only a run that is active (`interactive-mode.js:4645-4650`). The
   controller has no `session_tree` handler (`controller.ts:123-165`), so
   the idle wait goes on.
3. When the server answers, the idle wait sends "Continue the task from
   where it stopped". A run starts on a branch that holds only the system
   message. Pi put the user's prompt text back in the editor.

- Harm: an unrequested run on a branch with no task, while the user edits
  the prompt that they want to send.
- Live repro: `node formal/rate-limit-recovery/repro-f4.mts` prints
  `branchAfterNavigation: ["model_change","thinking_level_change","message:system"]`
  and `runsStartedOnTheirOwn: 1` (exit 1). The control `--no-nav` also makes
  one run, but that run is the resume that the failure is owed (exit 0).
- Model: `f4-tree-away` violates `resumeOwed` with the F1, F2 and F3 fixes on.
- Fix: add a `session_tree` handler that calls `idleWait.cancel()` (or
  `stop()` and a closed entry) and `transient.reset()`
  (`TREE_ENDS_IDLE_WAIT`).

## Review (skill step 9)

A fresh Opus 5.5 reviewer read each action against the code and Pi. It ran
the repros, the platform checks and the replay. It found F3 and F4 (both
high, with live repros), and the record now models both. Other points:

- Medium, no repro: the `_prepareRun` window. Pi sets the session busy
  (`agent-session.js:1424`), then awaits `_prepareRun` (`:1428`), which can
  compact before it emits `before_agent_start` (`:1485-1488`). If the idle
  wait answers in that window, its message steers into the user's new run
  (`:1857-1862`), and `controller.ts:151` `idleWait.cancel()` comes too
  late. The model and the replay's fake Pi make this one step.
- Low: `clone` has the guard `not(running)`, but `/clone` has no guard
  (`interactive-mode.js:4581`): the fork aborts the run first. The action
  also keeps `queued` into the new session.
- Low: `/fork` from an earlier message is not modeled. It can copy an open
  entry, as `/clone` does in F1.
- Weak points of the model: the error kind is not tied to the selected model;
  one boolean stands for the idle wait, so the stale-run guard at
  `idle-wait.ts:170` (`active?.controller !== controller`) is not covered;
  `MAX_CANCELS = 1` is shared by Esc and the cancel command, and there is no
  switch back after a model switch; the transient budget counts waits, but
  the code budgets time (the replay moves the clock to match).
- Fix options of F1: the options "put the session id in the entry" and
  "restore only a suspended entry" do not cover F3. Use the F3 fix.

## Survivors

| Check | Why it survives |
|---|---|
| survivor-context-keeps-ready | Three places clear `ready`: `before_agent_start`, `context` and `message_end`. Each one alone is enough in the model. |
| survivor-start-keeps-ready | The same: the `context` event of the first request clears both flags. |
| survivor-message-end-keeps-ready | The same: `context` came before the reply. |
| survivor-transient-wait-ignores-abort | Without the abort check before the transient wait (`transient.ts:390`), the wait runs after an Esc. The check after the wait (`transient.ts:423`) and the end of the aborted run stop the resume. Only a wasted wait is left, and no property states that. The replay catches this change. |
| survivor-model-switch-keeps-hibernation | Without the cancel on a switch out of scope (`controller.ts:136`), the scope check after the wait (`controller.ts:275`) still stops the resume. The mutant with both removed breaks `resumeOwed`. |

Each invariant breaks on at least one mutant: `resumeOwed` (5 mutants),
`withinBudgets` (3), `openEntryHasWait` (1), `oneWait` (the F2 variant
`f2-run-continues-one-wait`; under the fixes, no single code change that we
tried gives two waits at once without also breaking `resumeOwed` first).

## Conformance replay

`tests/rate-limit-recovery-conformance.test.mts` replays all 211 traces
(200 random, 11 witnesses) from `traces.itf.jsonl.gz` against the real
`Recovery` class, with its real `TransientBackoff` and `LocalIdleWait`. After
each step it compares 15 fields: the fake Pi's phase, queue, abort flag and
model, `pending`, `ready`, `attempts`, `spentMs`, `active`, the transient
`pending`, `ready`, `waiting` and rate-limit streak, the idle wait, and the
last `local-wait` entry. The traces come from the faithful model, so they
include the paths of F1 to F4.

The fake Pi copies the model's Pi rules. The replay cannot show that those
rules are true of Pi. `check-platform.mts` and the repros do that.

One-guard changes to the real code (each restored, `git diff -- lib extensions`
empty after each). These ran against the first trace set (209 traces, before
the review added `leave` and `tree`), and the trace numbers refer to that set. They were not run again on
the new set:

| Change | Result |
|---|---|
| `controller.ts:151` without `this.idleWait.cancel()` | caught (trace 206, `userPrompt`: `iActive`) |
| `controller.ts:150` without `this.idleWait.yieldToRun()` | caught (trace 205, `otherMessage`: `iActive`) |
| `controller.ts:130` without the `ready` resets in `context` | caught (trace 9, `context`: `tReady`) |
| `controller.ts:307` continue without `shouldResume` | caught (trace 0, `settleEnd`: `phase`) |
| `controller.ts:136` without the cancel on a switch out of scope | caught (trace 101, `modelSelect`: `phase`) |
| `transient.ts:390` without `runSignal.aborted` | caught (trace 67, `turnEnd`: `iActive`) |
| `idle-wait.ts:121` `cancel()` writes no closed entry | caught (trace 33, `esc`: `entryOpen`) |
| `core.ts:65` without the attempt cap | missed: in the traced bounds the wait budget (2 waits) refuses the third wait at the same point. The model mutant `mutant-no-attempt-cap` uses a budget of 3 to show it. |

## Pi rules in the model

`node formal/rate-limit-recovery/check-platform.mts` runs a probe extension in
Pi's real `AgentSession`. All 7 rules print `ok`:

| Rule | How it was checked |
|---|---|
| R1 A failed reply: `message_end`, `turn_end`, `agent_end`, `agent_before_settle`, `agent_settled`. | check-platform.mts |
| R2 Pi awaits an async `turn_end` handler before `agent_end`. | check-platform.mts |
| R3 A steer queued while the run starts goes into the first request. | check-platform.mts |
| R4 A steer queued during the failing request continues the same run: a new `context`, no `before_agent_start`, no `agent_before_settle`. | check-platform.mts, repro-f2.mts |
| R5 An abort during the `turn_end` wait aborts `ctx.signal`, and the run ends with no `agent_before_settle`. | check-platform.mts |
| R6 `agent_before_settle` continue gives a new request in the same run, with no `before_agent_start`. | check-platform.mts |
| R7 `sendCustomMessage` with `triggerTurn` steers into an active run, and starts a run while idle. | check-platform.mts, repro-f2.mts |
| R8 `/clone` copies the branch with custom entries; the clone gets `session_start` with reason `fork`; `reload()` gives `session_start` with reason `reload`. | repro-f1.mts |
| R9 In the TUI, Esc while a run streams clears the queues and aborts (`interactive-mode.js:2377-2379`, `:3852-3869`); `ctx.abort()` does the same through the TUI's `abortHandler` (`interactive-mode.js:1478-1480`). | source only (no TUI in the scripts) |
| R10 The TUI refuses `/reload` while a run streams (`interactive-mode.js:5328-5332`). | source only |
| R11 `setModel` has no streaming guard, so `model_select` can come during a run (`agent-session.js:2008-2024`). | source only |
| R12 Extension commands run at once, also while a run streams (`agent-session.js:1636-1644`). | source only |

## Test coverage table

Input for a later task that removes tests after mutation testing. No test was
removed or changed.

| Test file (or test) | Covered by | Verdict |
|---|---|---|
| rate-limit-extension.test.ts: "a completed wait commits canonical resume context and consumes one continuation" | `hibernateTimer`, `postRun`; mutant-ready-survives-new-run; replay | covered by the model (resume count); keeps value for the resume note text and the context_edit entries |
| rate-limit-extension.test.ts: "a queued continuation taking over consumes ready without requesting another" | `postRun` queued branch, `context`; replay | covered by the model |
| rate-limit-extension.test.ts: "normal Esc/Ctrl+C cancels without resume injection" | `esc`; replay | covered by the model for the resume; keeps value for Ctrl+C consumption and `unsubscribed` (review) |
| rate-limit-extension.test.ts: "Kitty key release is ignored and an Anthropic model switch retains the wait" | `modelSelect` same scope | keeps value: key release parsing is not in the model |
| rate-limit-extension.test.ts: "switching out of provider scope aborts without a stale resume" | survivor-model-switch-keeps-hibernation, mutant-model-switch-resumes-out-of-scope; replay | covered by the model |
| rate-limit-extension.test.ts: "limits cannot produce an unbounded retry loop or excessive aggregate wait" | `withinBudgets`; mutant-no-attempt-cap, mutant-no-wait-budget | covered by the model for the counts; keeps value for the refusal text (review) |
| rate-limit-extension.test.ts: "session_start/session_shutdown cancels an active wait without stale continuation" | not in the model (`reload` only while idle; `generation` epoch not modeled) | keeps value: it tests the epoch guard, which the model leaves out |
| rate-limit-extension.test.ts: "cancellation winning the deadline race never injects a resumed notice" | `esc`, `cancelCommand` | keeps value: the model folds the timer's end and the check at `controller.ts:275` into one step, so it cannot reach the race. This is the only test of `signal.aborted` at `controller.ts:275` (review) |
| rate-limit-extension.test.ts: "a local server's wait leaves the run ..." | `turnEnd` local branch, `idleWaitEnds`; replay | covered by the model; keeps value for the live line text and the probe URL (fix: c9279cb) |
| rate-limit-extension.test.ts: "the resumed run keeps the outage ..." | not in the model (outage counts left out) | keeps value: guards fix: 72d7077 |
| rate-limit-extension.test.ts: "a message from the user ends the idle wait: nothing starts on its own" | mutant-user-run-keeps-idle-wait; replay | covered by the model |
| rate-limit-extension.test.ts: "a reload or an update restart goes on with an open wait from the session" | `reload`; witness `witnessNoRestore` | partly covered; keeps value: it checks the new `at` of the entry and the update-restart path, which the model leaves out (review) |
| rate-limit-extension.test.ts: "a new process goes on with a wait only right after the old one stopped" | not in the model (age limits) | keeps value: guards fix: e4c71a8 |
| rate-limit-extension.test.ts: "a shutdown during the wait writes the stop time for the next process" | not in the model (`at` time) | keeps value: guards fix: e4c71a8 |
| rate-limit-extension.test.ts: "with a draft in the editor, Esc and Ctrl+C belong to the editor" | not in the model (the model assumes an empty editor) | keeps value: guards fix: e4c71a8 |
| rate-limit-extension.test.ts: "a shell job report during the wait keeps the outage" | mutant-carried-run-keeps-idle-wait; replay | covered by the model (the wait ends); keeps value for the outage start time (fix: e4c71a8) |
| rate-limit-extension.test.ts: "the cancel command ends the idle wait, and status shows it" | `cancelCommand` | covered by the model; keeps value for the status text |
| rate-limit-extension.test.ts: transport tests (provider guards, legacy API warning, disposal failure, setup failure), "detection defaults to fail-fast", "print/json/rpc sessions never auto-wait", "append-entry setup failure", "clock rollback", "overslept elapsed time", "UI setup failure", "/rate-limit-recovery on|off", "shutdown clears an active wait and commands preserve unrelated config", "a print-mode main session keeps the budget", "the context hook keeps only the last resume message" | not in the model | keeps value: transport, modes, faults, clock arithmetic, config and text are left out |
| rate-limit-idle-wait.test.ts: "Esc ends the wait: no run starts", "a second start replaces the first wait" | `esc`, `turnEnd` local branch; replay | partly covered: "Esc ends the wait" is covered by the model. "A second start replaces the first wait" keeps value: it tests the guard at `idle-wait.ts:170`, which one boolean in the model cannot express (review) |
| rate-limit-idle-wait.test.ts: the other 7 tests (entry fields, stop and suspend records, restore checks at once, fallback timer, fresh entry, last resume message) | partly `reload` | keeps value: entry fields, timers and the stop time are left out (fix: e4c71a8, c9279cb) |
| rate-limit-transient.test.ts: "cancelling during the wait ends the run without resuming", "skipping the wait (a model switch) resumes at once and releases the timer" | `esc`, `cancelCommand`, `modelSelect`; replay | covered by the model; keeps value for the timer release |
| rate-limit-transient.test.ts: "an exhausted budget ends the run with a non-retryable message and no wait" | mutant-no-streak-budget | covered by the model for the count; keeps value for the message text |
| rate-limit-transient.test.ts: the other 20 tests (classification, schedule, hints, proxy retries, messages, tools) | not in the model | keeps value: classification and schedules are left out (fix: 539145b, 6a89499, 47c2b3b) |
| rate-limit-sdk.test.mts: "queued steer/followUp preserves Pi queue semantics with one recovery" | R4, `postRun` queued branch | covered by the model for the resume count; keeps value as a real-Pi test |
| rate-limit-sdk.test.mts: "a failure before context preparation cannot repeat a consumed continuation" | `beforeSettle` consumes ready | unsure: the model has no failure before `context` |
| rate-limit-sdk.test.mts: "repeated quota errors stop after a bounded number of recovery attempts" | `withinBudgets` | covered by the model; keeps value as a real-Pi test |
| rate-limit-sdk.test.mts: the other 9 tests | not in the model | keeps value: real Pi, history shape, native retry, tools, TUI input |
| rate-limit-local.test.ts: "Esc during a check ends the local wait with no resend" | `esc` | keeps value: the model has no in-run local wait (a `TransientBackoff` wait with no idle wait) (review) |
| rate-limit-local.test.ts: the other 26 tests (local detection, probe, wait loop timers, outage counts, messages) | not in the model | keeps value: guards fix: b96bac5, 72d7077, 69ac5c0, c9279cb |
| rate-limit-wait.test.ts | not in the model (timer and widget) | keeps value |
| rate-limit-core.test.ts | not in the model (parsing, scopes, plan arithmetic) | keeps value |
| rate-limit-connection.test.ts | not in the model (classification) | keeps value: guards fix: 47c2b3b, 4775c4b |
| rate-limit-transient-http.test.mts | not in the model (HTTP transport) | keeps value |
| rate-limit-first-event.test.ts, rate-limit-first-event-http.test.mts | not in the model (stall watchdog) | keeps value: guards fix: 94a0ec1 |
| rate-limit-transport.test.ts, rate-limit-http-sdk.test.mts | not in the model (transport guard) | keeps value: guards fix: 4c4b59f |
| rate-limit-child-guard.test.ts, rate-limit-child-sdk.test.mts | not in the model (subagents) | keeps value |
| virtual-model.test.ts (recovery under a virtual model) | not in the model (routed scope) | keeps value |
| subagents-fallback.test.ts, tab-status-background.test.mts, plan-billing.test.ts, package-contract.test.mjs | not in the model (they use text helpers, `waitUI`, `scopeFor`, the package list) | keeps value |

## Commands

```sh
node skills/formal-verification/scripts/fv.mjs check formal/rate-limit-recovery --workers 2
node skills/formal-verification/scripts/fv.mjs check formal/rate-limit-recovery --only faithful --trace
node skills/formal-verification/scripts/fv.mjs traces formal/rate-limit-recovery
node --test tests/rate-limit-recovery-conformance.test.mts
node formal/rate-limit-recovery/check-platform.mts
node formal/rate-limit-recovery/repro-f1.mts      # and --no-clone
node formal/rate-limit-recovery/repro-f2.mts      # and --no-steer, --report
node formal/rate-limit-recovery/repro-f3.mts      # and --soon
node formal/rate-limit-recovery/repro-f4.mts      # and --no-nav
node skills/formal-verification/scripts/fv.mjs drift formal/rate-limit-recovery
```

## Open points

- The `_prepareRun` window (medium, no repro). See "Review (skill step 9)".
- R9 to R12 are from the Pi source only. No script runs the TUI.
- The model has no failure before `context` (auth or routing). A test in
  rate-limit-sdk.test.mts covers that case.
