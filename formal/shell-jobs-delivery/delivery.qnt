// Shell job completion delivery: a model of how a finished job's completion
// message reaches the conversation, across Pi runs, aborts, agent_settled and
// /reload. Each action is one synchronous segment of the code (the code between
// two awaits), so the checker tries every order in which the event loop can run
// them. The file:line comments name the code each action stands for.
//
// Code: lib/shell-jobs-delivery.ts, extensions/shell-jobs.ts (finalize, the
// message_end, agent_settled and session_start handlers), lib/shell-jobs-manage.ts
// (stopJob), lib/shell-jobs-process.ts (parkForReload).
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

  // In the TUI, every abort clears the queues first: Esc, tree navigation
  // (interactive-mode.js:4648-4649) and ctx.abort() through the TUI's
  // abortHandler (interactive-mode.js:1479-1480, agent-session.js:2819-2824)
  // all call clearAllQueues (:3853). The RPC abort (rpc-mode.js:328), and
  // ctx.abort() in a mode with no abortHandler (RPC, print, SDK), call
  // AgentSession.abort() (agent-session.js:1971-1983) alone. It and
  // Agent.abort() (agent.js:221-222) leave the queue, and the next run takes
  // it (agent.js:263, :340). The variant that assumes the TUI sets this to false.
  pure val ABORT_KEEPS_QUEUE = true

  // An extension loaded before shell-jobs can have an agent_settled handler
  // that awaits I/O, so other segments can run before the shell-jobs handler.
  // The variant that assumes no such extension sets this to false.
  pure val OTHER_HANDLERS_FIRST = true

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

  // ---- Helpers that copy one piece of code each ----

  // flush(), lib/shell-jobs-delivery.ts:43-53: start a read for each outbox id
  // that has none in flight in this binding.
  pure def flushReads(b: int, box: Set[str], inFlight: Set[(str, int)]): Set[(str, int)] =
    if (b == 0) inFlight else inFlight.union(box.map(j => (j, b)))

  // acknowledgeCompletion, lib/shell-jobs-delivery.ts:32-38.
  pure def acked(job: Job): Job =
    if (job.delivered and not(job.failed)) job else { ...job, delivered: true, failed: false }

  // The loop of reconcileDeliveries, lib/shell-jobs-delivery.ts:123-143, for one job.
  pure def reconcileJob(job: Job, inHistory: bool, inOutbox: bool): (Job, bool) =
    if (job.phase != "done" or job.delivered or job.attempts == 0) (job, inOutbox)
    else if (inHistory) (acked(job), false)
    else if (inOutbox) (job, inOutbox)
    else if (job.attempts >= MAX_ATTEMPTS) ({ ...job, failed: true }, inOutbox)
    else ({ ...job, attempts: job.attempts + 1 }, true)

  // With no other extension first, nothing runs between runEnds and settleHandler.
  val handlerGate = not(handlerDue) or OTHER_HANDLERS_FIRST

  // ctx.isIdle() as Pi computes it.
  val piIdle = all {
    not(busy),
    not(IDLE_COUNTS_DEFERRED) or (deferred == [] and later == [] and not(loopRun)),
    not(IDLE_COUNTS_QUEUE) or queue == [],
  }

  // reconcileDeliveries and its flush. It returns at once while Pi is not idle
  // (lib/shell-jobs-delivery.ts:121), with no flush.
  action reconcileAndFlush(b: int, awaited: bool): bool = {
    val results = JOBS.mapBy(j => reconcileJob(jobs.get(j), history.get(j) > 0, outbox.contains(j)))
    val box = JOBS.filter(j => results.get(j)._2)
    if (piIdle) all {
      jobs' = JOBS.mapBy(j => results.get(j)._1),
      outbox' = box,
      reading' = flushReads(b, box, reading),
      // The agent_settled handler awaits every read of the outbox ids.
      settleWaits' = if (awaited) box.map(j => (j, b)) else settleWaits,
    } else all {
      jobs' = jobs, outbox' = outbox, reading' = reading,
      settleWaits' = if (awaited) Set() else settleWaits,
    }
  }

  // pi.sendMessage with triggerTurn and deliverAs "steer" (sendCustomMessage,
  // agent-session.js:1844-1872): steer into the active run, wait while
  // agent_settled handlers run, or start a run.
  action piSend(j: str): bool = all {
    sends' = sends.setBy(j, n => n + 1),
    if (settling) all { deferred' = deferred.append(j), queue' = queue, busy' = busy }
    else all { deferred' = deferred, queue' = queue.append(j), busy' = true },
  }

  action keepPi = all {
    busy' = busy, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, reloading' = reloading, queue' = queue, history' = history,
  }
  action keepRest = all { kill' = kill, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked }

  // ---- Init ----

  action init = all {
    jobs' = JOBS.mapBy(_ => { phase: "running", claimed: false, attempts: 0, delivered: false, failed: false }),
    outbox' = Set(),
    reading' = Set(),
    binding' = 1,
    lastBinding' = 1,
    nondet b = Set(true, false).oneOf()
    busy' = b,
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
  }

  // ---- Job actions ----

  // The process exits; finalize sets "stopping" and awaits the group cleanup
  // (extensions/shell-jobs.ts:181-190).
  action finishStart(j: str): bool = all {
    handlerGate,
    jobs.get(j).phase == "running",
    jobs' = jobs.setBy(j, job => { ...job, phase: "exiting" }),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, keepRest,
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
      reading' = if (suppressed) reading else flushReads(binding, box, reading),
      binding' = binding, lastBinding' = lastBinding,
      keepPi, settleWaits' = settleWaits, keepRest,
    }
  }

  // shell_job kill: stopJob claims the job and waits (lib/shell-jobs-manage.ts:148-152).
  action killStart(j: str): bool = all {
    handlerGate,
    jobs.get(j).phase != "done",
    kill.get(j) == "none",
    jobs' = jobs.setBy(j, job => { ...job, claimed: true }),
    kill' = kill.set(j, "waiting"),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked,
  }

  // The final status arrives within KILL_WAIT_MS: the tool answers "stopped"
  // (lib/shell-jobs-manage.ts:153-159). finalize resolves finals before any
  // timer can run, so this wins over the timeout once the job is done.
  action killAnswer(j: str): bool = all {
    handlerGate,
    kill.get(j) == "waiting",
    jobs.get(j).phase == "done",
    kill' = kill.set(j, "stopped"),
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked,
  }

  // The wait times out: stopJob clears the claim and promises a completion
  // message (lib/shell-jobs-manage.ts:160-167).
  action killTimeout(j: str): bool = all {
    handlerGate,
    kill.get(j) == "waiting",
    jobs.get(j).phase != "done",
    jobs' = jobs.setBy(j, job => { ...job, claimed: false }),
    kill' = kill.set(j, "stillStopping"),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs, landedParked' = landedParked,
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
      reading' = reading.exclude(Set((j, b))),
      settleWaits' = settleWaits.exclude(Set((j, b))),
      binding' = binding, lastBinding' = lastBinding,
      kill' = kill, reloads' = reloads, runs' = runs, landedParked' = landedParked,
      history' = history, settling' = settling, handlerDue' = handlerDue, later' = later,
      loopRun' = loopRun, reloading' = reloading,
      if (binding != b or not(outbox.contains(j)))
        // The binding changed during the read: leave the entry for the new one.
        all { jobs' = jobs, outbox' = outbox, sends' = sends, deferred' = deferred, queue' = queue, busy' = busy }
      else if (job.delivered or job.claimed)
        all { jobs' = jobs, outbox' = outbox.exclude(Set(j)), sends' = sends, deferred' = deferred, queue' = queue, busy' = busy }
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
    // Only an active run takes queued messages; after an abort that kept
    // them, they wait for the next run.
    busy,
    queue.length() > 0,
    val j = queue.head()
    all {
      history' = history.setBy(j, n => n + 1),
      queue' = queue.tail(),
      jobs' = if (binding != 0) jobs.setBy(j, acked) else jobs,
      outbox' = if (binding != 0) outbox.exclude(Set(j)) else outbox,
      landedParked' = if (binding == 0) landedParked.union(Set(j)) else landedParked,
    },
    busy' = busy, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, reloading' = reloading,
    reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads, runs' = runs,
  }

  // The run ends (all its messages are in), or it is aborted. An abort with
  // clear drops the messages that the run did not take (Esc: clearQueue,
  // interactive-mode.js:3853); one without clear keeps them for the next run.
  // _startRun's finally calls _emitAgentSettled: the run is inactive and the
  // handlers start (agent-session.js:683-688, 1471).
  // An abort without clear is the RPC abort, or ctx.abort() in a mode with no abortHandler.
  action runEnds(abort: bool, clear: bool): bool = all {
    handlerGate,
    clear or (abort and ABORT_KEEPS_QUEUE),
    busy,
    not(settling),
    abort or queue.length() == 0,
    abort implies runs < MAX_RUNS,
    busy' = false,
    settling' = true,
    handlerDue' = true,
    queue' = if (clear) [] else queue,
    runs' = if (abort) runs + 1 else runs,
    deferred' = deferred, later' = later, loopRun' = loopRun, reloading' = reloading, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = settleWaits,
    binding' = binding, lastBinding' = lastBinding, kill' = kill, sends' = sends, reloads' = reloads,
    landedParked' = landedParked,
  }

  // The shell-jobs agent_settled handler runs (extensions/shell-jobs.ts:856-858).
  // Handlers of extensions loaded before it may run first and await, so other
  // segments can come between runEnds and this one (runner.js emit, :813-838).
  action settleHandler: bool = all {
    settling, handlerDue,
    handlerDue' = false,
    if (binding != 0) reconcileAndFlush(binding, true)
    else all { jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = Set() },
    busy' = busy, settling' = settling, deferred' = deferred, later' = later, loopRun' = loopRun,
    reloading' = reloading, queue' = queue, history' = history,
    binding' = binding, lastBinding' = lastBinding, keepRest,
  }

  // The shell-jobs handler returned once its reads were done; the handlers of
  // other extensions can take longer. Then Pi runs the deferred actions one at
  // a time: `for (const action of deferred) await action()` (agent-session.js:695-699).
  // Each one starts a run whose own agent_settled runs inside that await, so the
  // deferred actions of the nested emission go before the outer ones.
  action settleEnds: bool = {
    val items = deferred.concat(later)
    all {
      handlerGate,
      settling, not(handlerDue),
      settleWaits.intersect(reading) == Set(),
      settling' = false,
      settleWaits' = Set(),
      deferred' = [],
      if (items == []) all { busy' = false, queue' = queue, later' = [], loopRun' = false }
      else all {
        busy' = true,
        loopRun' = true,
        queue' = if (items.head() == PROMPT) queue else queue.append(items.head()),
        later' = items.tail(),
      },
      handlerDue' = false, reloading' = reloading, history' = history,
      jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
      keepRest,
    }
  }

  // The user sends a prompt. While agent_settled handlers run, Pi defers it
  // (agent-session.js:1631-1634); otherwise it starts a run.
  action userPrompt: bool = all {
    handlerGate,
    not(busy), runs < MAX_RUNS,
    runs' = runs + 1,
    if (settling) all { deferred' = deferred.append(PROMPT), busy' = busy }
    else all { deferred' = deferred, busy' = true },
    settling' = settling, handlerDue' = handlerDue, later' = later, loopRun' = loopRun,
    reloading' = reloading, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads, landedParked' = landedParked,
  }

  // /reload checks isStreaming (interactive-mode.js:5329), then awaits
  // (process.nextTick at :5350, session_shutdown handlers of earlier
  // extensions, agent-session.js:3001) before shell-jobs parks.
  action reloadRequest: bool = all {
    handlerGate,
    binding != 0, not(busy), not(reloading), reloads < MAX_RELOADS,
    reloading' = true, reloads' = reloads + 1,
    busy' = busy, settling' = settling, handlerDue' = handlerDue, deferred' = deferred, later' = later,
    loopRun' = loopRun, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, runs' = runs, landedParked' = landedParked,
  }

  // session_shutdown with reason "reload": parkForReload (lib/shell-jobs-process.ts:199-200).
  // Pi emits agent_settled to the handlers of the runner that started the
  // emission (runner.js:87-88). After the park, the old shell-jobs handler sees
  // active false (extensions/shell-jobs.ts:862) and does nothing, so a handler
  // that has not run yet is gone.
  action reloadPark: bool = all {
    handlerGate,
    reloading,
    binding' = 0, reloading' = false,
    busy' = busy, settling' = settling, handlerDue' = false, deferred' = deferred, later' = later,
    loopRun' = loopRun, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, lastBinding' = lastBinding,
    settleWaits' = settleWaits, keepRest,
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
      if (piIdle) reconcileAndFlush(b, false)
      else all { jobs' = jobs, outbox' = outbox, reading' = flushReads(b, outbox, reading), settleWaits' = settleWaits },
    },
    keepPi, keepRest,
  }

  action step = any {
    nondet j = JOBS.oneOf()
    any { finishStart(j), finishEnd(j), killStart(j), killAnswer(j), killTimeout(j) },
    readSome,
    piDeliver,
    runEnds(false, true),
    runEnds(true, true),
    runEnds(true, false),
    settleHandler,
    settleEnds,
    userPrompt,
    reloadRequest,
    reloadPark,
    sessionStart,
  }

  // ---- Properties ----

  // The tool promise: "One completion message per job is delivered
  // automatically, except for killed jobs." (extensions/shell-jobs.ts:708)
  val oneCompletion = JOBS.forall(j => history.get(j) <= 1)

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

  val safety = oneCompletion and stoppedMeansSilent and boundedSends and deliveredMeansSeen and attemptsCountSends
}
