// Shell job completion delivery: a model of how a finished job's completion
// message reaches the conversation, across Pi runs, aborts, agent_settled and
// /reload. Each action is one synchronous segment of the code (the code between
// two awaits), so the checker tries every order in which the event loop can run
// them. The file:line comments name the code each action stands for.
//
// Code: lib/shell-jobs-delivery.ts, extensions/shell-jobs.ts (finalize, the
// message_end, agent_settled and session_start handlers), lib/shell-jobs-manage.ts
// (stopJob), lib/shell-jobs-process.ts (parkForReload).
//
// The fix for finding F (README.md): a sent completion stays "held" until it
// lands, and reconcile skips held jobs. ctx.signal, read before the send,
// tells where Pi puts it:
// - "steered": an agent loop runs, so Pi steers it into the run's queue. A
//   run that settles without an abort drained its queue: the message landed
//   or was dropped. An aborted run proves nothing, because some aborts keep
//   the queue for the next run.
// - "pending": no agent loop and Pi is idle (agent_settled handlers run, so
//   Pi defers it, or it starts a run). It waits until before_agent_start
//   names it as the message that starts a run; then it is "steered".
//   Otherwise only its landing clears it.
// - Gap wait: while a run is active with no agent loop (before_agent_start
//   handlers, the gaps between loops), shell-jobs does not send. Pi would put
//   the message in the queue, where an Esc can drop it with no proof. The
//   completion stays in the outbox, and the agent_start handler or a retry
//   timer flushes it again.
// Pi 1.4.0 (1.5.0 is the same here): dist/core/agent-session.js and
// dist/modes/interactive/interactive-mode.js. Line numbers are for 1.4.0.
module delivery {
  // Bounds. A pass covers only these sizes. See README.md for what they leave out.
  pure val JOBS = Set("j1", "j2")
  pure val MAX_ATTEMPTS = 3   // MAX_COMPLETION_ATTEMPTS, lib/shell-jobs-delivery.ts:7
  pure val MAX_RELOADS = 1
  pure val MAX_RUNS = 2       // runs that the user starts or aborts

  // Platform switches. The faithful model is Pi as it is.
  // Pi lets /reload run while agent_settled handlers still run, because
  // handleReloadCommand checks only isStreaming (interactive-mode.js:5328-5336).
  // Pi's isIdle is `!_isAgentRunActive && !isCompacting` (agent-session.js
  // isIdle): it ignores sends that wait in _deferredSettledActions. The fix
  // variant makes it false while deferred work waits or runs.
  pure val IDLE_COUNTS_DEFERRED = false
  // isIdle also ignores messages that wait in the agent's steering and
  // follow-up queues (agent.hasQueuedMessages). They are left there by an
  // abort that does not clear them. The second fix variant makes isIdle false
  // while they wait.
  pure val IDLE_COUNTS_QUEUE = false

  // Some aborts clear the queue first: in the TUI, Esc, tree navigation and
  // ctx.abort() through the TUI's abortHandler call clearAllQueues
  // (interactive-mode.js:1479-1480, :3853, :4648-4649). Others keep it, and
  // the next run takes it (agent.js:263, :340): the RPC abort
  // (rpc-mode.js:328), ctx.abort() with no abortHandler (RPC, print, SDK),
  // and in the TUI /compact, /new, /resume, /fork, ctx.compact() and
  // ctx.newSession(), which call AgentSession.abort() (agent-session.js:1971-1983)
  // alone. The variant with only clearing aborts sets this to false.
  pure val ABORT_KEEPS_QUEUE = true

  // An extension loaded before shell-jobs can have an agent_settled handler
  // that awaits I/O, so other segments can run before the shell-jobs handler.
  // The variant that assumes no such extension sets this to false.
  pure val OTHER_HANDLERS_FIRST = true

  // `for (const action of deferred) await action()` in _emitAgentSettled has
  // no catch. If a deferred action throws (a deferred prompt with no model or
  // API key, or an error in _prepareRun after before_agent_start), Pi drops
  // the actions after it, and the error goes up through the outer loops too.
  // The faithful model assumes that no deferred action throws; the checks
  // named pi-deferred-throws set this to true.
  pure val DEFERRED_THROWS = false

  // A run that a completion starts can fail in _prepareRun after
  // before_agent_start (startFails). Its first message is then lost. The
  // faithful model lets only a user prompt's run fail; the checks named
  // pi-run-start-fails set this to true.
  pure val RUN_START_FAILS = false

  // The fix: reconcile skips a held job (lib/shell-jobs-delivery.ts reconcileDeliveries).
  // The checks named old-* set it to false to show each path of finding F in
  // the code before the fix.
  pure val HELD_GUARD = true

  // A tail read can end while an aborted run winds down, so its send goes into
  // the queue after the abort. The checks old-f1 to old-f4 set it to false, so
  // that each shows its own path and not the shorter F5.
  pure val SEND_AFTER_ABORT = true

  // The gap wait (sendCompletion in lib/shell-jobs-delivery.ts): no send while
  // ctx.signal is undefined and ctx.isIdle() is false. The code at
  // faabebb, and the checks named old-*, set it to false.
  pure val GAP_WAIT = true

  // The deferred item for a user prompt (agent-session.js:1632-1634).
  pure val PROMPT = "prompt"

  type Job = { phase: str, claimed: bool, attempts: int, delivered: bool, failed: bool }

  // Runtime state (Runtime and Job in lib/shell-jobs-process.ts).
  var jobs: str -> Job
  var outbox: Set[str]
  // Tail reads in flight: (job, binding that started it). The inFlight map of
  // attachDelivery, one map for each binding.
  var reading: Set[(str, int)]
  // runtime.delivery: the binding id, 0 while parked for a reload.
  var binding: int
  var lastBinding: int
  // Pi session state.
  var busy: bool               // _isAgentRunActive (isStreaming)
  var inLoop: bool             // an agent loop of the run runs: ctx.signal is defined (agent.js)
  var settling: bool           // _isEmittingAgentSettled
  var handlerDue: bool         // agent_settled is emitted; the shell-jobs handler has not run yet
  var settleWaits: Set[(str, int)]  // reads that the shell-jobs agent_settled handler awaits
  var deferred: List[str]      // _deferredSettledActions of the emission now running
  var later: List[str]         // deferred actions that an outer `for ... await action()` loop still holds
  var loopRun: bool            // the active run was started by a deferred action
  var reloading: bool          // /reload passed its isStreaming check and has not parked shell-jobs yet
  var queue: List[str]         // messages of the active run that are not in the session yet
  var history: str -> int      // completion messages in the session branch
  // Observations for the properties.
  var kill: str -> str         // "none" | "waiting" | "stopped" | "stillStopping"
  var sends: str -> int        // pi.sendMessage calls
  var reloads: int
  var runs: int
  // Ghost: jobs whose message landed while parked. Only a witness reads it.
  var landedParked: Set[str]
  // runtime.held (lib/shell-jobs-delivery.ts): "none" | "steered" | "pending".
  var held: str -> str
  // The `aborted` field of the agent_settled event now emitted
  // (agent-session.js _emitAgentSettled: `this._agentRunAbortRequested`).
  var settleAborted: bool
  // A send started a run (an idle send, or a deferred one in settleEnds), and
  // before_agent_start has not run yet: the job id, or "" for none.
  var starting: str
  // The message that starts the active run: the _startRun trigger of an idle
  // or deferred send, until it lands. It is not in the agent's queue, so a
  // clear does not drop it, and it lands first when the loop starts, also
  // after an abort (agent-loop.js runAgentLoop). "" for none.
  var firstMsg: str
  // _agentRunAbortRequested: AgentSession.abort() ran during this run.
  var abortRequested: bool
  // The retry timer of the gap wait is armed (attachDelivery's retryArmed).
  var armed: bool
  // agent_start was emitted for a loop, and the shell-jobs handler has not run yet.
  var startDue: bool
  // Ghost: jobs that were still held with no copy in Pi after an
  // agent_settled handler of a run with no abort released the held map.
  var stuckAtSettle: Set[str]

  // ---- Helpers that copy one piece of code each ----

  // flush(), lib/shell-jobs-delivery.ts:43-53: start a read for each outbox id
  // that has none in flight in this binding.
  pure def flushReads(b: int, box: Set[str], inFlight: Set[(str, int)]): Set[(str, int)] =
    if (b == 0) inFlight else inFlight.union(box.map(j => (j, b)))

  // acknowledgeCompletion, lib/shell-jobs-delivery.ts:32-38.
  pure def acked(job: Job): Job =
    if (job.delivered and not(job.failed)) job else { ...job, delivered: true, failed: false }

  // The loop of reconcileDeliveries (lib/shell-jobs-delivery.ts) for one job.
  pure def reconcileJob(job: Job, inHistory: bool, inOutbox: bool, isHeld: bool): (Job, bool) =
    if (job.phase != "done" or job.delivered or job.attempts == 0) (job, inOutbox)
    else if (inHistory) (acked(job), false)
    else if (inOutbox) (job, inOutbox)
    else if (HELD_GUARD and isHeld) (job, inOutbox)
    else if (job.attempts >= MAX_ATTEMPTS) ({ ...job, failed: true }, inOutbox)
    else ({ ...job, attempts: job.attempts + 1 }, true)

  // A gap of a run: busy, with no agent loop. ctx.signal is undefined and
  // ctx.isIdle() is false, so sendCompletion does not send.
  val gapNow = GAP_WAIT and busy and not(inLoop)

  // flush() in binding b, with the gap check that sendCompletion makes before
  // its tail read: in a gap no read starts, and the retry timer is armed
  // (lib/shell-jobs-delivery.ts sendCompletion, waitForGap). Returns the reads
  // in flight and the timer state.
  def flushIn(b: int, box: Set[str]): (Set[(str, int)], bool) =
    if (b == 0) (reading, armed)
    else if (gapNow) (reading, armed or box.exists(j => not(reading.contains((j, b)))))
    else (flushReads(b, box, reading), armed)

  // With no other extension first, nothing runs between runEnds and settleHandler.
  val handlerGate = not(handlerDue) or OTHER_HANDLERS_FIRST

  // ctx.isIdle() as Pi computes it.
  pure def idleOf(isBusy: bool, waiting: List[str], outer: List[str], inLoop: bool, queued: List[str]): bool = all {
    not(isBusy),
    not(IDLE_COUNTS_DEFERRED) or (waiting == [] and outer == [] and not(inLoop)),
    not(IDLE_COUNTS_QUEUE) or queued == [],
  }
  val piIdle = idleOf(busy, deferred, later, loopRun, queue)

  // Copies of a job's message that Pi holds or has put in the session.
  pure def count(l: List[str], j: str): int = l.foldl(0, (n, x) => if (x == j) n + 1 else n)

  // settleDeliveries (lib/shell-jobs-delivery.ts): a run that settled with no
  // abort drained its queue, so its "steered" sends are in the session or gone.
  pure def releaseHeld(h: str -> str, aborted: bool): str -> str =
    h.keys().mapBy(j => if (not(aborted) and h.get(j) == "steered") "none" else h.get(j))

  // Pi holds a copy of the message: in the run's queue, in the deferred
  // actions, or as the message that starts a run.
  def piHolds(j: str): bool =
    count(queue, j) + count(deferred, j) + count(later, j) > 0 or starting == j or firstMsg == j

  // reconcileDeliveries and its flush. It returns at once while Pi is not idle,
  // with no flush. `h` is runtime.held after settleDeliveries released it. An
  // acknowledgement from the history lookup also clears the job's held entry.
  action reconcileAndFlush(b: int, awaited: bool, h: str -> str): bool = {
    val results = JOBS.mapBy(j => reconcileJob(jobs.get(j), history.get(j) > 0, outbox.contains(j), h.get(j) != "none"))
    val box = JOBS.filter(j => results.get(j)._2)
    if (piIdle) all {
      jobs' = JOBS.mapBy(j => results.get(j)._1),
      outbox' = box,
      reading' = flushReads(b, box, reading),
      // The agent_settled handler awaits every read of the outbox ids.
      settleWaits' = if (awaited) box.map(j => (j, b)) else settleWaits,
      held' = JOBS.mapBy(j => if (results.get(j)._1.delivered and not(jobs.get(j).delivered)) "none" else h.get(j)),
    } else all {
      jobs' = jobs, outbox' = outbox, reading' = reading,
      settleWaits' = if (awaited) Set() else settleWaits,
      held' = h,
    }
  }

  // pi.sendMessage with triggerTurn and deliverAs "steer" (sendCustomMessage,
  // agent-session.js:1844-1872): steer into the active run, wait while
  // agent_settled handlers run, or start a run.
  // sendCompletion reads ctx.signal before the send (agent.signal: the abort
  // signal of the agent loop, agent.js). While the session is busy the loop
  // may run (signal defined) or not (_prepareRun, the gaps between loops).
  // With GAP_WAIT, readDone sends no message in the second case. An idle
  // send starts a run (_startRun), and its before_agent_start comes later.
  action piSend(j: str): bool = all {
    sends' = sends.setBy(j, n => n + 1),
    if (settling) all {
      deferred' = deferred.append(j), queue' = queue, busy' = busy, starting' = starting, firstMsg' = firstMsg,
      held' = held.set(j, "pending"),
    } else if (busy) all {
      deferred' = deferred, queue' = queue.append(j), busy' = busy, starting' = starting, firstMsg' = firstMsg,
      held' = held.set(j, if (inLoop) "steered" else "pending"),
    } else all {
      deferred' = deferred, queue' = queue, busy' = true, starting' = j, firstMsg' = j,
      held' = held.set(j, "pending"),
    },
  }

  action keepPi = all {
    busy' = busy, inLoop' = inLoop, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, reloading' = reloading, queue' = queue, history' = history,
  }
  action keepRest = all { kill' = kill, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked, stuckAtSettle' = stuckAtSettle }
  action keepRetry = all { armed' = armed, startDue' = startDue }
  action keepMode = all { settleAborted' = settleAborted, starting' = starting, abortRequested' = abortRequested, firstMsg' = firstMsg }

  // ---- Init ----

  action init = all {
    jobs' = JOBS.mapBy(_ => { phase: "running", claimed: false, attempts: 0, delivered: false, failed: false }),
    outbox' = Set(),
    reading' = Set(),
    binding' = 1,
    lastBinding' = 1,
    nondet b = Set(true, false).oneOf()
    busy' = b,
    inLoop' = false,
    settling' = false,
    handlerDue' = false,
    settleWaits' = Set(),
    deferred' = [],
    later' = [],
    loopRun' = false,
    reloading' = false,
    queue' = [],
    history' = JOBS.mapBy(_ => 0),
    kill' = JOBS.mapBy(_ => "none"),
    sends' = JOBS.mapBy(_ => 0),
    reloads' = 0,
    runs' = 0,
    landedParked' = Set(),
    held' = JOBS.mapBy(_ => "none"),
    settleAborted' = false,
    starting' = "",
    firstMsg' = "",
    abortRequested' = false,
    stuckAtSettle' = Set(),
    armed' = false,
    startDue' = false,
  }

  // ---- Job actions ----

  // The process exits; finalize sets "stopping" and awaits the group cleanup
  // (extensions/shell-jobs.ts:181-190).
  action finishStart(j: str): bool = all {
    handlerGate,
    keepRetry,
    jobs.get(j).phase == "running",
    jobs' = jobs.setBy(j, job => { ...job, phase: "exiting" }),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, keepRest, held' = held, keepMode,
  }

  // finalize after its awaits: re-read the job, decide suppression, record the
  // attempt, add to the outbox and flush (extensions/shell-jobs.ts:193-214).
  action finishEnd(j: str): bool = {
    val job = jobs.get(j)
    val suppressed = job.claimed or job.delivered
    val box = if (suppressed) outbox else outbox.union(Set(j))
    all {
      handlerGate,
      job.phase == "exiting",
      jobs' = jobs.set(j, { ...job, phase: "done", attempts: if (suppressed) job.attempts else job.attempts + 1 }),
      outbox' = box,
      val flushed = flushIn(binding, box)
      all {
        reading' = if (suppressed) reading else flushed._1,
        armed' = if (suppressed) armed else flushed._2,
      },
      startDue' = startDue,
      binding' = binding, lastBinding' = lastBinding,
      keepPi, settleWaits' = settleWaits, keepRest, held' = held, keepMode,
    }
  }

  // shell_job kill: stopJob claims the job and waits (lib/shell-jobs-manage.ts:148-152).
  action killStart(j: str): bool = all {
    handlerGate,
    keepRetry,
    jobs.get(j).phase != "done",
    kill.get(j) == "none",
    jobs' = jobs.setBy(j, job => { ...job, claimed: true }),
    kill' = kill.set(j, "waiting"),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked,
    stuckAtSettle' = stuckAtSettle, held' = held, keepMode,
  }

  // The final status arrives within KILL_WAIT_MS: the tool answers "stopped"
  // (lib/shell-jobs-manage.ts:153-159). finalize resolves finals before any
  // timer can run, so this wins over the timeout once the job is done.
  action killAnswer(j: str): bool = all {
    handlerGate,
    keepRetry,
    kill.get(j) == "waiting",
    jobs.get(j).phase == "done",
    kill' = kill.set(j, "stopped"),
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked,
    stuckAtSettle' = stuckAtSettle, held' = held, keepMode,
  }

  // The wait times out: stopJob clears the claim and promises a completion
  // message (lib/shell-jobs-manage.ts:160-167).
  action killTimeout(j: str): bool = all {
    handlerGate,
    keepRetry,
    kill.get(j) == "waiting",
    jobs.get(j).phase != "done",
    jobs' = jobs.setBy(j, job => { ...job, claimed: false }),
    kill' = kill.set(j, "stillStopping"),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked,
    stuckAtSettle' = stuckAtSettle, held' = held, keepMode,
  }

  // ---- Delivery ----

  // sendCompletion after `await readTail` (lib/shell-jobs-delivery.ts:62-108).
  // The inFlight entry goes in a later microtask (`.finally`, :49); no other
  // segment can run in between, so the model removes it here.
  action readDone(j: str, b: int): bool = {
    val job = jobs.get(j)
    all {
      handlerGate,
      reading.contains((j, b)),
      SEND_AFTER_ABORT or not(abortRequested),
      reading' = reading.exclude(Set((j, b))),
      settleWaits' = settleWaits.exclude(Set((j, b))),
      binding' = binding, lastBinding' = lastBinding,
      kill' = kill, reloads' = reloads, runs' = runs, landedParked' = landedParked, stuckAtSettle' = stuckAtSettle,
      history' = history, inLoop' = inLoop, settling' = settling, handlerDue' = handlerDue, later' = later,
      loopRun' = loopRun, reloading' = reloading,
      settleAborted' = settleAborted, abortRequested' = abortRequested,
      startDue' = startDue,
      armed' = if (binding == b and outbox.contains(j) and not(job.delivered or job.claimed) and gapNow) true else armed,
      if (binding != b or not(outbox.contains(j)))
        // The binding changed during the read: leave the entry for the new one.
        all { jobs' = jobs, outbox' = outbox, sends' = sends, deferred' = deferred, queue' = queue, busy' = busy, held' = held, starting' = starting, firstMsg' = firstMsg }
      else if (job.delivered or job.claimed)
        all { jobs' = jobs, outbox' = outbox.exclude(Set(j)), sends' = sends, deferred' = deferred, queue' = queue, busy' = busy, held' = held, starting' = starting, firstMsg' = firstMsg }
      else if (gapNow)
        // The gap wait: keep the outbox entry for a later flush, and arm the retry timer.
        all { jobs' = jobs, outbox' = outbox, sends' = sends, deferred' = deferred, queue' = queue, busy' = busy, held' = held, starting' = starting, firstMsg' = firstMsg }
      else
        all { jobs' = jobs, outbox' = outbox.exclude(Set(j)), piSend(j) },
    }
  }

  // One of the tail reads in flight finishes.
  action readSome: bool = all { reading != Set(), nondet r = reading.oneOf() readDone(r._1, r._2) }

  // Pi appends the next message of the run to the session and emits
  // message_end; the handler acknowledges it while attached
  // (extensions/shell-jobs.ts:844-852).
  action piDeliver: bool = all {
    handlerGate,
    keepRetry,
    // Only an active run takes queued messages; after an abort that kept
    // them, they wait for the next run.
    busy,
    queue.length() > 0 or firstMsg != "",
    // A run takes no message before its before_agent_start handlers end
    // (_prepareRun, agent-session.js, runs before agent.prompt), and only
    // an agent loop takes messages from the queue.
    starting == "",
    inLoop,
    // The run's first message lands before the messages of the queue.
    val j = if (firstMsg != "") firstMsg else queue.head()
    all {
      history' = history.setBy(j, n => n + 1),
      queue' = if (firstMsg != "") queue else queue.tail(),
      firstMsg' = "",
      jobs' = if (binding != 0) jobs.setBy(j, acked) else jobs,
      outbox' = if (binding != 0) outbox.exclude(Set(j)) else outbox,
      landedParked' = if (binding == 0) landedParked.union(Set(j)) else landedParked,
      // acknowledgeCompletion clears the held entry too.
      held' = if (binding != 0) held.set(j, "none") else held,
    },
    settleAborted' = settleAborted, starting' = starting, abortRequested' = abortRequested,
    busy' = busy, inLoop' = inLoop, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, reloading' = reloading,
    reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads, runs' = runs,
    stuckAtSettle' = stuckAtSettle,
  }

  // The user or a client aborts the run (AgentSession.abort(), agent-session.js:
  // `_agentRunAbortRequested = true`, then agent.abort()). Esc in the TUI clears
  // the queue first; the other aborts named at ABORT_KEEPS_QUEUE keep it for
  // the next run (agent.js:263, :340). A send after the abort and before the
  // run ends goes into the queue too, also after a clear.
  action abortRequest(clear: bool): bool = all {
    handlerGate,
    keepRetry,
    busy, not(settling), not(abortRequested),
    clear or ABORT_KEEPS_QUEUE,
    runs < MAX_RUNS,
    abortRequested' = true,
    queue' = if (clear) [] else queue,
    runs' = runs + 1,
    busy' = busy, inLoop' = inLoop, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, reloading' = reloading, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = settleWaits,
    binding' = binding, lastBinding' = lastBinding, kill' = kill, sends' = sends, reloads' = reloads,
    landedParked' = landedParked, held' = held, stuckAtSettle' = stuckAtSettle,
    settleAborted' = settleAborted, starting' = starting, firstMsg' = firstMsg,
  }

  // An agent loop starts: agent.prompt after _prepareRun, or agent.continue
  // when _runBeforeSettleBoundary or _handlePostAgentRun goes on
  // (agent-session.js _startRun). ctx.signal is defined from here.
  action loopStart: bool = all {
    handlerGate,
    busy, not(settling), starting == "", not(inLoop),
    inLoop' = true,
    // Pi emits agent_start; the shell-jobs handler runs as its own step.
    startDue' = true, armed' = armed,
    busy' = busy, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, reloading' = reloading, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = settleWaits,
    binding' = binding, lastBinding' = lastBinding, keepRest, held' = held, keepMode,
  }

  // The agent loop ends: no message waits in the queue, or the run was
  // aborted (agent-loop.js runLoop). The run is still active: Pi runs
  // _handlePostAgentRun and the agent_before_settle handlers, which may
  // start another loop for a message that came in meanwhile.
  action loopEnd: bool = all {
    handlerGate,
    keepRetry,
    inLoop,
    abortRequested or queue.length() == 0,
    firstMsg == "",
    inLoop' = false,
    busy' = busy, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, reloading' = reloading, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = settleWaits,
    binding' = binding, lastBinding' = lastBinding, keepRest, held' = held, keepMode,
  }

  // The retry timer fires (lib/shell-jobs-delivery.ts waitForGap): it disarms
  // and flushes, and a flush in a gap arms it again. A parked binding's timer
  // does nothing, so reloadPark disarms it.
  action retryFire: bool = {
    val flushed = flushIn(binding, outbox)
    all {
      GAP_WAIT,
      handlerGate,
      armed,
      binding != 0,
      reading' = flushed._1,
      armed' = if (gapNow and outbox.exists(j => not(reading.contains((j, binding))))) true else false,
      startDue' = startDue,
      jobs' = jobs, outbox' = outbox, settleWaits' = settleWaits,
      binding' = binding, lastBinding' = lastBinding,
      keepPi, keepRest, held' = held, keepMode,
    }
  }

  // The shell-jobs agent_start handler flushes the outbox
  // (extensions/shell-jobs.ts agent_start). Other extensions' handlers can run
  // first, so it is a step of its own; the loop may have ended by then.
  action agentStartFlush: bool = {
    val flushed = flushIn(binding, outbox)
    all {
      GAP_WAIT,
      handlerGate,
      startDue,
      startDue' = false,
      reading' = flushed._1,
      armed' = flushed._2,
      jobs' = jobs, outbox' = outbox, settleWaits' = settleWaits,
      binding' = binding, lastBinding' = lastBinding,
      keepPi, keepRest, held' = held, keepMode,
    }
  }

  // A run fails in _prepareRun after before_agent_start (an error in a
  // handler's result, the prompt images or the tool loadout): _startRun
  // clears _isAgentRunActive and throws, with no agent_settled
  // (agent-session.js _startRun). The run's first message never lands. A
  // run that a deferred action started throws out of the deferred loop, so
  // Pi drops the deferred actions after it too: that needs DEFERRED_THROWS.
  // _checkCompaction, before before_agent_start, catches its errors.
  action startFails: bool = all {
    handlerGate,
    busy, not(inLoop), not(settling), starting == "",
    firstMsg == "" or RUN_START_FAILS,
    not(loopRun) or DEFERRED_THROWS,
    busy' = false,
    abortRequested' = false,
    firstMsg' = "",
    later' = if (loopRun) [] else later,
    loopRun' = false,
    inLoop' = inLoop, settling' = settling, handlerDue' = handlerDue, deferred' = deferred,
    reloading' = reloading, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = settleWaits,
    binding' = binding, lastBinding' = lastBinding, keepRest, held' = held, keepRetry,
    settleAborted' = settleAborted, starting' = starting,
  }

  // The run ends: all its messages are in, or it was aborted, and the
  // messages that it did not take stay in the queue. _startRun's finally calls
  // _emitAgentSettled: the run is inactive and the handlers start
  // (agent-session.js:683-688, 1471). The event's `aborted` is
  // _agentRunAbortRequested; the next _startRun resets it.
  action runEnds: bool = all {
    handlerGate,
    keepRetry,
    busy,
    not(settling),
    abortRequested or queue.length() == 0,
    // An abort during _prepareRun still lets the run start (agent_start then aborts it).
    starting == "",
    // The run ends after its last agent loop, which took its first message.
    not(inLoop),
    firstMsg == "",
    busy' = false,
    inLoop' = false,
    settling' = true,
    handlerDue' = true,
    settleAborted' = abortRequested,
    abortRequested' = false,
    queue' = queue, runs' = runs,
    deferred' = deferred, later' = later, loopRun' = loopRun, reloading' = reloading, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = settleWaits,
    binding' = binding, lastBinding' = lastBinding, kill' = kill, sends' = sends, reloads' = reloads,
    landedParked' = landedParked, held' = held, stuckAtSettle' = stuckAtSettle,
    starting' = starting, firstMsg' = firstMsg,
  }

  // The shell-jobs agent_settled handler runs (extensions/shell-jobs.ts:856-858).
  // Handlers of extensions loaded before it may run first and await, so other
  // segments can come between runEnds and this one (runner.js emit, :813-838).
  action settleHandler: bool = {
    val released = releaseHeld(held, settleAborted)
    all {
    keepRetry,
      settling, handlerDue,
      handlerDue' = false,
      if (binding != 0) reconcileAndFlush(binding, true, released)
      else all { jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = Set(), held' = held },
      stuckAtSettle' = if (binding != 0 and not(settleAborted))
        stuckAtSettle.union(JOBS.filter(j => released.get(j) != "none" and history.get(j) == 0 and not(piHolds(j))))
        else stuckAtSettle,
      busy' = busy, inLoop' = inLoop, settling' = settling, deferred' = deferred, later' = later, loopRun' = loopRun,
      reloading' = reloading, queue' = queue, history' = history,
      binding' = binding, lastBinding' = lastBinding,
      kill' = kill, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked, keepMode,
    }
  }

  // The shell-jobs handler returned once its reads were done; the handlers of
  // other extensions can take longer. Then Pi runs the deferred actions one at
  // a time: `for (const action of deferred) await action()` (agent-session.js:695-699).
  // Each one starts a run whose own agent_settled runs inside that await, so the
  // deferred actions of the nested emission go before the outer ones.
  action settleEnds: bool = {
    val items = deferred.concat(later)
    all {
    keepRetry,
      handlerGate,
      settling, not(handlerDue),
      settleWaits.intersect(reading) == Set(),
      settling' = false,
      settleWaits' = Set(),
      deferred' = [],
      if (items == []) all { busy' = false, queue' = queue, later' = [], loopRun' = false, starting' = "", firstMsg' = "" }
      else all {
        busy' = true,
        loopRun' = true,
        queue' = queue,
        firstMsg' = if (items.head() == PROMPT) "" else items.head(),
        later' = items.tail(),
        // A deferred send calls sendCustomMessage again, which calls _startRun
        // with the message as its trigger (agent-session.js sendCustomMessage).
        starting' = if (items.head() == PROMPT) "" else items.head(),
      },
      handlerDue' = false, reloading' = reloading, history' = history,
      // A deferred send starts its run in _prepareRun, with no agent loop yet.
      inLoop' = false,
      jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
      keepRest, held' = held, settleAborted' = settleAborted, abortRequested' = abortRequested,
    }
  }

  // A deferred action throws where settleEnds would start it: Pi drops it
  // and all the deferred actions after it, of this loop and the outer ones.
  action deferredThrows: bool = all {
    keepRetry,
    DEFERRED_THROWS,
    handlerGate,
    settling, not(handlerDue),
    settleWaits.intersect(reading) == Set(),
    deferred.concat(later) != [],
    settling' = false, settleWaits' = Set(), deferred' = [], later' = [],
    busy' = false, inLoop' = false, loopRun' = false, starting' = "", firstMsg' = firstMsg,
    handlerDue' = false, reloading' = reloading, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepRest, held' = held, settleAborted' = settleAborted, abortRequested' = abortRequested,
  }

  // The shell-jobs before_agent_start handler sees the completion that starts
  // the run (extensions/shell-jobs.ts, noteRunStart in lib/shell-jobs-delivery.ts).
  // The message lands when the run starts, or the start failed. Pi emits the
  // event to the current runner, so a parked runtime sees nothing.
  action beforeAgentStart: bool = all {
    handlerGate,
    keepRetry,
    starting != "",
    held' = if (binding != 0 and held.get(starting) == "pending") held.set(starting, "steered") else held,
    starting' = "", firstMsg' = firstMsg,
    settleAborted' = settleAborted, abortRequested' = abortRequested,
    keepPi, keepRest,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits,
  }

  // The user sends a prompt. While agent_settled handlers run, Pi defers it
  // (agent-session.js:1631-1634); otherwise it starts a run.
  action userPrompt: bool = all {
    handlerGate,
    keepRetry,
    not(busy), runs < MAX_RUNS,
    runs' = runs + 1,
    if (settling) all { deferred' = deferred.append(PROMPT), busy' = busy }
    else all { deferred' = deferred, busy' = true },
    inLoop' = inLoop,
    settling' = settling, handlerDue' = handlerDue, later' = later, loopRun' = loopRun,
    reloading' = reloading, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads, landedParked' = landedParked,
    stuckAtSettle' = stuckAtSettle, held' = held, keepMode,
  }

  // /reload checks isStreaming (interactive-mode.js:5329), then awaits
  // (process.nextTick at :5350, session_shutdown handlers of earlier
  // extensions, agent-session.js:3001) before shell-jobs parks.
  action reloadRequest: bool = all {
    handlerGate,
    keepRetry,
    binding != 0, not(busy), not(reloading), reloads < MAX_RELOADS,
    reloading' = true, reloads' = reloads + 1,
    busy' = busy, inLoop' = inLoop, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, runs' = runs, landedParked' = landedParked,
    stuckAtSettle' = stuckAtSettle, held' = held, keepMode,
  }

  // session_shutdown with reason "reload": parkForReload (lib/shell-jobs-process.ts:199-200).
  // Pi emits agent_settled to the handlers of the runner that started the
  // emission (runner.js:87-88). After the park, the old shell-jobs handler sees
  // active false (extensions/shell-jobs.ts:862) and does nothing, so a handler
  // that has not run yet is gone.
  action reloadPark: bool = all {
    // The parked binding's timer finds runtime.delivery changed and does nothing.
    armed' = false, startDue' = startDue,
    handlerGate,
    reloading,
    binding' = 0, reloading' = false,
    busy' = busy, inLoop' = inLoop, settling' = settling, handlerDue' = false, deferred' = deferred, later' = later,
    loopRun' = loopRun, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, lastBinding' = lastBinding,
    settleWaits' = settleWaits, keepRest, held' = held, keepMode,
  }

  // session_start of the reloaded extension: attachDelivery, then reconcile and
  // flush (extensions/shell-jobs.ts:818-835). reconcile returns at once while
  // Pi is not idle, and the handler then flushes alone.
  action sessionStart: bool = all {
    handlerGate,
    binding == 0,
    val b = lastBinding + 1
    all {
      binding' = b,
      lastBinding' = b,
      // runtime.held survives the reload; session_start releases nothing.
      if (piIdle) all { reconcileAndFlush(b, false, held), armed' = armed }
      else all {
        jobs' = jobs, outbox' = outbox, settleWaits' = settleWaits, held' = held,
        // The fallback flush of the session_start handler, with the gap check.
        val flushed = flushIn(b, outbox)
        all { reading' = flushed._1, armed' = flushed._2 },
      },
      startDue' = startDue,
    },
    keepPi, keepRest, keepMode,
  }

  action step = any {
    nondet j = JOBS.oneOf()
    any { finishStart(j), finishEnd(j), killStart(j), killAnswer(j), killTimeout(j) },
    readSome,
    piDeliver,
    runEnds,
    abortRequest(true),
    abortRequest(false),
    loopStart,
    loopEnd,
    agentStartFlush,
    retryFire,
    startFails,
    settleHandler,
    settleEnds,
    deferredThrows,
    beforeAgentStart,
    userPrompt,
    reloadRequest,
    reloadPark,
    sessionStart,
  }

  // ---- Properties ----

  // The tool promise: "One completion message per job is delivered
  // automatically, except for killed jobs." (extensions/shell-jobs.ts:708)
  val oneCompletion = JOBS.forall(j => history.get(j) <= 1)

  // Pi never holds a second copy of a job's message, also before it lands:
  // the copies in the session, the run's queue and the deferred actions.
  val oneCopy = JOBS.forall(j =>
    history.get(j) + count(queue, j) + count(deferred, j) + count(later, j) + (if (firstMsg == j) 1 else 0) <= 1)

  // A "pending" hold never outlives Pi's copy of the message. Pi loses a
  // copy only from the queue (an Esc), and a pending hold has its copy in the
  // deferred actions or as the message that starts a run, so it cannot stay
  // held with no end. The code before the fix has no holds.
  val noStuckHold = HELD_GUARD implies JOBS.forall(j =>
    (held.get(j) == "pending" and history.get(j) == 0) implies piHolds(j))

  // No hold lives past one agent_settled of a run with no abort while Pi has
  // no copy of it: that settle releases it, and reconcile sends it again. In
  // the faithful model noStuckHold breaks first for a "pending" hold, so this
  // one guards the release in settleDeliveries (mutant-release-never).
  val noHoldPastSettle = HELD_GUARD implies stuckAtSettle == Set()

  // A completion that waits in the outbox always has a way out: a read in
  // flight, an armed retry timer, an agent_start handler still to run, or a
  // run or agent_settled that will flush the outbox. Without it a waiting
  // completion could stay unsent with no end.
  val outboxMoves = binding != 0 implies outbox.forall(j =>
    reading.contains((j, binding)) or armed or startDue or busy or settling)

  // A kill that answered "stopped" never gets a completion message.
  val stoppedMeansSilent = JOBS.forall(j => kill.get(j) == "stopped" implies sends.get(j) == 0)

  // Delivery is bounded at MAX_COMPLETION_ATTEMPTS sends.
  val boundedSends = JOBS.forall(j => sends.get(j) <= MAX_ATTEMPTS)

  // A job is marked delivered only when its message is in the session.
  val deliveredMeansSeen = JOBS.forall(j => jobs.get(j).delivered implies history.get(j) >= 1)

  // Each counted attempt is one send, or one entry in the outbox that waits
  // for its send: "Neither consumes another delivery attempt here."
  // (lib/shell-jobs-delivery.ts:130-132). The widget and the 3-attempt cap
  // read attempts as sends.
  val attemptsCountSends = JOBS.forall(j =>
    jobs.get(j).attempts == sends.get(j) + (if (outbox.contains(j)) 1 else 0))

  // ---- Witnesses ----
  // Each is false in a state that random traces rarely reach. `fv.mjs traces`
  // asks the simulator for a run that breaks it, so the conformance replay
  // covers that branch of the code too.

  // The attempt cap: a job is marked "not delivered" (lib/shell-jobs-delivery.ts:133-137).
  val witnessNoFailed = JOBS.forall(j => not(jobs.get(j).failed))

  // A message lands while the runtime is parked, so only the history lookup
  // of the next reconcile can acknowledge it (lib/shell-jobs-delivery.ts:125-129).
  // The witness ends after the reload attached again.
  val witnessNoLandingWhileParked = landedParked == Set() or binding == 0

  // An abort kept a message in the queue, and agent_settled ended with no run
  // to take it, so the reconcile ran while the message waited.
  val witnessNoKeptQueue = busy or settling or queue == []

  // A settled run released a "run" send that did not land, and the job was sent again.
  val witnessNoResend = JOBS.forall(j => sends.get(j) < 2)

  // A nested agent_settled is about to reconcile while a deferred send of the
  // outer emission is still held (the F2a schedule).
  val witnessNoHeldDeferredInLoop = not(JOBS.exists(j => held.get(j) == "pending" and loopRun and handlerDue and count(later, j) > 0))

  // A tail read ended in a gap of a run, and the send waits in the outbox.
  val witnessNoGapWait = not(JOBS.exists(j =>
    binding != 0 and busy and not(inLoop) and outbox.contains(j) and not(reading.contains((j, binding))) and jobs.get(j).attempts > 0))

  // A send went into a run whose abort was requested after a clear of the queue.
  val witnessNoSendAfterAbort = not(JOBS.exists(j => held.get(j) == "steered" and abortRequested and count(queue, j) > 0))

  val safety = oneCompletion and oneCopy and stoppedMeansSilent and boundedSends and deliveredMeansSeen and attemptsCountSends and noStuckHold and noHoldPastSettle and outboxMoves
}
