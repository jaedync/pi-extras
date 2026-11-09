# Facts for a Pi issue: `isIdle()` is true while Pi still holds a sent message

These are the facts for an issue in your own words. Do not let an agent open
the issue or a pull request: Pi's CONTRIBUTING.md does not accept agent-written
issues and pull requests from new contributors.

## Scope

- Date checked: 2026-11-08.
- Pi versions tested: `@earendil-works/pi-coding-agent` 1.4.0 and 1.5.0.
  The facts apply to these two versions. A later release can change them.
- pi-extras: the code before the fix is commit `cf08a6a`. The fix is commit
  `e95a143` (with `dabe888`) on branch `numbrone/fix-shell-jobs-dup`, not
  released yet. With the fix, pi-extras does not
  depend on these Pi rules for correct delivery. So the issue is about Pi's
  contract, not about a pi-extras bug that is still open.

## The cause in Pi terms

1. `AgentSession.isIdle` is `!_isAgentRunActive && !isCompacting`. It is true
   while a `sendCustomMessage(..., { triggerTurn: true })` waits in
   `_deferredSettledActions`, and while a steered message waits in the
   agent's queue after an abort.
2. So an extension that sends a message again when `ctx.isIdle()` is true and
   the message is not in the session cannot tell "Pi still holds it" from "Pi
   dropped it". Pi then delivers both copies. No API shows the agent's queue
   to an extension: `ctx.hasPendingMessages()` counts only user messages.

The doc comment on `isIdle` says: "Whether the session has no active agent
run, compaction, branch summary, retry, or queued continuation." A deferred
action and a kept queue are queued continuations, so the code and the comment
do not agree.

## Where Pi holds a message while `isIdle()` is true

Facts 1 to 3 were seen on 1.4.0 and 1.5.0 with `pi-probe.mts` (below). Fact
4 was seen on 1.4.0 and 1.5.0 with `repro-f2.mts --one-job --compact`:

1. A send from an `agent_settled` handler waits in `_deferredSettledActions`.
   `isIdle()` is true right after the send. The message lands later.
2. `AgentSession.abort()` with no `clearQueue()` keeps a steered message for
   the next run. This is the RPC `abort` command, and `ctx.abort()` in RPC,
   print or SDK mode. After the run settles, `isIdle()` is true, the message
   is not in the session, and the next user run puts it in the session.
3. In the TUI, Esc calls `clearQueue()` and then `abort()`. A message steered
   after the clear and before the run stops is kept for the next run. After
   the run settles, `isIdle()` is true and the message is not in the session.

4. In the TUI, `/compact` calls `AgentSession.abort()` with no clear of the
   queue (`handleCompactCommand`, then `compact()`, in
   `interactive-mode.js`). `ctx.compact()` does the same. A steered message
   is kept for the next run, as in fact 2. `/new`, `/resume`, `/fork` and
   `ctx.newSession()` also abort with no clear, and then close the old
   session (from the source; not run live).

Facts 3 and 4 mean that a TUI abort does not always drop the queue. Esc drops
only what was in the queue when the user pressed it, and the session commands
drop nothing.

## How to check a new Pi version

Run the probe from the pi-extras checkout. It uses only a minimal extension,
not pi-extras code:

```sh
PI_TEST_AGENT_ROOT=<folder of @earendil-works/pi-coding-agent> node formal/shell-jobs-delivery/pi-probe.mts
```

Without `PI_TEST_AGENT_ROOT`, it uses the Pi of `package.json` (1.4.0).

Result on 1.4.0 and 1.5.0 (both the same):

```json
{"idleWhileDeferred":true,"idleWithKeptQueue":true,"idleAfterClearThenSteer":true,
 "fixRules":{"signalUndefinedInSettle":true,"signalDefinedInRun":true,
 "signalAbortedAfterAbort":true,"beforeAgentStartNamesDeferredSend":true}}
```

- When `idleWhileDeferred`, `idleWithKeptQueue` and `idleAfterClearThenSteer`
  are all false, the Pi release fixed the cause.
- When a field of `fixRules` is false, the pi-extras fix uses a Pi rule that
  changed. Read `lib/shell-jobs-delivery.ts` again before you use that release.

To see the duplicate itself, run the repro with the pi-extras code before the
fix (commit `cf08a6a`):

```sh
git worktree add ~/dev/pi-extras.worktrees/check-cf08a6a cf08a6a
cd ~/dev/pi-extras.worktrees/check-cf08a6a && npm ci
PI_TEST_AGENT_ROOT=<folder> node formal/shell-jobs-delivery/repro-f2.mts --one-job --keep-queue
```

Remove the worktree after the check (`git worktree remove ~/dev/pi-extras.worktrees/check-cf08a6a`).

At `cf08a6a` it printed `"completionMessages":{"echo-a":2}` on 1.4.0 and
1.5.0. (The repro in that commit binds in print mode and has no
`--job-after-abort` option.)

## The shortest model trace

TLC check `old-f5-send-after-abort` (the code before the fix, TUI, one job),
12 steps. Run it with:

```sh
node skills/formal-verification/scripts/fv.mjs check formal/shell-jobs-delivery --only old-f5-send-after-abort --trace
```

| Step | Action | What changes |
|---|---|---|
| 0 | init | A run is active. |
| 1 | finishStart(j1) | The job exits. |
| 2 | finishEnd(j1) | The completion goes into the outbox; its tail read starts. |
| 3 | abortRequest(clear) | Esc: the TUI clears the queue and calls `abort()`. |
| 4 | readSome | The read ends. The completion is steered: queue `[j1]`, 1 send. |
| 5 | runEnds | The run ends with j1 in the queue. `agent_settled` starts (`aborted: true`). |
| 6 | settleHandler | Reconcile: j1 is not in the session or the outbox, and `isIdle()` is true. A new attempt. |
| 7 | readSome | The second send. Pi defers it: 2 sends. |
| 8 | settleEnds | Pi runs the deferred send. A new run starts. Queue `[j1, j1]`. |
| 9 | beforeAgentStart | |
| 10 | piDeliver | j1 lands once. |
| 11 | piDeliver | j1 lands a second time. |

The path with an RPC abort (`old-f4-abort-keeps-queue`) is the same, with
the abort after step 4 and no clear.

## A fix in Pi (from the model)

Make `isIdle` false in two more cases:

- While actions wait in `_deferredSettledActions`, and while Pi runs them.
  The loop calls `_resolveIdleWaitIfIdle` in its `finally`, so the fix must
  clear its flag before that call, or `waitForIdle()` can wait forever.
- While messages wait in the agent's queues (`agent.hasQueuedMessages()`).

With both halves, the model of the pi-extras code before the fix has no
duplicate (`old-pi-idle-counts-pending`). The full fix also closes two limits
of the pi-extras fix: a completion that an Esc drops while no agent loop runs
stays held, and a run that leaves its loop by an exception with a message in
the queue can still give a duplicate. Both need Pi to show what it holds. The first half alone is not enough
(`old-pi-idle-counts-deferred` still finds the duplicate through a kept queue).
