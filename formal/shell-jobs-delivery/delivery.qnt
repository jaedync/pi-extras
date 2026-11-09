// Shell job completion delivery: a model of how a finished job's completion
// message reaches the conversation, across Pi runs, aborts, agent_settled and
// /reload. Each action is one synchronous segment of the code (the code between
// two awaits), so the checker tries every order in which the event loop can run
// them. The file:line comments name the code each action stands for.
//
// Code: lib/shell-jobs-delivery.ts, extensions/shell-jobs.ts (finalize, the
// message_end, agent_settled and session_start handlers), lib/shell-jobs-manage.ts
// (stopJob), lib/shell-jobs-process.ts (parkForReload).
// Pi (1.4.0 and 1.5.0): core/agent-session.js sendCustomMessage, _emitAgentSettled,
// isIdle, isStreaming; modes/interactive/interactive-mode.js handleReloadCommand.
module delivery {
  // Bounds. A pass covers only these sizes. See README.md for what they leave out.
  pure val JOBS = Set("j1", "j2")
  pure val MAX_ATTEMPTS = 3   // MAX_COMPLETION_ATTEMPTS, lib/shell-jobs-delivery.ts:7
  pure val MAX_RELOADS = 1
  pure val MAX_RUNS = 2       // runs that the user starts or aborts

  // Pi lets /reload run while agent_settled handlers still run, because
  // handleReloadCommand checks only isStreaming. The variant that assumes
  // otherwise sets this to false.
  pure val RELOAD_DURING_SETTLE = true

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
  var busy: bool               // isStreaming: an agent run is active
  var settling: bool           // _isEmittingAgentSettled
  var settleWaits: Set[(str, int)]  // reads that the shell-jobs agent_settled handler awaits
  var deferred: List[str]      // _deferredSettledActions holding sendCustomMessage calls
  var queue: List[str]         // messages of the run that are not in the session yet
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

  // The loop of reconcileDeliveries, lib/shell-jobs-delivery.ts:126-143, for one job.
  pure def reconcileJob(job: Job, inHistory: bool, inOutbox: bool): (Job, bool) =
    if (job.phase != "done" or job.delivered or job.attempts == 0) (job, inOutbox)
    else if (inHistory) (acked(job), false)
    else if (inOutbox) (job, inOutbox)
    else if (job.attempts >= MAX_ATTEMPTS) ({ ...job, failed: true }, inOutbox)
    else ({ ...job, attempts: job.attempts + 1 }, true)

  // reconcileDeliveries with its flush. It runs only while Pi is idle
  // (ctx.isIdle(), lib/shell-jobs-delivery.ts:125) and attached.
  action reconcileAndFlush(b: int, extraSettle: bool): bool = {
    val results = JOBS.mapBy(j => reconcileJob(jobs.get(j), history.get(j) > 0, outbox.contains(j)))
    val box = JOBS.filter(j => results.get(j)._2)
    all {
      jobs' = JOBS.mapBy(j => results.get(j)._1),
      outbox' = box,
      reading' = flushReads(b, box, reading),
      // The agent_settled handler awaits every read of the outbox ids.
      settleWaits' = if (extraSettle) box.map(j => (j, b)) else settleWaits,
    }
  }

  // pi.sendMessage with triggerTurn and deliverAs "steer" (sendCustomMessage).
  // While agent_settled handlers run, Pi defers the call (agent-session.js
  // sendCustomMessage, the _isEmittingAgentSettled branch).
  action piSend(j: str): bool = all {
    sends' = sends.setBy(j, n => n + 1),
    if (settling) all { deferred' = deferred.append(j), queue' = queue, busy' = busy }
    else all { deferred' = deferred, queue' = queue.append(j), busy' = true },
  }

  action keepPi = all { busy' = busy, settling' = settling, deferred' = deferred, queue' = queue, history' = history }

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
    settleWaits' = Set(),
    deferred' = [],
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
    jobs.get(j).phase == "running",
    jobs' = jobs.setBy(j, job => { ...job, phase: "exiting" }),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads, runs' = runs,
  }

  // finalize after its awaits: re-read the job, decide suppression, record the
  // attempt, add to the outbox and flush (extensions/shell-jobs.ts:193-214).
  action finishEnd(j: str): bool = {
    val job = jobs.get(j)
    val suppressed = job.claimed or job.delivered
    val box = if (suppressed) outbox else outbox.union(Set(j))
    all {
      job.phase == "exiting",
      jobs' = jobs.set(j, { ...job, phase: "done", attempts: if (suppressed) job.attempts else job.attempts + 1 }),
      outbox' = box,
      reading' = if (suppressed) reading else flushReads(binding, box, reading),
      binding' = binding, lastBinding' = lastBinding,
      keepPi, settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads, runs' = runs,
    }
  }

  // shell_job kill: stopJob claims the job and waits (lib/shell-jobs-manage.ts:148-152).
  action killStart(j: str): bool = all {
    jobs.get(j).phase != "done",
    kill.get(j) == "none",
    jobs' = jobs.setBy(j, job => { ...job, claimed: true }),
    kill' = kill.set(j, "waiting"),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs,
  }

  // The final status arrives within KILL_WAIT_MS: the tool answers "stopped"
  // (lib/shell-jobs-manage.ts:153-159). finalize resolves finals before any
  // timer can run, so this wins over the timeout once the job is done.
  action killAnswer(j: str): bool = all {
    kill.get(j) == "waiting",
    jobs.get(j).phase == "done",
    kill' = kill.set(j, "stopped"),
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs,
  }

  // The wait times out: stopJob clears the claim and promises a completion
  // message (lib/shell-jobs-manage.ts:160-167).
  action killTimeout(j: str): bool = all {
    kill.get(j) == "waiting",
    jobs.get(j).phase != "done",
    jobs' = jobs.setBy(j, job => { ...job, claimed: false }),
    kill' = kill.set(j, "stillStopping"),
    outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    keepPi, settleWaits' = settleWaits, sends' = sends, reloads' = reloads, runs' = runs,
  }

  // ---- Delivery ----

  // sendCompletion after `await readTail` (lib/shell-jobs-delivery.ts:66-108).
  action readDone(j: str, b: int): bool = {
    val job = jobs.get(j)
    val reads = reading.exclude(Set((j, b)))
    val waits = settleWaits.exclude(Set((j, b)))
    all {
      reading.contains((j, b)),
      reading' = reads,
      binding' = binding, lastBinding' = lastBinding, kill' = kill, reloads' = reloads, runs' = runs,
      settleWaits' = waits, history' = history, settling' = settling,
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
    queue.length() > 0,
    val j = queue.head()
    all {
      history' = history.setBy(j, n => n + 1),
      queue' = queue.tail(),
      jobs' = if (binding != 0) jobs.setBy(j, acked) else jobs,
      outbox' = if (binding != 0) outbox.exclude(Set(j)) else outbox,
    },
    busy' = busy, settling' = settling, deferred' = deferred,
    reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads, runs' = runs,
  }

  // The run ends (all its messages are in) or the user aborts it (Pi drops the
  // queued messages). Pi sets the run inactive and emits agent_settled; the
  // shell-jobs handler reconciles and flushes (extensions/shell-jobs.ts:856-858).
  action runEnds(abort: bool): bool = all {
    busy,
    not(settling),
    abort or queue.length() == 0,
    abort implies runs < MAX_RUNS,
    busy' = false,
    settling' = true,
    queue' = [],
    deferred' = deferred, history' = history,
    runs' = if (abort) runs + 1 else runs,
    if (binding != 0) reconcileAndFlush(binding, true)
    else all { jobs' = jobs, outbox' = outbox, reading' = reading, settleWaits' = Set() },
    binding' = binding, lastBinding' = lastBinding, kill' = kill, sends' = sends, reloads' = reloads,
  }

  // The shell-jobs handler returns once its reads are done; the handlers of
  // other extensions can take longer. Then Pi runs the deferred sends: the
  // first starts a run and the others join it (_emitAgentSettled).
  action settleEnds: bool = all {
    settling,
    settleWaits.intersect(reading) == Set(),
    settling' = false,
    settleWaits' = Set(),
    deferred' = [],
    queue' = queue.concat(deferred),
    busy' = deferred.length() > 0,
    history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    kill' = kill, sends' = sends, reloads' = reloads, runs' = runs,
  }

  // The user sends a prompt while Pi is idle.
  action userPrompt: bool = all {
    not(busy), not(settling), runs < MAX_RUNS,
    busy' = true, runs' = runs + 1,
    settling' = settling, deferred' = deferred, queue' = queue, history' = history,
    jobs' = jobs, outbox' = outbox, reading' = reading, binding' = binding, lastBinding' = lastBinding,
    settleWaits' = settleWaits, kill' = kill, sends' = sends, reloads' = reloads,
  }

  // /reload: session_shutdown parks the runtime (parkForReload,
  // lib/shell-jobs-process.ts:199-200). Pi refuses only while isStreaming.
  action reloadStart: bool = all {
    binding != 0, not(busy), reloads < MAX_RELOADS,
    RELOAD_DURING_SETTLE or not(settling),
    binding' = 0, reloads' = reloads + 1,
    lastBinding' = lastBinding,
    jobs' = jobs, outbox' = outbox, reading' = reading,
    keepPi, settleWaits' = settleWaits, kill' = kill, sends' = sends, runs' = runs,
  }

  // session_start of the reloaded extension: attachDelivery, then reconcile and
  // flush (extensions/shell-jobs.ts:818-835).
  action sessionStart: bool = all {
    binding == 0,
    val b = lastBinding + 1
    all {
      binding' = b,
      lastBinding' = b,
      if (not(busy)) reconcileAndFlush(b, false)
      else all { jobs' = jobs, outbox' = outbox, reading' = flushReads(b, outbox, reading), settleWaits' = settleWaits },
    },
    keepPi, kill' = kill, sends' = sends, reloads' = reloads, runs' = runs,
  }

  action step = any {
    all {
      piDeliver,
      landedParked' = if (binding == 0) landedParked.union(Set(queue.head())) else landedParked,
    },
    all {
      landedParked' = landedParked,
      any {
        nondet j = JOBS.oneOf()
        any { finishStart(j), finishEnd(j), killStart(j), killAnswer(j), killTimeout(j) },
        readSome,
        runEnds(false),
        runEnds(true),
        settleEnds,
        userPrompt,
        reloadStart,
        sessionStart,
      },
    },
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

  val safety = oneCompletion and stoppedMeansSilent and boundedSends and deliveredMeansSeen and attemptsCountSends
}
