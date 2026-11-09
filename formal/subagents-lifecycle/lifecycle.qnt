// Subagent run lifecycle: a model of how the team (lib/subagents/team.ts)
// starts, runs, stops, relaunches and falls back a child, with the concurrency
// line (lib/subagents/slots.ts), messages from main (lib/subagents/routing.ts
// deliver, wake, relaunch) and the session store (lib/subagents/sessions.ts).
// Each action is one synchronous segment of the code (the code between two
// awaits), so the checker tries every order in which the event loop can run
// them. The file:line comments name the code each action stands for.
//
// The child's Pi session is part of the model: AgentSession.prompt, abort and
// dispose in Pi 1.4.0 (node_modules/@earendil-works/pi-coding-agent/dist/core/
// agent-session.js, line numbers for 1.4.0) and Agent in pi-agent-core
// (dist/agent.js). The handle that wraps it is lib/subagents/child.ts:692-736.
//
// The whole team state is one record, `w`, so that the code helpers below
// (pump, finish, release, run) can be pure functions that the actions chain,
// as the code calls them inside one segment.
module lifecycle {
  // ---- Bounds. A pass covers only these sizes (README.md). ----
  pure val CH = Set("c1", "c2")
  pure val MAX_CONCURRENT = 1   // TeamOptions.maxConcurrent
  pure val MAX_MSGS = 2         // messages main sends to children, in total
  pure val MAX_STOPS = 2        // stops main or the user asks for, in total
  pure val FALLBACKS = 1        // fallback models for each child (fallback.ts planFallback)
  pure val PUMP_PASSES = 3      // passes of Slots.pump; the line never holds more than 3 names

  // ---- Platform switches. The faithful model is Pi 1.4.0 as it is. ----
  // AgentSession.prompt awaits before it sets _isAgentRunActive: an `input`
  // handler (_runInputHandlers, agent-session.js:1652, :1590-1602), an
  // extension command (:1640-1646) and an auth check (:1680-1681). An abort
  // then finds no run (abort, :1971-1983: _agentRunAbortRequested is set only
  // when _isAgentRunActive) and resolves at once (waitForIdle, :1984-1989),
  // and the run that follows is not aborted. probe-pi-abort.mts `input` shows it.
  // The variant `no-pre-window` assumes no such await (true for a child whose
  // extensions have only synchronous input handlers and a configured login).
  pure val PRE_WINDOW = true
  // Within _startRun, an abort during _prepareRun (:1480-1530: compaction
  // check, before_agent_start) sets _agentRunAbortRequested, and the run is
  // stopped by the agent_start listener (_handleAgentEvent, :709-713) before
  // the first request. dispose() removes that listener (_disconnectFromAgent,
  // :1001-1006, :1023), so a session disposed in this window runs its first
  // agent loop with no listener (probe-pi-abort.mts `dispose`).
  // The variant `dispose-aborts` assumes a fixed Pi where dispose stops it.
  pure val DISPOSE_STOPS_PREP = false
  // AgentSession.steer awaits the input handlers (_queueUserInput,
  // agent-session.js:1752-1756) before it queues the message, and child.ts:718
  // does not await steer. So a steered message is on the record's `unread`
  // (routing.ts:217-218) before it is in Pi's queue. repro-f5.mts shows it.
  // The variant `atomic-steer` assumes no such await (synchronous input handlers).
  pure val STEER_WINDOW = true

  // ---- The child's prompt gate (lib/subagents/child-prompt.ts), the code's fix of F1, F2 and F5 ----
  // Pi stays as it is (the switches above); the gate gives the team the
  // stop that Pi does not give. Each mutant at HEAD sets one of these false.
  // The gate keeps an abort that comes in the pre window and aborts again when
  // Pi says that the run started (preflightResult "started", agent-session.js:1689,
  // :1442), so Pi's own agent_start check stops the run (F1).
  pure val GATE_REABORTS = true
  // The gate's abort waits for the prompt in flight, also in its pre window.
  pure val GATE_ABORT_WAITS = true
  // The handle's dispose aborts through the gate (`shut`) and waits for the
  // prompt in flight before Pi's dispose disconnects the agent_start listener (F2).
  pure val DISPOSE_WAITS = true
  // After `shut`, the gate's own agent listener stops an aborted run at
  // agent_start. It covers a dispose whose wait ended at GATE_WAIT_MS; the
  // model has no time, so the waits never end early and it is not modeled.
  // The gate's prompt returns only once its steers in flight are in Pi's queue (F5).
  pure val PROMPT_WAITS_STEERS = true
  // Residual R1, fixed: Team.run takes the late mail again in the same step as
  // settle, after it waits for steers in flight (team.ts run). False: the last
  // late() of work() and settle() are one segment, as in the code. True: the
  // code before the fix, where work() returns to run() and settle() runs some
  // microtasks later, so a message main sends meanwhile is steered into a run
  // that has ended (mutant-late-settle-gap).
  pure val SETTLE_GAP = false

  pure val LIVE = Set("queued", "starting", "running")   // LIVE_STATES without asking and waiting (left out)
  pure val ACTIVE = Set("starting", "running")            // ACTIVE_STATES, types.ts:14
  pure val ENDED = Set("idle", "failed", "stopped", "interrupted")

  // A prompt in the child's Pi session (one handle.prompt call).
  //   phase "pre": prompt() awaits before _startRun; "prep": _prepareRun;
  //   "active": the agent loop runs; "steers": Pi's prompt() returned with
  //   the outcome `out`, and the gate waits for steers in flight.
  //   s: the launch number of the session it runs in; r: the launch number
  //   that Team.run read (team.ts:687), which `gone` compares.
  //   abortReq: an abort was asked that stops this prompt (in the pre window,
  //   only the gate keeps it); disposed: the handle's dispose began.
  type Prompt = { c: str, s: int, r: int, phase: str, abortReq: bool, disposed: bool, out: str }

  type World = {
    state: str -> str,            // AgentRecord.state
    launches: str -> int,         // Team.launches (team.ts:109)
    ending: str -> int,           // Team.ending (team.ts:103): the launch number of the stop that owns the mark, 0 for none
    byParent: str -> int,         // Team.stoppedByParent: the launch number of a stop by the child's parent, 0 for none
    line: List[str],              // Slots.line (slots.ts:32)
    goingOn: Set[str],            // Slots.goingOn keys (slots.ts:33): runWhenFree waits
    opening: Set[(str, int)],     // Team.opening: launcher.launch in flight, by launch number
    held: str -> int,             // OpenSessions.handles: launch number of the held session, 0 for none
    inbox: str -> int,            // AgentRecord.inbox, as a count of messages
    resume: str -> int,           // ResumePrompts: -1 for none, else the messages its `message` carries
    continuing: Set[str],         // Team.continuing (team.ts:113)
    fallbacksLeft: str -> int,
    prompts: Set[Prompt],
    stops: Set[(str, int, int)],  // stops that await handle.abort(): (child, stop's launch, session)
    sq: str -> int,               // steered, unread messages in the held session's Pi queue (AgentRecord.unread)
    sqCopy: str -> int,           // the same, after unreadLeft copied them to the inbox
    // Steers that wait for the input handlers (STEER_WINDOW): (child, session,
    // id, kind). kind "unread": on the record's `unread`; "copied": unreadLeft
    // also put it in the inbox; "orphan": settle cleared `unread` (team.ts:878).
    sp: Set[(str, int, int, str)],
    oq: str -> int,               // orphan steers that landed in the held session's Pi queue
    // Ghosts: only the properties and witnesses read them.
    sent: str -> int,             // messages main sent to the child
    read: str -> int,             // messages that reached a prompt or the child's transcript
    lost: int,                    // unread messages dropped with a session
    dup: str -> int,              // messages that reached the child twice
    reported: str -> int,         // reports handed up (handUp, handUpFailure) since the run began
    reportsTotal: str -> int,     // all reports handed up
    waiters: Set[str],            // whenDone promises that have not resolved
    leaked: bool,                 // a session held over another one that was not disposed
    refusedLive: bool,            // a stop refused for a child that still works
    parentStops: Set[(str, int)], // (child, the stop's launch number) of each stop by the child's parent
    wrongSilence: bool,           // a report went up for a stop by the parent, or a report was kept back for any other end
    // An older stop went on after its abort while a newer stop of the child still waited (F4's path),
    // and the same while that newer stop was by the parent. Only witnesses read them.
    staleOverStop: bool,
    staleOverParentStop: bool,
    msgsLeft: int,
    stopsLeft: int,
  }

  var w: World

  // ---- Helpers that copy one piece of code each ----

  pure def isLive(x: World, c: str): bool = LIVE.contains(x.state.get(c))

  // Team.gone (team.ts:797-799). The team never closes in this model.
  pure def gone(x: World, c: str, l: int): bool =
    x.state.get(c) == "stopped" or x.launches.get(c) != l

  // Slots.used (slots.ts:99-103): no blocking parents and no resting children here.
  pure def used(x: World): int = CH.filter(c => ACTIVE.contains(x.state.get(c))).size()
  pure def free(x: World): bool = used(x) < MAX_CONCURRENT

  pure def drop(l: List[str], c: str): List[str] = l.select(n => n != c)

  // Slots.goOn (slots.ts:57-63): at the first place that is not going on, so
  // behind others going on and ahead of what has not started.
  pure def goOnInsert(x: World, c: str): List[str] = {
    val idx = x.line.indices().filter(i => not(x.goingOn.contains(x.line[i])))
    val at = idx.fold(x.line.length(), (m, i) => if (i < m) i else m)
    x.line.slice(0, at).append(c).concat(x.line.slice(at, x.line.length()))
  }

  // A new prompt in the held session; Pi's prompt() starts in its pre window.
  pure def firstPhase: str = if (PRE_WINDOW) "pre" else "prep"
  pure def newPrompt(c: str, s: int, r: int): Prompt =
    { c: c, s: s, r: r, phase: firstPhase, abortReq: false, disposed: false, out: "" }

  // Team.run up to `await handle.prompt` (team.ts:683-701, :718). It reads the
  // launch number at :681 and sets state "running" at :692. `m` is the number
  // of messages its text carries, which now reach the session.
  pure def runPrompt(x: World, c: str, m: int): World =
    if (x.held.get(c) == 0) x
    else {
      ...x,
      state: x.state.set(c, "running"),
      continuing: x.continuing.exclude(Set(c)),
      prompts: x.prompts.union(Set(newPrompt(c, x.held.get(c), x.launches.get(c)))),
      read: x.read.set(c, x.read.get(c) + m),
    }

  // The gate's abort (child-prompt.ts `abort`), then Pi's abort: a prompt in
  // its prep window or loop gets Pi's abort flag; one in its pre window keeps
  // it only in the gate (GATE_REABORTS); one whose prompt() returned is done.
  pure def abortOne(p: Prompt): Prompt =
    if (p.phase == "steers" or (p.phase == "pre" and not(GATE_REABORTS))) p else { ...p, abortReq: true }

  // OpenSessions.release (sessions.ts:160-167) and handle.dispose
  // (childDisposer in child.ts, then AgentSession.dispose, agent-session.js:1011-1030).
  // With DISPOSE_WAITS the handle first aborts through the gate and waits for
  // the prompt in flight, so Pi's listener is still there when it reaches
  // agent_start. Without it, agent.abort() stops an active loop, and a prompt
  // in its pre or prep window goes on (DISPOSE_STOPS_PREP). The Pi queue goes
  // with the session.
  pure def disposeOne(p: Prompt): Prompt =
    if (DISPOSE_WAITS) { ...abortOne(p), disposed: true }
    else if (p.phase == "active" or DISPOSE_STOPS_PREP) { ...p, disposed: true, abortReq: true }
    else { ...p, disposed: true }
  pure def release(x: World, c: str): World =
    if (x.held.get(c) == 0) x
    else {
      val s = x.held.get(c)
      {
        ...x,
        held: x.held.set(c, 0),
        prompts: x.prompts.map(p => if (p.c == c and p.s == s) disposeOne(p) else p),
        lost: x.lost + x.sq.get(c) + x.oq.get(c),
        sq: x.sq.set(c, 0),
        sqCopy: x.sqCopy.set(c, 0),
        oq: x.oq.set(c, 0),
      }
    }

  // Team.parkResume (team.ts:963-968): the resume prompt's message goes back to the inbox.
  pure def parkResume(x: World, c: str): World =
    if (x.resume.get(c) < 0) x
    else { ...x, inbox: x.inbox.set(c, x.inbox.get(c) + x.resume.get(c)), resume: x.resume.set(c, -1) }

  // Team.unreadLeft (team.ts:901-904, mailbox.ts:37-41): unread steering goes
  // to the inbox; the Pi queue still holds it until the session goes.
  // A steer that waits is on `unread` too, so it goes to the inbox as well.
  pure def unreadLeft(x: World, c: str): World = {
    val pend = x.sp.filter(t => t._1 == c and t._4 == "unread")
    {
      ...x,
      inbox: x.inbox.set(c, x.inbox.get(c) + x.sq.get(c) + pend.size()),
      sqCopy: x.sqCopy.set(c, x.sqCopy.get(c) + x.sq.get(c)), sq: x.sq.set(c, 0),
      sp: x.sp.map(t => if (pend.contains(t)) (t._1, t._2, t._3, "copied") else t),
    }
  }

  // Team.start up to `await opening` (team.ts:597-607): state "starting", a new launch number, launcher.launch.
  pure def start(x: World, c: str): World = {
    val l = x.launches.get(c) + 1
    { ...x, state: x.state.set(c, "starting"), launches: x.launches.set(c, l), opening: x.opening.union(Set((c, l))) }
  }

  // The `go` of runWhenFree (team.ts:529): run with the inbox as its text.
  pure def goRun(x: World, c: str): World =
    runPrompt({ ...x, inbox: x.inbox.set(c, 0) }, c, x.inbox.get(c))

  // One pass of Slots.pump's loop (slots.ts:85-94).
  pure def pumpOnce(x: World): World =
    if (not(free(x)) or x.line.length() == 0) x
    else {
      val c = x.line.head()
      val y = { ...x, line: x.line.tail() }
      if (y.state.get(c) != "queued") { ...y, goingOn: y.goingOn.exclude(Set(c)) }
      else if (y.goingOn.contains(c)) goRun({ ...y, goingOn: y.goingOn.exclude(Set(c)) }, c)
      else start(y, c)
    }
  // Team.pump (team.ts:505-508) is Slots.pump.
  pure def pump(x: World): World = 1.to(PUMP_PASSES).fold(x, (y, _) => pumpOnce(y))

  // Team.finish (team.ts:920-942): hand the report up, settle the waiters,
  // release a failed or stopped child's session (sessions.ts:134-136), pump.
  // The report is silent (hand-up.ts:46) when the stop of this launch was by
  // the child's parent. `reported` counts it; `reportsTotal` counts what main got.
  pure def finish(x: World, c: str): World = {
    val silent = x.byParent.get(c) != 0 and x.byParent.get(c) == x.launches.get(c)
    val asked = x.state.get(c) == "stopped" and x.parentStops.contains((c, x.launches.get(c)))
    val y = {
      ...x,
      ending: x.ending.set(c, 0),
      byParent: x.byParent.set(c, 0),
      continuing: x.continuing.exclude(Set(c)),
      reported: x.reported.set(c, x.reported.get(c) + 1),
      reportsTotal: x.reportsTotal.set(c, x.reportsTotal.get(c) + (if (silent) 0 else 1)),
      waiters: x.waiters.exclude(Set(c)),
      wrongSilence: x.wrongSilence or silent != asked,
    }
    val z = if (Set("failed", "stopped").contains(y.state.get(c))) release(y, c) else y
    pump(z)
  }

  // Team.fail (team.ts:882-890).
  pure def failRun(x: World, c: str): World = {
    val y = unreadLeft(x, c)
    finish({ ...y, state: y.state.set(c, "failed") }, c)
  }

  // Team.failOrFallBack (team.ts:818-838).
  pure def failOrFallBack(x: World, c: str): World =
    if (x.fallbacksLeft.get(c) == 0) failRun(parkResume({ ...x, continuing: x.continuing.exclude(Set(c)) }, c), c)
    else {
      val y = unreadLeft(x, c)
      val z = release({
        ...y,
        fallbacksLeft: y.fallbacksLeft.set(c, y.fallbacksLeft.get(c) - 1),
        continuing: y.continuing.union(Set(c)),
        resume: y.resume.set(c, if (y.resume.get(c) < 0) 0 else y.resume.get(c)),
        state: y.state.set(c, "queued"),
      }, c)
      pump({ ...z, line: z.line.append(c) })
    }

  // Team.resumeFailed (team.ts:628-651): interrupted, a failure report, waiters settle.
  pure def resumeFailed(x: World, c: str): World = {
    val y = parkResume(x, c)
    pump({
      ...y,
      state: y.state.set(c, "interrupted"),
      reported: y.reported.set(c, y.reported.get(c) + 1),
      reportsTotal: y.reportsTotal.set(c, y.reportsTotal.get(c) + 1),
      waiters: y.waiters.exclude(Set(c)),
    })
  }

  // Team.settle (team.ts:870-880), no subagents to wait for: idle, then finish.
  // settle also clears `unread` (team.ts:878): a steer that still waits is then on no record.
  pure def settle(x: World, c: str): World =
    finish({ ...x, state: x.state.set(c, "idle"), sp: x.sp.map(t => if (t._1 == c and t._4 == "unread") (t._1, t._2, t._3, "orphan") else t) }, c)

  // Team.work after `await handle.prompt` (team.ts:718-738) and run's catch
  // (:696-699). No wrap-up, swap or check in this model. `late` takes the Pi
  // queue (handle.takeQueued, child.ts:727-733) and the inbox (team.ts:802-805).
  pure def afterPrompt(x: World, p: Prompt, outcome: str): World =
    if (gone(x, p.c, p.r)) x
    else if (outcome == "error") failOrFallBack(x, p.c)
    else {
      val c = p.c
      // A steer that still waits is not in Pi's queue, so takeQueued misses it.
      val late = x.sq.get(c) + x.sqCopy.get(c) + x.oq.get(c) + x.inbox.get(c)
      if (late == 0) (if (SETTLE_GAP) { ...x, prompts: x.prompts.union(Set({ ...p, phase: "settling" })) } else settle(x, c))
      else {
        ...x,
        prompts: x.prompts.union(Set({ ...p, phase: firstPhase, abortReq: false, disposed: false, out: "" })),
        read: x.read.set(c, x.read.get(c) + x.sq.get(c) + x.oq.get(c) + x.inbox.get(c)),
        dup: x.dup.set(c, x.dup.get(c) + x.sqCopy.get(c)),
        sq: x.sq.set(c, 0), sqCopy: x.sqCopy.set(c, 0), oq: x.oq.set(c, 0), inbox: x.inbox.set(c, 0),
      }
    }

  // Whether the agent_start listener stops a prompt that leaves _prepareRun
  // (agent-session.js:709-713): an abort was asked, and dispose did not
  // disconnect the listener first (:1001-1006, :1023). With DISPOSE_WAITS,
  // Pi's dispose comes only after the prompt ended.
  pure def prepStops(p: Prompt): bool = p.abortReq and (not(p.disposed) or DISPOSE_STOPS_PREP or DISPOSE_WAITS)

  // Whether the handle's abort of session (c, s) resolves now: Pi's
  // waitForIdle finds no active run (a prompt in its pre window has not set
  // _isAgentRunActive, agent-session.js:1072-1074), and with GATE_ABORT_WAITS
  // no prompt is in flight there either.
  pure def abortDone(x: World, c: str, s: int): bool =
    x.prompts.forall(p => not(p.c == c and p.s == s and (p.phase == "prep" or p.phase == "active" or (p.phase == "pre" and GATE_ABORT_WAITS))))

  // Team.stop after `await handle.abort()` (team.ts:423-434). A relaunch during
  // the abort: the stop clears only its own marks (`ending`, `stoppedByParent`).
  pure def stopRest(x: World, c: str, l: int): World =
    if (x.launches.get(c) != l or x.state.get(c) != "stopped") pump({ ...x,
      staleOverStop: x.staleOverStop or x.stops.exists(t => t._1 == c and t._2 > l),
      staleOverParentStop: x.staleOverParentStop or x.stops.exists(t => t._1 == c and t._2 > l and x.parentStops.contains((c, t._2))),
      ending: if (x.ending.get(c) == l) x.ending.set(c, 0) else x.ending,
      byParent: if (x.byParent.get(c) == l) x.byParent.set(c, 0) else x.byParent })
    else finish(x, c)
  // The stops that await the abort of session (c, s) go on once the abort resolves there.
  pure def wakeStops(x: World, c: str, s: int): World =
    if (not(abortDone(x, c, s))) x
    else x.stops.filter(t => t._1 == c and t._3 == s).fold(x, (y, t) =>
      stopRest({ ...y, stops: y.stops.exclude(Set(t)) }, t._1, t._2))

  // ---- Actions ----

  // The gate's prompt after Pi's prompt() returned (child-prompt.ts `prompt`):
  // it waits while steers of this session are in flight, else the team's
  // continuation runs at once (afterPrompt).
  pure def promptReturns(x: World, p: Prompt, outcome: str): World =
    if (PROMPT_WAITS_STEERS and x.sp.exists(t => t._1 == p.c and t._2 == p.s))
      { ...x, prompts: x.prompts.union(Set({ ...p, phase: "steers", abortReq: false, out: outcome })) }
    else afterPrompt(x, p, outcome)

  action init = {
    val x0: World = {
      state: CH.mapBy(_ => "queued"), launches: CH.mapBy(_ => 0), ending: CH.mapBy(_ => 0), byParent: CH.mapBy(_ => 0),
      line: ["c1", "c2"], goingOn: Set(), opening: Set(), held: CH.mapBy(_ => 0),
      inbox: CH.mapBy(_ => 0), resume: CH.mapBy(_ => -1), continuing: Set(),
      fallbacksLeft: CH.mapBy(_ => FALLBACKS), prompts: Set(), stops: Set(),
      sq: CH.mapBy(_ => 0), sqCopy: CH.mapBy(_ => 0), sp: Set(), oq: CH.mapBy(_ => 0),
      sent: CH.mapBy(_ => 0), read: CH.mapBy(_ => 0), lost: 0, dup: CH.mapBy(_ => 0),
      reported: CH.mapBy(_ => 0), reportsTotal: CH.mapBy(_ => 0), waiters: CH, leaked: false, refusedLive: false,
      parentStops: Set(), wrongSilence: false, staleOverStop: false, staleOverParentStop: false, msgsLeft: MAX_MSGS, stopsLeft: MAX_STOPS,
    }
    // Team.spawn enqueues and pumps (team.ts:270-274).
    w' = pump(x0)
  }

  // launcher.launch resolves (team.ts:654-681 open, then start :607-624).
  action launchDone(c: str, l: int): bool = all {
    w.opening.contains((c, l)),
    val x = { ...w, opening: w.opening.exclude(Set((c, l))) }
    // open (team.ts:675-678): a stale launch disposes its session and returns null.
    if (gone(x, c, l)) w' = x
    else {
      // sessions.hold (team.ts:679, sessions.ts:64-66) keeps no other session.
      val held = { ...x, held: x.held.set(c, l), leaked: x.leaked or x.held.get(c) != 0 }
      // start (team.ts:617-624): the inbox and the resume prompt go into the first prompt.
      val m = held.inbox.get(c) + (if (held.resume.get(c) < 0) 0 else held.resume.get(c))
      w' = runPrompt({ ...held, inbox: held.inbox.set(c, 0), resume: held.resume.set(c, -1) }, c, m)
    },
  }

  // launcher.launch rejects (team.ts:608-615).
  action launchFails(c: str, l: int): bool = all {
    w.opening.contains((c, l)),
    val x = { ...w, opening: w.opening.exclude(Set((c, l))) }
    if (gone(x, c, l)) w' = x
    else if (x.continuing.contains(c)) w' = failOrFallBack(x, c)
    else if (x.resume.get(c) >= 0) w' = resumeFailed(x, c)
    else w' = failRun(x, c),
  }

  // Pi: prompt() passes its pre-run awaits and enters _startRun (agent-session.js:1652-1689, :1423-1428).
  action piPrepare(p: Prompt): bool = all {
    w.prompts.contains(p), p.phase == "pre",
    w' = { ...w, prompts: w.prompts.exclude(Set(p)).union(Set({ ...p, phase: "prep" })) },
  }

  // Pi: _prepareRun ends, Pi calls preflightResult("started") (agent-session.js:1442,
  // where the gate aborts again), and the agent loop emits agent_start
  // (:1449, agent.js runPromptMessages). A requested abort
  // stops it there when the listener is still connected (:709-713); the prompt
  // then resolves with no model call (probe `prepare`).
  action piAgentStart(p: Prompt): bool = all {
    w.prompts.contains(p), p.phase == "prep",
    val rest = { ...w, prompts: w.prompts.exclude(Set(p)) }
    if (prepStops(p)) w' = wakeStops(promptReturns(rest, p, "aborted"), p.c, p.s)
    else w' = { ...w, prompts: w.prompts.exclude(Set(p)).union(Set({ ...p, phase: "active", abortReq: false })) },
  }

  // Pi: the agent loop ends and prompt() resolves or throws; then the team's
  // continuation runs in the same chain of microtasks (child.ts:701-713, team.ts:718).
  // A stop that awaits this session's abort goes on in the same chain: Pi
  // resolves waitForIdle at the end of _emitAgentSettled (agent-session.js:683-707),
  // just before prompt() returns, with no macrotask between.
  action piEnds(p: Prompt, outcome: str): bool = all {
    w.prompts.contains(p), p.phase == "active",
    if (p.abortReq) outcome == "aborted" else Set("ok", "error").contains(outcome),
    w' = wakeStops(promptReturns({ ...w, prompts: w.prompts.exclude(Set(p)) }, p, outcome), p.c, p.s),
  }

  // Pi reads one steered message at a turn boundary of an active loop
  // (agent.js steering queue); the update hook then drops it from `unread`
  // (team.ts:672, :889-894).
  action piReadsSteer(c: str): bool = all {
    w.held.get(c) != 0,
    w.sq.get(c) + w.sqCopy.get(c) + w.oq.get(c) > 0,
    w.prompts.exists(p => p.c == c and p.s == w.held.get(c) and p.phase == "active" and not(p.abortReq)),
    if (w.sq.get(c) > 0) w' = { ...w, sq: w.sq.set(c, w.sq.get(c) - 1), read: w.read.set(c, w.read.get(c) + 1) }
    else if (w.oq.get(c) > 0) w' = { ...w, oq: w.oq.set(c, w.oq.get(c) - 1), read: w.read.set(c, w.read.get(c) + 1) }
    else w' = { ...w, sqCopy: w.sqCopy.set(c, w.sqCopy.get(c) - 1), dup: w.dup.set(c, w.dup.get(c) + 1) },
  }

  // Team.stop (team.ts:402-422, refused at :405) by the user or, with `byMain`, by main, the
  // children's parent, whose stop hands no report up (hand-up.ts:46).
  action stop(c: str, byMain: bool): bool = all {
    w.stopsLeft > 0,
    val x0 = { ...w, stopsLeft: w.stopsLeft - 1 }
    val st = x0.state.get(c)
    if (not(isLive(x0, c) or st == "interrupted"))
      // team.ts:405: refused. A child that works again after a relaunch is still live.
      w' = { ...x0, refusedLive: x0.refusedLive or isLive(x0, c) }
    else {
      val l = x0.launches.get(c) + 1
      // A stop of a paused child is news of its own: a new report is due (ghost).
      val x1a = if (st == "interrupted") { ...x0, reported: x0.reported.set(c, 0) } else x0
      val x1 = if (byMain) { ...x1a, byParent: x1a.byParent.set(c, l), parentStops: x1a.parentStops.union(Set((c, l))) } else x1a
      val x2 = parkResume({ ...x1, ending: x1.ending.set(c, l), line: drop(x1.line, c), goingOn: x1.goingOn.exclude(Set(c)) }, c)
      val x3 = unreadLeft({ ...x2, launches: x2.launches.set(c, l) }, c)
      val x4 = { ...x3, state: x3.state.set(c, "stopped") }
      val s = x4.held.get(c)
      if (s == 0) w' = stopRest(x4, c, l)
      else {
        val x5 = { ...x4, prompts: x4.prompts.map(p => if (p.c == c and p.s == s) abortOne(p) else p) }
        if (abortDone(x5, c, s)) w' = stopRest(x5, c, l)
        else w' = { ...x5, stops: x5.stops.union(Set((c, l, s))) }
      }
    },
  }

  // Main's message to a child: Routing.deliver, wake and relaunch
  // (routing.ts:194-272), Team.runWhenFree (team.ts:526-530), goOnWhenFree (:515-523).
  action message(c: str): bool = all {
    w.msgsLeft > 0,
    val x = { ...w, msgsLeft: w.msgsLeft - 1, sent: w.sent.set(c, w.sent.get(c) + 1) }
    val st = x.state.get(c)
    if (st == "running" and x.held.get(c) != 0)
      // routing.ts:216-220: steered, and kept on the record as unread.
      // With STEER_WINDOW, Pi queues it later (steerLands).
      if (STEER_WINDOW) w' = { ...x, sp: x.sp.union(Set((c, x.held.get(c), w.msgsLeft, "unread"))) }
      else w' = { ...x, sq: x.sq.set(c, x.sq.get(c) + 1) }
    else {
      val ended = st == "failed" or st == "stopped"
      // routing.ts:231: an ended child's held session goes first.
      val y = if (ended) release(x, c) else x
      if ((y.held.get(c) == 0 or ended) and ENDED.contains(st)) {
        // relaunch (routing.ts:258-272): the inbox and this message go into the resume prompt.
        val z = { ...y, resume: y.resume.set(c, y.inbox.get(c) + 1), inbox: y.inbox.set(c, 0), state: y.state.set(c, "queued"),
                  reported: y.reported.set(c, 0), waiters: y.waiters }
        w' = pump({ ...z, line: z.line.append(c) })
      } else if (st == "idle" and y.held.get(c) != 0) {
        // routing.ts:238-247: a new run in the held session, when a slot is free.
        val z = { ...y, reported: y.reported.set(c, 0) }
        if (free(z)) w' = runPrompt({ ...z, inbox: z.inbox.set(c, 0) }, c, z.inbox.get(c) + 1)
        else {
          val q = { ...z, inbox: z.inbox.set(c, z.inbox.get(c) + 1), state: z.state.set(c, "queued") }
          w' = { ...q, line: goOnInsert(q, c), goingOn: q.goingOn.union(Set(c)) }
        }
      } else
        // routing.ts:249-250: it waits in the inbox (queued or starting).
        w' = { ...y, inbox: y.inbox.set(c, y.inbox.get(c) + 1) }
    },
  }

  // The input handlers of a steer end, and _queueSteer puts it in the queue of
  // the session it was sent to (agent-session.js:1756-1766). A disposed
  // session's queue reaches nobody: the message is lost unless the inbox has a copy.
  // The gate's prompt that waits for this session's steers then goes on in the
  // same chain once the last one landed (child-prompt.ts `prompt`).
  pure def landed(x: World, t: (str, int, int, str)): World = {
    val c = t._1
    if (x.held.get(c) != t._2) (if (t._4 == "copied") x else { ...x, lost: x.lost + 1 })
    else if (t._4 == "unread") { ...x, sq: x.sq.set(c, x.sq.get(c) + 1) }
    else if (t._4 == "copied") { ...x, sqCopy: x.sqCopy.set(c, x.sqCopy.get(c) + 1) }
    else { ...x, oq: x.oq.set(c, x.oq.get(c) + 1) }
  }
  action steerLands(t: (str, int, int, str)): bool = all {
    w.sp.contains(t),
    val x = landed({ ...w, sp: w.sp.exclude(Set(t)) }, t)
    val waiting = x.prompts.filter(p => p.c == t._1 and p.s == t._2 and p.phase == "steers")
    if (waiting != Set() and not(x.sp.exists(u => u._1 == t._1 and u._2 == t._2)))
      w' = waiting.fold(x, (y, p) => afterPrompt({ ...y, prompts: y.prompts.exclude(Set(p)) }, p, p.out))
    else w' = x,
  }

  // With SETTLE_GAP (the code before the R1 fix): run() calls settle() once
  // work() has returned, with no new look at the queue and no gone() check.
  action settleAfterGap(p: Prompt): bool = all {
    w.prompts.contains(p), p.phase == "settling",
    w' = settle({ ...w, prompts: w.prompts.exclude(Set(p)) }, p.c),
  }

  // The quiet-spell timer of an idle child's session (sessions.ts:140-143).
  action idleRelease(c: str): bool = all {
    w.state.get(c) == "idle",
    w.held.get(c) != 0,
    w' = release(w, c),
  }

  action step = any {
    nondet c = CH.oneOf()
    nondet byMain = Set(false, true).oneOf()
    any { stop(c, byMain), message(c), idleRelease(c), piReadsSteer(c) },
    all { w.sp != Set(), nondet t = w.sp.oneOf() steerLands(t) },
    all { w.opening != Set(), nondet o = w.opening.oneOf() any { launchDone(o._1, o._2), launchFails(o._1, o._2) } },
    all { w.prompts != Set(), nondet p = w.prompts.oneOf() nondet out = Set("ok", "error", "aborted").oneOf() any { piPrepare(p), piAgentStart(p), piEnds(p, out), settleAfterGap(p) } },
  }

  // ---- Properties ----

  // A parent hears of each run once: one report for each run (handUp in finish,
  // or handUpFailure), never two (team.ts:930-935: "A parent waits for one run's report").
  val oneReport = CH.forall(c => w.reported.get(c) <= 1)

  // A run that ended, with no stop still at work, has handed its report up.
  val reportOnEnd = CH.forall(c => (ENDED.contains(w.state.get(c)) and w.ending.get(c) == 0) implies w.reported.get(c) == 1)

  // whenDone resolves once the child is no longer live (team.ts:346-352).
  val waitersSettle = CH.forall(c => w.waiters.contains(c) implies (isLive(w, c) or w.ending.get(c) != 0))

  // A live child always has the work in flight that will move it on: a launch,
  // a prompt of its current launch, or a place in line.
  val noStuck = CH.forall(c => all {
    w.state.get(c) == "starting" implies w.opening.contains((c, w.launches.get(c))),
    w.state.get(c) == "running" implies w.prompts.exists(p => p.c == c and p.r == w.launches.get(c) and p.s == w.held.get(c)),
    w.state.get(c) == "queued" implies w.line.indices().exists(i => w.line[i] == c),
  })

  // maxConcurrent holds (slots.ts:1-10).
  val slotsBound = used(w) <= MAX_CONCURRENT

  // A message main sends reaches the child once: none is lost with a session
  // or read twice, and each one is read, in the inbox, in a resume prompt or
  // in the session's queue (resume-prompts.ts:1-8, mailbox.ts:1-6).
  val mailKept = w.lost == 0 and CH.forall(c => w.dup.get(c) == 0) and CH.forall(c =>
    w.sent.get(c) == w.read.get(c) + w.inbox.get(c) + (if (w.resume.get(c) < 0) 0 else w.resume.get(c)) + w.sq.get(c) + w.oq.get(c)
      + w.sp.filter(t => t._1 == c and t._4 != "copied").size())

  // A stopped, stale or released child's session makes no more model calls:
  // each prompt that will still call the model belongs to the current run of a
  // live child (team.ts:397 "Stops a child", :406 "stale from now on").
  pure def willCallModel(p: Prompt): bool =
    if (p.phase == "pre" or p.phase == "prep") not(prepStops(p))
    else if (p.phase == "active") not(p.abortReq)
    else false
  pure def wanted(x: World, p: Prompt): bool =
    not(p.disposed) and x.held.get(p.c) == p.s and x.launches.get(p.c) == p.r and isLive(x, p.c)
  val stopMeansStopped = w.prompts.forall(p => willCallModel(p) implies wanted(w, p))

  // One session for each child: a new one is held only after the old one went.
  val oneSession = not(w.leaked)

  // A stop of a child that works is not refused (team.ts:397-398: undefined
  // only "when it had already ended").
  val stopHonored = not(w.refusedLive)

  // A stop by the child's parent hands no report up, and every other end does
  // (team.ts:398-399: "Stopped `by` its own parent, no report goes up").
  val parentStopSilent = not(w.wrongSilence)

  // ---- Witnesses: states the conformance traces must reach ----
  val witnessNoRelaunchInStop = not(w.stops.exists(t => w.state.get(t._1) == "queued" or w.state.get(t._1) == "starting"))
  val witnessNoGoOn = w.goingOn == Set()
  val witnessNoFallback = CH.forall(c => w.fallbacksLeft.get(c) == FALLBACKS or not(isLive(w, c)))
  val witnessNoResumeFailed = CH.forall(c => w.state.get(c) != "interrupted")
  val witnessNoSteer = CH.forall(c => w.sq.get(c) == 0)
  val witnessNoCopy = CH.forall(c => w.sqCopy.get(c) == 0)
  val witnessNoTwoPrompts = w.prompts.size() < 2
  val witnessNoStopWait = w.stops == Set()
  // A stop waits while its child's relaunch waits in line behind a full team (4a8fa14).
  val witnessNoQueuedRelaunchInStop = not(w.stops.exists(t => w.state.get(t._1) == "queued" and not(free(w))))
  // F1's path: a stop waits for a prompt in its pre window.
  val witnessNoStopInPre = not(w.stops.exists(t => w.prompts.exists(p => p.c == t._1 and p.s == t._3 and p.phase == "pre")))
  // F2's path: a disposed prompt before its agent loop.
  val witnessNoDisposedBeforeRun = not(w.prompts.exists(p => p.disposed and (p.phase == "pre" or p.phase == "prep")))
  // F3's and F4's path: two stops of one child wait at the same time.
  val witnessNoTwoStops = not(CH.exists(c => w.stops.filter(t => t._1 == c).size() >= 2))
  // F4's path with a stop by the parent: two stops wait and the newer one is by the parent.
  val witnessNoParentStopOverStop = not(CH.exists(c => w.stops.filter(t => t._1 == c).size() >= 2 and w.byParent.get(c) != 0))
  // F4's path to its end: the older stop goes on while the newer one waits, by anyone or by the parent.
  val witnessNoStaleStopOverStop = not(w.staleOverStop)
  val witnessNoStaleStopOverParentStop = not(w.staleOverParentStop)
  // F5's path: the gate's prompt waits for a steer in flight.
  val witnessNoSteerWait = not(w.prompts.exists(p => p.phase == "steers"))
}
