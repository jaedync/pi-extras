// Subagent mail to main: a model of how a child's note, relay and report
// reach main's transcript through MainMail (lib/subagents/deliver.ts), the
// Route that main-watch.ts gives, and Pi's sendCustomMessage, across main's
// turns, the settle check, agent_settled, Esc, /compact, a failed send and a
// /reload hand-over (adopt, or fall back through the index).
//
// Each action is one synchronous segment of the code (the code between two
// awaits). The file:line comments name the code each action stands for.
// Line numbers are for HEAD at the sync commit (fv.json). Pi is 1.4.0:
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
// (written "as:" below) and pi-agent-core/dist/agent-loop.js.
module mail {
  // ---- Bounds. A pass covers only these sizes (README.md). ----
  pure val MAX_PROMPTS = 1
  pure val MAX_ABORTS = 1
  pure val MAX_COMPACTIONS = 1
  pure val MAX_RELOADS = 1
  pure val MAX_FAILS = 1

  // Fix variant for finding F1: dispatch also keeps waking mail that starts
  // a turn as owed (deliver.ts:378 sets owing only for the queue route).
  pure val OWE_WAKE_MAIL = false
  // Fix variant for finding F2: a message that does not wake main, appended
  // after the stopped turn, does not count as "something said since"
  // (main-watch.ts:131 compares lastSaid with the stop mark).
  pure val QUIET_KEEPS_MARK = false

  // Mail ids. "a": a note (wakes main). "b": a relay of what the user told a
  // child (does not wake, deliver.ts:157-162). "r": the batched report
  // (wakes, deliver.ts:183-192). "rem": the hidden reminder (wakes, not kept
  // as pending, deliver.ts:322-327).
  pure val CHILD_MAIL = Set("a", "b")
  pure val REPORT = "r"
  pure val REMINDER = "rem"
  pure val IDS = Set("a", "b", "r", "rem")
  // pending-report-<name>: the widget's item for a report still batched (deliver.ts:142).
  pure val PLACEHOLDER = "pr"
  // The deferred item for a user prompt (as:1631-1634).
  pure val PROMPT = "prompt"
  pure def wakes(id: str): bool = id != "b"

  // Pi run phases. idle: no run. prep: _startRun before agent_start
  // (as:1424-1440; _prepareRun awaits compaction checks and
  // before_agent_start). work: the agent loop. bs: the agent_before_settle
  // boundary (as:1566-1592). settle: _emitAgentSettled handlers (as:683-692).
  // isStreaming and the run flag are true in prep, work and bs (as:1068-1074).
  pure def active(p: str): bool = p == "prep" or p == "work" or p == "bs"

  // ---- MainMail (lib/subagents/deliver.ts:79-100) ----
  var outbox: List[str]        // outbox, oldest first
  var pending: Set[str]        // pendingItems keys
  var owing: Set[str]          // owing keys
  var batch: bool              // the report waits in `batch`
  var batchTimer: bool         // `timer` armed
  var retryArmed: bool         // `retryTimer` armed
  var closed: bool             // `closed`
  // ---- The host and its hand-over (host-state.ts, host.ts PortBinding, serve.ts) ----
  var hostPhase: str           // "served" | "parked" | "closed" (a fallback close, before the next host opens)
  var gen: int                 // 1: the host from before the reload; 2: a new host after a fallback
  var kept: List[str]          // ChildIndex.keepMail: mail a closing host could not hand over
  // ---- main-watch.ts flags ----
  var running: bool
  var settling: bool
  var grace: bool              // now() - inputAt < INPUT_GRACE_MS (main-watch.ts:25, :151)
  var checked: bool
  var stoppedRun: bool
  var stopMark: bool           // stopMark is set and still equals lastSaid(ctx): nothing was said since
  var compactionStopped: bool
  var retrySoon: bool          // the setTimeout(retry, 0) of retrySoon (main-watch.ts:77)
  // ---- Pi ----
  var phase: str
  var ours: bool               // in bs or settle: our handler has run
  var bsContinue: bool         // our agent_before_settle handler returned { continue: true }
  var deferred: List[str]      // _deferredSettledActions of the emission now running
  var later: List[str]         // deferred actions an outer `for ... await action()` loop still holds
  var prep: List[str]          // the starting message of the run being prepared
  var pendingCustom: List[str] // _pendingCustomMessages
  var steerQ: List[str]        // the agent's steering queue
  var compacting: bool         // isCompacting
  var compactPending: bool     // a /compact waits for its abort to finish (as:2230-2232)
  var promptWaiting: bool      // a user prompt in its preflight (input handlers ran, no run yet)
  // ---- The transcript ----
  var landed: str -> int       // mail entries in main's session
  var unread: Set[str]         // in main's context after its last assistant message (owed reads it)
  // ---- Ghosts (only properties and witnesses read them) ----
  var unreplied: Set[str]      // landed since main's last reply; compaction does not clear it
  var excused: Set[str]        // landed in a run the user stopped with Esc
  var created: Set[str]        // mail that a child sent, or that the mail made
  var mine: Set[str]           // ids remembered by this MainMail instance
  var reported: bool           // the child delivered its report
  var prompts: int
  var aborts: int
  var compactions: int
  var reloads: int
  var fails: int

  // What one call of sendWaiting may change.
  type Box = {
    outbox: List[str], owing: Set[str], phase: str, prep: List[str], deferred: List[str],
    pendingCustom: List[str], steerQ: List[str], landed: str -> int, unread: Set[str],
    unreplied: Set[str], stopMark: bool, fail: bool, failed: bool, stop: bool,
  }
  // What the Route reads besides the Pi phase.
  type Where = { served: bool, compacting: bool, grace: bool, running: bool, settling: bool }

  val box0: Box = {
    outbox: outbox, owing: owing, phase: phase, prep: prep, deferred: deferred,
    pendingCustom: pendingCustom, steerQ: steerQ, landed: landed, unread: unread,
    unreplied: unreplied, stopMark: stopMark, fail: false, failed: false, stop: false,
  }
  val where0: Where = { served: hostPhase == "served", compacting: compacting, grace: grace, running: running, settling: settling }

  // The Route: PortBinding.route (host.ts:135) holds while parked or closing;
  // then watchMain's route (main-watch.ts:147-152).
  pure def routeOf(w: Where, p: str): str =
    if (not(w.served)) "hold"
    else if (not(active(p)) and not(w.compacting)) (if (w.grace) "hold" else "wake")
    else if (w.running and not(w.settling)) "queue"
    else "hold"

  // A message lands: it is appended to the session.
  pure def land(b: Box, id: str): Box =
    { ...b, landed: b.landed.setBy(id, n => n + 1), unread: b.unread.union(Set(id)),
      unreplied: b.unreplied.union(Set(id)), stopMark: b.stopMark and QUIET_KEEPS_MARK and not(wakes(id)) }
  pure def landAll(b: Box, ids: List[str]): Box = ids.foldl(b, (acc, id) => land(acc, id))

  // sendCustomMessage with triggerTurn and deliverAs "steer" (as:1855-1871):
  // steer into a run, wait while agent_settled handlers run, or start a run.
  pure def sendTurn(b: Box, id: str): Box =
    if (active(b.phase)) { ...b, steerQ: b.steerQ.append(id) }
    else if (b.phase == "settle") { ...b, deferred: b.deferred.append(id) }
    else { ...b, phase: "prep", prep: b.prep.append(id) }

  // sendCustomMessage with triggerTurn false (as:1873-1883): wait for the turn
  // end while a run is active, else append at once.
  pure def sendQuiet(b: Box, id: str): Box =
    if (active(b.phase)) { ...b, pendingCustom: b.pendingCustom.append(id) }
    else land(b, id)

  // One pass of the loop in sendWaiting (deliver.ts:253-265) with dispatch
  // (deliver.ts:375-388). `fail`: the port throws on this send (642ba00).
  pure def sendStep(w: Where, b: Box): Box =
    if (b.stop or b.outbox == []) { ...b, stop: true }
    else {
      val route = routeOf(w, b.phase)
      val id = b.outbox.head()
      if (route == "hold") { ...b, stop: true }
      else if (b.fail)
        // dispatch deletes the owed id; sendWaiting puts the item back (deliver.ts:260-262, :384-385).
        { ...b, owing: b.owing.exclude(Set(id)), fail: false, failed: true, stop: true }
      else {
        val b1 = { ...b, outbox: b.outbox.tail() }
        if (route == "wake" and wakes(id)) sendTurn(if (OWE_WAKE_MAIL) { ...b1, owing: b1.owing.union(Set(id)) } else b1, id)
        else {
          val owes = route == "queue" and wakes(id)
          val b2 = if (owes) { ...b1, owing: b1.owing.union(Set(id)) } else b1
          sendQuiet(b2, id)
        }
      }
    }
  pure def sendWaiting(w: Where, b: Box): Box = range(0, 5).foldl(b, (acc, _) => sendStep(w, acc))

  // Assigns what a sendWaiting call changed, and the retry timer it leaves
  // (deliver.ts:264: armed while mail waits).
  action applyBox(b: Box, isClosed: bool): bool = all {
    outbox' = b.outbox, owing' = b.owing, phase' = b.phase, prep' = b.prep, deferred' = b.deferred,
    pendingCustom' = b.pendingCustom, steerQ' = b.steerQ, landed' = b.landed, unread' = b.unread,
    unreplied' = b.unreplied, stopMark' = b.stopMark,
    retryArmed' = (b.outbox != [] and not(isClosed)),
    fails' = if (b.failed) fails + 1 else fails,
  }
  action keepBox: bool = all {
    outbox' = outbox, owing' = owing, phase' = phase, prep' = prep, deferred' = deferred,
    pendingCustom' = pendingCustom, steerQ' = steerQ, landed' = landed, unread' = unread,
    unreplied' = unreplied, stopMark' = stopMark, retryArmed' = retryArmed, fails' = fails,
  }

  pure def isLanded(m: str -> int, id: str): bool = IDS.contains(id) and m.get(id) > 0
  // reconcile (deliver.ts:334-343) and acknowledge (:346-348): drop pending ids found in the branch.
  pure def reconciled(p: Set[str], m: str -> int): Set[str] = p.filter(id => not(isLanded(m, id)))

  action keepMail: bool = all {
    pending' = pending, batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine,
    created' = created, reported' = reported,
  }
  action keepHost: bool = all { hostPhase' = hostPhase, gen' = gen, kept' = kept, reloads' = reloads }
  action keepWatch: bool = all {
    running' = running, settling' = settling, grace' = grace, checked' = checked, stoppedRun' = stoppedRun,
    compactionStopped' = compactionStopped, retrySoon' = retrySoon,
  }
  action keepPi: bool = all {
    ours' = ours, bsContinue' = bsContinue, later' = later, compacting' = compacting,
    compactPending' = compactPending, promptWaiting' = promptWaiting,
  }
  action keepCounts: bool = all { excused' = excused, prompts' = prompts, aborts' = aborts, compactions' = compactions }

  action init = all {
    outbox' = [], pending' = Set(), owing' = Set(), batch' = false, batchTimer' = false, retryArmed' = false, closed' = false,
    hostPhase' = "served", gen' = 1, kept' = [],
    running' = false, settling' = false, grace' = false, checked' = false, stoppedRun' = false, stopMark' = false,
    compactionStopped' = false, retrySoon' = false,
    phase' = "idle", ours' = false, bsContinue' = false, deferred' = [], later' = [], prep' = [], pendingCustom' = [],
    steerQ' = [], compacting' = false, compactPending' = false, promptWaiting' = false,
    landed' = IDS.mapBy(_ => 0), unread' = Set(), unreplied' = Set(), excused' = Set(), created' = Set(), mine' = Set(),
    reported' = false, prompts' = 0, aborts' = 0, compactions' = 0, reloads' = 0, fails' = 0,
  }

  // ---- Children ----

  // deliver() for a note or a relay: remember, then post (deliver.ts:156-167,
  // :396-399). The team closes with the host, so a closed host takes none.
  action childMail(id: str, throws: bool): bool = all {
    not(created.contains(id)), hostPhase != "closed", not(closed),
    throws implies fails < MAX_FAILS,
    pending' = pending.union(Set(id)), mine' = mine.union(Set(id)), created' = created.union(Set(id)),
    applyBox(sendWaiting(where0, { ...box0, outbox: outbox.append(id), fail: throws }), closed),
    batch' = batch, batchTimer' = batchTimer, closed' = closed, reported' = reported,
    keepHost, keepWatch, keepPi, keepCounts,
  }

  // deliver() for a report: the widget item, then the batch and its timer (deliver.ts:139-153).
  action childReport: bool = all {
    not(reported), hostPhase != "closed", not(closed),
    reported' = true,
    pending' = pending.union(Set(PLACEHOLDER)), mine' = mine.union(Set(PLACEHOLDER)),
    batch' = true, batchTimer' = true,
    closed' = closed, created' = created,
    keepBox, keepHost, keepWatch, keepPi, keepCounts,
  }

  // flush() (deliver.ts:176-186) and postReports (:189-194).
  pure def flushed(p: Set[str], m: Set[str], c: Set[str], inBatch: bool): (Set[str], Set[str], Set[str]) =
    if (inBatch) (p.exclude(Set(PLACEHOLDER)).union(Set(REPORT)), m.union(Set(REPORT)), c.union(Set(REPORT)))
    else (p.exclude(Set(PLACEHOLDER)), m, c)

  // The batch timer fires: flush.
  action batchFlush(throws: bool): bool = {
    val f = flushed(pending, mine, created, batch)
    all {
      batchTimer, not(closed),
      throws implies fails < MAX_FAILS,
      batchTimer' = false, batch' = false,
      pending' = f._1, mine' = f._2, created' = f._3,
      applyBox(sendWaiting(where0, { ...box0, outbox: if (batch) outbox.append(REPORT) else outbox, fail: throws }), closed),
      closed' = closed, reported' = reported,
      keepHost, keepWatch, keepPi, keepCounts,
    }
  }

  // The retry timer fires: retry() (deliver.ts:244-249).
  action retryFire(throws: bool): bool = all {
    retryArmed, not(closed),
    throws implies fails < MAX_FAILS,
    applyBox(sendWaiting(where0, { ...box0, fail: throws }), closed),
    keepMail, keepHost, keepWatch, keepPi, keepCounts,
  }

  // retrySoon's timer fires: `mail()?.retry()`; host() is null unless a module serves it (main-watch.ts:75-77).
  action retrySoonFire: bool = all {
    retrySoon,
    retrySoon' = false,
    if (hostPhase == "served" and not(closed)) applyBox(sendWaiting(where0, box0), closed) else keepBox,
    keepMail, keepHost, keepPi, keepCounts,
    running' = running, settling' = settling, grace' = grace, checked' = checked, stoppedRun' = stoppedRun,
    compactionStopped' = compactionStopped,
  }

  // The reconcile interval of watchPending (extensions/subagents.ts:322-332).
  action reconcileTick: bool = all {
    hostPhase == "served", pending != reconciled(pending, landed),
    pending' = reconciled(pending, landed),
    batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine, created' = created, reported' = reported,
    keepBox, keepHost, keepWatch, keepPi, keepCounts,
  }

  // ---- Main's runs ----

  // agent_start: _startRun flushes the held custom messages first (as:1437-1440,
  // appended without an extension event), then agent.prompt emits agent_start
  // and the starting messages' message_end (agent-loop.js:55-60; as:752-760
  // persists after the extension handlers). main-watch's agent_start
  // (main-watch.ts:96-102) sets running and retries; the message_end handler
  // acknowledges (extensions/subagents.ts:349-353).
  action runStart(throws: bool): bool = {
    val served = hostPhase == "served"
    val b1 = landAll({ ...box0, pendingCustom: [], fail: throws }, pendingCustom)
    val w = { ...where0, running: true, settling: false, grace: false }
    val b2 = if (served and not(closed)) sendWaiting(w, { ...b1, phase: "work" }) else { ...b1, phase: "work" }
    val b3 = landAll({ ...b2, prep: [] }, prep)
    all {
      phase == "prep",
      throws implies (fails < MAX_FAILS and served),
      applyBox(b3, closed),
      pending' = if (served) pending.filter(id => not(count(prep, id) > 0)) else pending,
      running' = true, settling' = false, grace' = false, checked' = false,
      stoppedRun' = stoppedRun, compactionStopped' = compactionStopped, retrySoon' = retrySoon,
      batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine, created' = created, reported' = reported,
      keepHost, keepPi, keepCounts,
    }
  }

  // A turn ends with main's reply. turn_end handlers run: answered (main-watch.ts:122-128,
  // deliver.ts:296-312) and reconcile (extensions/subagents.ts:333). Then Pi
  // flushes the held custom messages (as:796-798). `more`: the reply made tool
  // calls, so the loop goes on; else agent_end (reconcile, extensions/subagents.ts:334;
  // stoppedRun, main-watch.ts:114-117) and the settle boundary.
  action turnEnd(more: bool): bool = {
    val served = hostPhase == "served"
    val owing1 = if (served) owing.filter(id => not(isLanded(landed, id))) else owing
    val pending1 = if (served) reconciled(pending, landed) else pending
    val b = landAll({ ...box0, unread: Set(), unreplied: Set(), stopMark: false, owing: owing1, pendingCustom: [] }, pendingCustom)
    all {
      phase == "work",
      applyBox(if (more) b else { ...b, phase: "bs" }, closed),
      pending' = if (served and not(more)) reconciled(pending1, b.landed) else pending1,
      ours' = if (more) ours else false,
      bsContinue' = if (more) bsContinue else false,
      stoppedRun' = if (more) stoppedRun else false,
      running' = running, settling' = settling, grace' = grace, checked' = checked,
      compactionStopped' = compactionStopped, retrySoon' = retrySoon,
      batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine, created' = created, reported' = reported,
      later' = later, compacting' = compacting, compactPending' = compactPending, promptWaiting' = promptWaiting,
      keepHost, keepCounts,
    }
  }

  // main-watch's agent_before_settle handler (main-watch.ts:103-113) with
  // owed (deliver.ts:280-288). The context holds the queued and held custom
  // messages as pendingMessages (as:612-614). Other extensions' handlers can
  // run before and after it.
  action beforeSettle: bool = {
    val served = hostPhase == "served"
    val owing1 = if (served) owing.filter(id => count(pendingCustom, id) > 0 or unread.contains(id) or (OWE_WAKE_MAIL and not(isLanded(landed, id)))) else owing
    val owes = served and owing1 != Set()
    all {
      phase == "bs", not(ours),
      ours' = true,
      checked' = true,
      owing' = owing1,
      bsContinue' = owes,
      settling' = if (owes) settling else true,
      outbox' = outbox, phase' = phase, prep' = prep, deferred' = deferred, pendingCustom' = pendingCustom,
      steerQ' = steerQ, landed' = landed, unread' = unread, unreplied' = unreplied, stopMark' = stopMark,
      retryArmed' = retryArmed, fails' = fails,
      running' = running, grace' = grace, stoppedRun' = stoppedRun, compactionStopped' = compactionStopped, retrySoon' = retrySoon,
      later' = later, compacting' = compacting, compactPending' = compactPending, promptWaiting' = promptWaiting,
      keepMail, keepHost, keepCounts,
    }
  }

  // The boundary ends (as:1572-1588): Pi flushes the held custom messages; on
  // continue, agent.continue() emits agent_start again (agent-loop.js:73),
  // else the run settles (as:1468-1471, :683-688).
  action bsEnd(throws: bool): bool = {
    val served = hostPhase == "served"
    val b1 = landAll({ ...box0, pendingCustom: [], fail: throws }, pendingCustom)
    val w = { ...where0, running: true, settling: false, grace: false }
    val b2 = if (bsContinue and served and not(closed)) sendWaiting(w, { ...b1, phase: "work" })
      else if (bsContinue) { ...b1, phase: "work" } else { ...b1, phase: "settle" }
    all {
      phase == "bs", ours,
      throws implies (fails < MAX_FAILS and bsContinue and served),
      applyBox(b2, closed),
      ours' = false, bsContinue' = false,
      running' = if (bsContinue) true else running,
      settling' = if (bsContinue) false else settling,
      checked' = if (bsContinue) false else checked,
      grace' = if (bsContinue) false else grace,
      stoppedRun' = stoppedRun, compactionStopped' = compactionStopped, retrySoon' = retrySoon,
      later' = later, compacting' = compacting, compactPending' = compactPending, promptWaiting' = promptWaiting,
      keepMail, keepHost, keepCounts,
    }
  }

  // main-watch's agent_settled handler (main-watch.ts:118-128): not running,
  // the stop mark, retry; then the reconcile handler (extensions/subagents.ts:335).
  // While agent_settled handlers run, a send that starts a turn is deferred.
  action settledHandler(throws: bool): bool = {
    val served = hostPhase == "served" and not(closed)
    val w = { ...where0, running: false, settling: false, grace: false }
    val b = if (served) sendWaiting(w, { ...box0, fail: throws, stopMark: stoppedRun or not(checked) })
      else { ...box0, stopMark: stoppedRun or not(checked) }
    all {
      phase == "settle", not(ours),
      throws implies (fails < MAX_FAILS and served),
      ours' = true,
      applyBox(b, closed),
      pending' = if (hostPhase == "served") reconciled(pending, b.landed) else pending,
      running' = false, settling' = false, grace' = false,
      checked' = checked, stoppedRun' = stoppedRun, compactionStopped' = compactionStopped, retrySoon' = retrySoon,
      bsContinue' = bsContinue, later' = later, compacting' = compacting, compactPending' = compactPending, promptWaiting' = promptWaiting,
      batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine, created' = created, reported' = reported,
      keepHost, keepCounts,
    }
  }

  // The handlers end. Pi runs the deferred actions one at a time (as:693-701);
  // each starts a run whose own agent_settled runs inside that await, so the
  // nested emission's deferred actions go before the outer ones.
  action settleEnd: bool = {
    val items = deferred.concat(later)
    all {
      phase == "settle", ours,
      ours' = false,
      deferred' = [],
      if (items == []) all { phase' = "idle", prep' = prep, later' = [] }
      else all {
        phase' = "prep",
        prep' = if (items.head() == PROMPT) prep else prep.append(items.head()),
        later' = items.tail(),
      },
      outbox' = outbox, owing' = owing, pendingCustom' = pendingCustom, steerQ' = steerQ, landed' = landed,
      unread' = unread, unreplied' = unreplied, stopMark' = stopMark, retryArmed' = retryArmed, fails' = fails,
      bsContinue' = bsContinue, compacting' = compacting, compactPending' = compactPending, promptWaiting' = promptWaiting,
      keepMail, keepHost, keepWatch, keepCounts,
    }
  }

  // ---- The user ----

  // The user sends a prompt while main is idle: the input event (main-watch.ts:95)
  // starts the grace; the run starts after the preflight. Pi refuses a prompt
  // while it compacts (as:1647-1649). While agent_settled handlers run, Pi
  // defers the prompt before its input handlers (as:1631-1634).
  action userInput: bool = all {
    phase == "idle", not(compacting), not(compactPending), hostPhase == "served",
    not(promptWaiting), prompts < MAX_PROMPTS,
    prompts' = prompts + 1, promptWaiting' = true, grace' = true,
    ours' = ours, bsContinue' = bsContinue, later' = later, compacting' = compacting, compactPending' = compactPending,
    running' = running, settling' = settling, checked' = checked, stoppedRun' = stoppedRun,
    compactionStopped' = compactionStopped, retrySoon' = retrySoon,
    excused' = excused, aborts' = aborts, compactions' = compactions,
    keepBox, keepMail, keepHost,
  }
  action userInputDeferred: bool = all {
    phase == "settle", hostPhase == "served", prompts < MAX_PROMPTS,
    prompts' = prompts + 1, deferred' = deferred.append(PROMPT),
    outbox' = outbox, owing' = owing, phase' = phase, prep' = prep, pendingCustom' = pendingCustom, steerQ' = steerQ,
    landed' = landed, unread' = unread, unreplied' = unreplied, stopMark' = stopMark, retryArmed' = retryArmed, fails' = fails,
    excused' = excused, aborts' = aborts, compactions' = compactions,
    keepMail, keepHost, keepWatch, keepPi,
  }
  // The preflight ends. A run that mail started in the gap makes Pi refuse
  // the prompt; the model drops it then (it is not mail).
  action promptRun: bool = all {
    promptWaiting,
    promptWaiting' = false,
    // Pi checks for a compaction only before the input handlers (as:1648-1652);
    // a run that a prompt starts during a compaction is left out (README).
    if (phase == "idle" and not(compacting)) all { phase' = "prep" } else all { phase' = phase },
    outbox' = outbox, owing' = owing, prep' = prep, deferred' = deferred, pendingCustom' = pendingCustom, steerQ' = steerQ,
    landed' = landed, unread' = unread, unreplied' = unreplied, stopMark' = stopMark, retryArmed' = retryArmed, fails' = fails,
    ours' = ours, bsContinue' = bsContinue, later' = later, compacting' = compacting, compactPending' = compactPending,
    keepMail, keepHost, keepWatch, keepCounts,
  }
  // INPUT_GRACE_MS passes (main-watch.ts:25, :151).
  action graceEnds: bool = all {
    grace,
    grace' = false,
    running' = running, settling' = settling, checked' = checked, stoppedRun' = stoppedRun,
    compactionStopped' = compactionStopped, retrySoon' = retrySoon,
    keepBox, keepMail, keepHost, keepPi, keepCounts,
  }

  // Esc in the TUI: clearAllQueues (interactive-mode.js:3820-3853) and
  // session.abort() (as:1971-1982). The run ends; _startRun's finally
  // flushes the held custom messages (as:1467-1471). agent_end says the run
  // was stopped (main-watch.ts:114-117). Abort in prep is left out (README).
  action userAbort: bool = {
    val b = landAll({ ...box0, steerQ: [], pendingCustom: [] }, pendingCustom)
    all {
      phase == "work" or phase == "bs", aborts < MAX_ABORTS,
      aborts' = aborts + 1,
      applyBox({ ...b, phase: "settle" }, closed),
      excused' = excused.union(b.unreplied.filter(id => wakes(id))),
      // agent_end's reconcile runs before the finally flushes (agent-loop.js ends, then as:1467-1470).
      pending' = if (hostPhase == "served") reconciled(pending, landed) else pending,
      stoppedRun' = true, ours' = false, bsContinue' = false,
      running' = running, settling' = settling, grace' = grace, checked' = checked,
      compactionStopped' = compactionStopped, retrySoon' = retrySoon,
      later' = later, compacting' = compacting, compactPending' = compactPending, promptWaiting' = promptWaiting,
      batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine, created' = created, reported' = reported,
      keepHost, prompts' = prompts, compactions' = compactions,
    }
  }

  // /compact while main works: session.compact() aborts the run without
  // clearing the queues and waits for idle (as:2230-2232).
  action compactMidRun: bool = {
    val b = landAll({ ...box0, pendingCustom: [] }, pendingCustom)
    all {
      phase == "work" or phase == "bs", compactions < MAX_COMPACTIONS, hostPhase == "served",
      compactions' = compactions + 1, compactPending' = true,
      applyBox({ ...b, phase: "settle" }, closed),
      pending' = reconciled(pending, landed),
      stoppedRun' = true, ours' = false, bsContinue' = false,
      running' = running, settling' = settling, grace' = grace, checked' = checked,
      compactionStopped' = compactionStopped, retrySoon' = retrySoon,
      later' = later, compacting' = compacting, promptWaiting' = promptWaiting,
      batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine, created' = created, reported' = reported,
      keepHost, prompts' = prompts, aborts' = aborts, excused' = excused,
    }
  }
  // /compact while main is idle.
  action compactIdle: bool = all {
    phase == "idle", not(compacting), not(compactPending), not(promptWaiting), hostPhase == "served",
    compactions < MAX_COMPACTIONS,
    compactions' = compactions + 1, compactPending' = true,
    ours' = ours, bsContinue' = bsContinue, later' = later, compacting' = compacting, promptWaiting' = promptWaiting,
    prompts' = prompts, aborts' = aborts, excused' = excused,
    keepBox, keepMail, keepHost, keepWatch,
  }
  // The abort is over and Pi is idle: compaction starts (as:2232). Its
  // session_before_compact handler decides whether the compaction stopped a
  // turn (main-watch.ts:130-134).
  action compactStart: bool = all {
    compactPending, phase == "idle", deferred == [], later == [], not(compacting),
    compacting' = true, compactPending' = false,
    compactionStopped' = stopMark,
    running' = running, settling' = settling, grace' = grace, checked' = checked, stoppedRun' = stoppedRun, retrySoon' = retrySoon,
    ours' = ours, bsContinue' = bsContinue, later' = later, promptWaiting' = promptWaiting,
    keepBox, keepMail, keepHost, keepCounts,
  }
  // session_compact: compacted(true) (main-watch.ts:78-84) runs while Pi
  // still compacts, so a reminder it posts is held (route hold); retrySoon.
  // Then Pi is done. `drop`: the summary replaced the context the mail was in.
  action compactEnd(drop: bool, throws: bool): bool = {
    val remindNow = compactionStopped and owing != Set() and not(closed) and hostPhase == "served"
    val w = { ...where0, compacting: true }
    val b = if (remindNow) sendWaiting(w, { ...box0, owing: Set(), outbox: outbox.append(REMINDER), fail: throws }) else box0
    all {
      compacting,
      throws implies (fails < MAX_FAILS and remindNow),
      applyBox({ ...b, unread: if (drop) Set() else b.unread }, closed),
      created' = if (remindNow) created.union(Set(REMINDER)) else created,
      compacting' = false, compactionStopped' = false, retrySoon' = true,
      running' = running, settling' = settling, grace' = grace, checked' = checked, stoppedRun' = stoppedRun,
      ours' = ours, bsContinue' = bsContinue, later' = later, compactPending' = compactPending, promptWaiting' = promptWaiting,
      pending' = pending, batch' = batch, batchTimer' = batchTimer, closed' = closed, mine' = mine, reported' = reported,
      keepHost, keepCounts,
    }
  }

  // ---- /reload ----

  // handleReloadCommand refuses while a run is active or Pi compacts
  // (interactive-mode.js:5328-5336), then awaits; session_shutdown parks the
  // host (extensions/subagents.ts:355-366, serve.ts:470-483, host.ts:163-166).
  // An agent_settled emission can still be running: Pi emits it to the old
  // runner, whose handlers now see no host, and the new module never sees it.
  action reloadStart: bool = all {
    hostPhase == "served", not(active(phase)), not(compacting), not(compactPending), not(promptWaiting),
    reloads < MAX_RELOADS,
    hostPhase' = "parked", reloads' = reloads + 1,
    ours' = if (phase == "settle") true else ours,
    gen' = gen, kept' = kept,
    bsContinue' = bsContinue, later' = later, compacting' = compacting, compactPending' = compactPending, promptWaiting' = promptWaiting,
    keepBox, keepMail, keepWatch, keepCounts,
  }

  // session_start of the new module (main-watch.ts:86-94 resets its flags;
  // extensions/subagents.ts:182-198): serve.ts:440-452 claims the parked host,
  // and Host.rebind (host-state.ts:223-229) binds the new ports and retries.
  action reloadAdopt(throws: bool): bool = {
    val w = { served: true, compacting: compacting, grace: false, running: false, settling: false }
    all {
      hostPhase == "parked",
      throws implies fails < MAX_FAILS,
      hostPhase' = "served",
      applyBox(sendWaiting(w, { ...box0, fail: throws, stopMark: false }), closed),
      running' = false, settling' = false, grace' = false, checked' = false, stoppedRun' = false,
      compactionStopped' = false, retrySoon' = retrySoon,
      gen' = gen, kept' = kept, reloads' = reloads,
      keepMail, keepPi, keepCounts,
    }
  }

  // The takeover falls back (a version mismatch, a failed rebind, the 30 s
  // timeout): the old host closes (host-state.ts:250-266). beginClose makes the
  // route hold, drain (deliver.ts:213-225) flushes the batch and takes the
  // outbox, and handOverMail keeps it all in the index, since no module is
  // bound (host-state.ts:295-301). dispose clears the rest (deliver.ts:355-368).
  action fallbackClose: bool = {
    val f = flushed(pending, mine, created, batch)
    val taken = if (batch) outbox.append(REPORT) else outbox
    all {
      hostPhase == "parked",
      hostPhase' = "closed",
      kept' = kept.concat(taken),
      created' = f._3,
      outbox' = [], owing' = Set(), pending' = Set(), mine' = Set(), batch' = false, batchTimer' = false,
      retryArmed' = false, closed' = true,
      phase' = phase, prep' = prep, deferred' = deferred, pendingCustom' = pendingCustom, steerQ' = steerQ,
      landed' = landed, unread' = unread, unreplied' = unreplied, stopMark' = stopMark, fails' = fails,
      gen' = gen, reloads' = reloads, reported' = reported,
      keepWatch, keepPi, keepCounts,
    }
  }

  // The new module opens a host from the index (serve.ts:453-458) and
  // restore posts the kept mail once (host-state.ts:241-245, :304-311):
  // resend remembers each item but a reminder and posts it (deliver.ts:234-241).
  action fallbackOpen(throws: bool): bool = {
    val w = { served: true, compacting: compacting, grace: false, running: false, settling: false }
    val ids = kept.foldl(Set(), (s, id) => if (id == REMINDER) s else s.union(Set(id)))
    // resend posts one item at a time, and each post runs sendWaiting (deliver.ts:234-241, :396-399).
    val b0 = kept.foldl({ ...box0, outbox: [], owing: Set(), fail: throws, stopMark: false },
      (acc, id) => sendWaiting(w, { ...acc, outbox: acc.outbox.append(id), stop: false }))
    all {
      hostPhase == "closed",
      throws implies fails < MAX_FAILS,
      hostPhase' = "served", gen' = 2, kept' = [],
      applyBox(b0, false),
      closed' = false, pending' = ids, mine' = ids,
      batch' = false, batchTimer' = false, created' = created, reported' = reported,
      running' = false, settling' = false, grace' = false, checked' = false, stoppedRun' = false,
      compactionStopped' = false, retrySoon' = retrySoon,
      reloads' = reloads,
      keepPi, keepCounts,
    }
  }

  action step = any {
    nondet throws = Set(false, true).oneOf()
    any {
      nondet id = CHILD_MAIL.oneOf()
      childMail(id, throws),
      batchFlush(throws),
      retryFire(throws),
      runStart(throws),
      bsEnd(throws),
      settledHandler(throws),
      compactEnd(false, throws),
      compactEnd(true, throws),
      reloadAdopt(throws),
      fallbackOpen(throws),
    },
    childReport,
    retrySoonFire,
    reconcileTick,
    turnEnd(true),
    turnEnd(false),
    beforeSettle,
    settleEnd,
    userInput,
    userInputDeferred,
    promptRun,
    graceEnds,
    userAbort,
    compactMidRun,
    compactIdle,
    compactStart,
    reloadStart,
    fallbackClose,
  }

  // ---- Properties ----

  pure def count(l: List[str], id: str): int = l.foldl(0, (n, x) => if (x == id) n + 1 else n)
  // Every place a mail item can be: the outbox, Pi's lists, the index, the transcript.
  val copies: str -> int = IDS.mapBy(id =>
    count(outbox, id) + count(prep, id) + count(deferred, id) + count(later, id) + count(pendingCustom, id)
    + count(steerQ, id) + count(kept, id) + landed.get(id))

  // The promise: no mail reaches main's transcript twice.
  val landedOnce = IDS.forall(id => landed.get(id) <= 1)
  // No mail is lost: each item a child sent, or the mail made, is somewhere.
  val noLoss = IDS.forall(id => created.contains(id) implies copies.get(id) >= 1)
    and (reported implies (batch or created.contains(REPORT)))
  // No mail is copied: each item is in one place only.
  val noCopy = IDS.forall(id => copies.get(id) <= 1)
  // The widget drops an item only once the transcript holds it (deliver.ts:330-348).
  val ackMeansLanded = mine.forall(id => (id != PLACEHOLDER and not(pending.contains(id))) implies isLanded(landed, id))
  // The host before the reload is quiet (HostState.quiet, host-state.ts:235-237)
  // only when every mail item has reached the transcript.
  val idleMeansLanded =
    (gen == 1 and hostPhase == "served" and not(closed) and pending == Set() and not(batch) and outbox == [] and owing == Set())
      implies created.forall(id => id == REMINDER or landed.get(id) >= 1)
  // Main is woken for mail that must wake it: once nothing is left to run
  // (no run, no deferred action, no timer, no compaction, no reload), every
  // waking item in the transcript has a reply after it, unless the user
  // stopped the run it landed in.
  val quiescent = all {
    phase == "idle", deferred == [], later == [], not(compacting), not(compactPending), not(promptWaiting),
    outbox == [], not(batchTimer), not(retrySoon), not(grace), hostPhase == "served",
  }
  val wokenForMail = quiescent implies unreplied.forall(id => wakes(id) implies excused.contains(id))

  // ---- Witnesses (fv.mjs traces asks the simulator to break each) ----
  val witnessNoFallback = kept == [] or hostPhase != "closed"
  val witnessNoResend = gen == 1 or created == Set()
  val witnessNoReminder = not(created.contains(REMINDER)) or landed.get(REMINDER) == 0
  val witnessNoContinue = not(bsContinue)
  val witnessNoDeferredMail = deferred.select(id => id != PROMPT) == []
  val witnessNoFail = fails == 0
  val witnessNoHeldWhileParked = hostPhase != "parked" or outbox == []
  val witnessNoAdoptWithMail = not(hostPhase == "served" and reloads == 1 and gen == 1 and landed.get("a") == 1 and owing != Set())
}
