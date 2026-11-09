// Rate-limit recovery: a model of the three wait machines of
// lib/rate-limit-recovery (quota hibernation in controller.ts, the in-run
// transient backoff in transient.ts, and the local idle wait in idle-wait.ts)
// and the Pi run that feeds them events. Each action is one synchronous
// segment of the code (the code between two awaits), so the checker tries
// every order in which the event loop can run them. The file:line comments
// name the code each action stands for, at the syncCommit of fv.json.
//
// The error classification (core.ts parseRateLimit, transient.ts
// isTransientRateLimit and connectionFailure, local.ts localTarget) is not
// modeled: each failed request picks one error kind nondeterministically.
//
// Pi 1.4.0: dist/core/agent-session.js (AS), dist/core/agent-session-runtime.js
// (ASR), dist/modes/interactive/interactive-mode.js (IM), and
// pi-agent-core dist/agent-loop.js (AL) and dist/agent.js (AG).
module recovery {
  // ---- Bounds. A pass covers only these sizes (README.md). ----
  pure val MAX_RECOVERIES = 2   // config.maxRecoveries (hibernations per run)
  pure val BUDGET = 2           // config.maxWaitSeconds, in units of one quota wait
  pure val MAX_STREAK = 2       // transient waits per streak that the budget allows
  pure val MAX_REQUESTS = 3     // model requests (context events) in a trace
  pure val MAX_INPUTS = 2       // user prompts and other extension messages
  pure val MAX_SELECTS = 1      // model switches
  pure val MAX_CANCELS = 1      // Esc presses and /rate-limit-recovery cancel
  pure val MAX_RELOADS = 1
  pure val MAX_CLONES = 1
  pure val MAX_NAVS = 2         // session_start(resume) and /tree navigations, shared

  // ---- Platform switches. The faithful model is Pi as it is. ----
  // Another extension's agent_before_settle handler can return continue
  // (AS:1566-1590: shouldContinue = result.continue || hasQueuedMessages),
  // and Pi's own retry or compaction can continue the run (AS:1531-1561).
  pure val OTHER_EXTENSION_CONTINUES = true
  // /clone is fork(leaf, { position: "at" }) (IM:4581-4588). It copies the
  // whole branch, custom entries too (session-manager.js:1205-1237), and the
  // new session gets session_start with reason "fork" (ASR:216-230).
  pure val CLONE_COPIES_ENTRIES = true

  // ---- Fix switches (variants only). ----
  // F2 fix: any new request of a run ends the idle wait, as a new run does.
  pure val CONTEXT_ENDS_IDLE_WAIT = false
  // F1 fix: a session_start of a fork closes a copied open entry.
  pure val FORK_CLOSES_ENTRY = false
  // F3 fix: a session_start that does not restore an open entry closes it.
  pure val START_CLOSES_STALE_ENTRY = false
  // F4 fix as first proposed: a session_tree handler ends the idle wait. Pi
  // moves the leaf before it emits session_tree (agent-session.js:3379-3398),
  // so the closed entry goes to the new branch (round-2 review, F5).
  pure val TREE_ENDS_IDLE_WAIT = false
  // F4 and F5 fix: a session_before_tree handler ends the idle wait, so the
  // closed entry goes to the old branch before the leaf moves.
  pure val TREE_CLOSES_BEFORE_MOVE = false

  pure val KINDS = Set("ok", "quota", "cloud", "local", "other")
  pure val MODELS = Set("a1", "a2", "oa", "loc")
  // sameScope of core.ts: both anthropic models share one cooldown scope.
  pure def scopeOf(m: str): str = if (m == "a1" or m == "a2") "anthropic" else m

  // ---- Pi session state ----
  // "idle" | "starting" (before the next context event) | "request" |
  // "msgDone" (message_end ran, turn_end not yet) | "waitT" | "waitH" (our
  // turn_end handler awaits a wait) | "post" (agent_end, _handlePostAgentRun) |
  // "settle" (agent_before_settle handlers).
  var phase: str
  var aborted: bool       // _agentRunAbortRequested and the run's ctx.signal
  var queued: int         // the agent's steering queue
  var settleGo: bool      // our agent_before_settle handler returned continue
  var model: str          // ctx.model
  // ---- Recovery (controller.ts:53-73) ----
  var qPending: str       // pending: "none" | "eligible" | "ineligible"
  var qReady: bool        // ready
  var attempts: int
  var spent: int          // spentMs, in quota-wait units
  var hActive: bool       // active (a hibernation in flight)
  // ---- TransientBackoff (transient.ts:238-249) ----
  var tPending: str       // pending: "none" | "cloud" | "local"
  var tReady: bool
  var tActive: bool
  var streak: int         // streaks["rate-limit"].attempts
  // ---- LocalIdleWait (idle-wait.ts:92-95) and its session entry ----
  var iActive: bool       // active (waiting)
  var entryOpen: bool     // the last local-wait entry on the branch is "open"
  var offOpen: bool       // the same, on the other branch that /tree can go back to
  var idleEndedBy: str    // ghost: "none" | "user" | "other", the run that ended an idle wait
  // ---- Ghosts: only properties and witnesses read them ----
  // A failure of this session waits for its one resume: set when a wait
  // starts for it, cleared by the resume, by any later request, by a run that
  // the user or another extension starts, and by a cancel.
  var owed: bool
  var badResume: bool     // a resume happened with nothing owed
  var lastKind: str
  var resumes: int        // resumes in the trace (witness)
  // Bound counters.
  var requests: int
  var inputs: int
  var selects: int
  var cancels: int
  var reloads: int
  var clones: int
  var navs: int

  action init = all {
    phase' = "idle", aborted' = false, queued' = 0, settleGo' = false, model' = "a1",
    qPending' = "none", qReady' = false, attempts' = 0, spent' = 0, hActive' = false,
    tPending' = "none", tReady' = false, tActive' = false, streak' = 0,
    iActive' = false, entryOpen' = false, idleEndedBy' = "none",
    owed' = false, badResume' = false, lastKind' = "none", resumes' = 0,
    requests' = 0, inputs' = 0, selects' = 0, cancels' = 0, reloads' = 0, clones' = 0, navs' = 0, offOpen' = false,
  }

  // ---- Keep helpers ----
  action keepPi = all { phase' = phase, aborted' = aborted, queued' = queued, settleGo' = settleGo, model' = model }
  action keepQ = all { qPending' = qPending, qReady' = qReady, attempts' = attempts, spent' = spent, hActive' = hActive }
  action keepT = all { tPending' = tPending, tReady' = tReady, tActive' = tActive, streak' = streak }
  action keepI = all { iActive' = iActive, entryOpen' = entryOpen, idleEndedBy' = idleEndedBy }
  action keepGhost = all { owed' = owed, badResume' = badResume, lastKind' = lastKind, resumes' = resumes }
  action keepBounds = all { requests' = requests, inputs' = inputs, selects' = selects, cancels' = cancels, reloads' = reloads, clones' = clones, navs' = navs, offOpen' = offOpen }

  // planWait (core.ts:63-71) with one unit per quota wait.
  val planOk = attempts < MAX_RECOVERIES and spent < BUDGET
  val running = phase != "idle"

  // ---- A new run: _startRun (AS:1423-1431) emits before_agent_start in
  // _prepareRun (AS:1471-1478). The Recovery handler: controller.ts:142-153.
  // kind: "user" | "other" (a shell job or subagent report) | "resume" (the
  // idle wait's own message).
  // idleBefore and entryBefore: the idle wait and its entry as
  // before_agent_start sees them. The idle wait closes both before it sends
  // its resume (idle-wait.ts:126-138, :176-182).
  action startRun(kind: str, idleBefore: bool, entryBefore: bool): bool = {
    val resumed = kind == "resume"
    val carried = not(resumed) and kind != "user" and idleBefore
    all {
      phase' = "starting", aborted' = false, queued' = queued, settleGo' = false,
      // controller.ts:143
      qPending' = "none", attempts' = 0, spent' = 0, hActive' = hActive,
      // resumed: transient.resume() (transient.ts:291-295); carried:
      // yieldToRun() and resume(); else idleWait.cancel() and transient.reset().
      tPending' = "none", tActive' = tActive,
      qReady' = false, tReady' = false,   // before_agent_start clears ready
      streak' = if (resumed or carried) streak else 0,
      iActive' = if (resumed) idleBefore else false,
      // Ghost: which kind of run ended an idle wait (a witness reads it).
      idleEndedBy' = if (not(resumed) and idleBefore) kind else idleEndedBy,
      // cancel() and yieldToRun() record a closed entry (idle-wait.ts:116-124).
      entryOpen' = if (resumed or not(idleBefore)) entryBefore else false,
    }
  }

  // ---- The idle wait's resume: pi.sendMessage(..., { triggerTurn: true })
  // (controller.ts:106). sendCustomMessage steers into an active run
  // (AS:1857-1862), else starts one (AS:1864-1870). A send during agent_settled
  // waits and then starts a run (AS:1865-1867); this model folds that wait.
  action sendResume: bool = all {
    model' = model,
    if (running) all {
      phase' = phase, aborted' = aborted, queued' = queued + 1, settleGo' = settleGo,
      keepQ, tPending' = tPending, tReady' = tReady, tActive' = tActive, streak' = streak,
      iActive' = false, entryOpen' = false, idleEndedBy' = idleEndedBy,
    } else all {
      startRun("resume", false, false),
    },
    badResume' = (badResume or not(owed)),
    owed' = false, lastKind' = lastKind, resumes' = resumes + 1,
  }

  // ---- Inputs ----

  // A user prompt. While a run is active, the TUI queues it as a steer
  // (IM:2676-2681, AS prompt). When idle, it starts a run.
  action userPrompt: bool = all {
    inputs < MAX_INPUTS,
    model' = model,
    if (running) all {
      phase' = phase, aborted' = aborted, queued' = queued + 1, settleGo' = settleGo,
      keepQ, keepT, keepI, keepGhost,
    } else all {
      startRun("user", iActive, entryOpen),
      owed' = false, badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
    },
    inputs' = inputs + 1, requests' = requests, selects' = selects, cancels' = cancels, reloads' = reloads, clones' = clones, navs' = navs, offOpen' = offOpen,
  }

  // A shell job or subagent report: sendMessage with triggerTurn, which
  // steers into an active run or starts one (AS:1857-1870).
  action otherMessage: bool = all {
    inputs < MAX_INPUTS,
    model' = model,
    if (running) all {
      phase' = phase, aborted' = aborted, queued' = queued + 1, settleGo' = settleGo,
      keepQ, keepT, keepI, keepGhost,
    } else all {
      startRun("other", iActive, entryOpen),
      owed' = false, badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
    },
    inputs' = inputs + 1, requests' = requests, selects' = selects, cancels' = cancels, reloads' = reloads, clones' = clones, navs' = navs, offOpen' = offOpen,
  }

  // ---- The request ----

  // The context event before each request (controller.ts:129-134): it clears
  // both ready flags. Pi emits it for each request of a run, also after
  // agent.continue() (AL:124-128 prepareRequest).
  action context: bool = all {
    phase == "starting",
    requests < MAX_REQUESTS,
    // The loop takes every queued steering message into this request: it
    // polls the queue when it starts (AL:89-90) and before each next turn
    // (AL:114-117), before prepareRequest emits context.
    phase' = "request", aborted' = aborted, queued' = 0, settleGo' = false, model' = model,
    qPending' = qPending, attempts' = attempts, spent' = spent, hActive' = hActive,
    tPending' = tPending, tActive' = tActive, streak' = streak,
    qReady' = false, tReady' = false,   // context clears ready
    if (CONTEXT_ENDS_IDLE_WAIT) all { iActive' = false, entryOpen' = if (iActive) false else entryOpen, idleEndedBy' = idleEndedBy }
    else keepI,
    owed' = false, badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
    requests' = requests + 1, inputs' = inputs, selects' = selects, cancels' = cancels, reloads' = reloads, clones' = clones, navs' = navs, offOpen' = offOpen,
  }

  // message_end of the reply (controller.ts:225-241 and transient.ts:329-376).
  // An abort during the request gives stopReason "aborted", which neither
  // backoff takes (transient.ts:336-339, controller.ts:226-230).
  action messageEnd(kind: str): bool = {
    val k = if (aborted) "aborted" else kind
    all {
      phase == "request",
      phase' = "msgDone", aborted' = aborted, queued' = queued, settleGo' = settleGo, model' = model,
      // controller.ts:227, eligible at :237 (inScope: the limit's scope is the selected model's)
      qPending' = if (k == "quota") (if (planOk and scopeOf(model) == "anthropic") "eligible" else "ineligible") else "none",
      attempts' = attempts, spent' = spent, hActive' = hActive,
      // transient.ts:355-375: a wait is planned while the streak has budget (planTransient :87-98).
      tPending' = if (k == "cloud" and streak < MAX_STREAK) "cloud" else if (k == "local") "local" else "none",
      tActive' = tActive,
      qReady' = false, tReady' = false,   // message_end clears ready
      // A good reply ends every streak (transient.ts:336).
      streak' = if (k == "ok") 0 else streak,
      keepI,
      owed' = owed, badResume' = badResume, lastKind' = k, resumes' = resumes,
      keepBounds,
    }
  }

  // Our turn_end handler up to its first await (controller.ts:285-300,
  // transient.ts:378-395, controller.ts:256-263). Pi awaits it inside
  // finishTurn before turn_end and agent_end (AL:148-158, AS:507-523).
  action turnEnd: bool = {
    val candidate = qPending
    val transientWait = tPending != "none" and not(aborted)
    all {
      phase == "msgDone",
      qPending' = "none", tPending' = "none",
      aborted' = aborted, queued' = queued, settleGo' = settleGo, model' = model,
      qReady' = qReady, spent' = spent,
      tReady' = tReady, streak' = streak,
      if (transientWait and tPending == "local") all {
        // handedToIdle (transient.ts:440-446) -> LocalIdleWait.start: stop() an
        // older wait with no record, write the open entry (idle-wait.ts:97-103).
        // The run ends; the idle wait goes on outside it.
        phase' = "post", tActive' = tActive, iActive' = true, entryOpen' = true, idleEndedBy' = idleEndedBy,
        attempts' = attempts, hActive' = hActive, owed' = true,
      } else if (transientWait) all {
        // The in-run wait starts (transient.ts:396-422).
        phase' = "waitT", tActive' = true, keepI, attempts' = attempts, hActive' = hActive, owed' = true,
      } else if (candidate == "eligible" and lastKind == "quota"
                 and planOk
                 and not(aborted) and scopeOf(model) == "anthropic") all {
        // hibernate up to its await (controller.ts:256-272).
        phase' = "waitH", hActive' = true, attempts' = attempts + 1, tActive' = tActive, keepI, owed' = true,
      } else all {
        phase' = "post", tActive' = tActive, keepI, attempts' = attempts, hActive' = hActive, owed' = owed,
      },
      badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
      keepBounds,
    }
  }

  // The transient wait's timer ends (transient.ts:423-437): the streak grows
  // and ready is set. agent_before_settle consumes it.
  action transientTimer: bool = all {
    phase == "waitT",
    tActive,
    phase' = "post", aborted' = aborted, queued' = queued, settleGo' = settleGo, model' = model,
    keepQ,
    tPending' = tPending, tActive' = false, tReady' = true, streak' = streak + 1,
    keepI, keepGhost, keepBounds,
  }

  // The hibernation's timer ends (controller.ts:274-283): spentMs grows and
  // ready is set, unless the wait was cancelled, the run aborted, a session
  // boundary moved the generation, or the model left the scope.
  action hibernateTimer: bool = all {
    phase == "waitH",
    hActive,
    val resume = not(aborted) and scopeOf(model) == "anthropic"
    all {
      phase' = "post", aborted' = aborted, queued' = queued, settleGo' = settleGo, model' = model,
      qPending' = qPending, attempts' = attempts, hActive' = false,
      qReady' = if (resume) true else qReady,
      spent' = if (resume) spent + 1 else spent,
    },
    keepT, keepI, keepGhost, keepBounds,
  }

  // ---- After turn_end: agent_end, then _handlePostAgentRun (AS:1531-1561)
  // and the loop of _startRun (AS:1440-1460). An abort ends the run; queued
  // messages continue it with agent.continue() and no agent_before_settle;
  // else agent_before_settle runs. Our handler: controller.ts:302-308.
  action postRun: bool = all {
    phase == "post",
    if (aborted) all {
      phase' = "idle", queued' = queued, settleGo' = false, keepQ, keepT, keepGhost,
    } else if (queued > 0) all {
      // agent.continue() drains the steering queue (AG:254-276, AL:89-90).
      phase' = "starting", queued' = 0, settleGo' = false, keepQ, keepT, keepGhost,
    } else all {
      // beforeSettle consumes both flags (controller.ts:302-308).
      val go = qReady or tReady
      all {
        phase' = "settle", queued' = queued, settleGo' = go,
        qPending' = qPending, qReady' = false, attempts' = attempts, spent' = spent, hActive' = hActive,
        tPending' = tPending, tReady' = false, tActive' = tActive, streak' = streak,
        badResume' = (badResume or (go and not(owed))),
        owed' = if (go) false else owed,
        lastKind' = lastKind, resumes' = if (go) resumes + 1 else resumes,
      }
    },
    aborted' = aborted, model' = model, keepI, keepBounds,
  }

  // The end of _runBeforeSettleBoundary (AS:1566-1590): an abort during the
  // handlers stops the run; continue when a handler asked or messages wait.
  // Then agent_settled ends the run (AS:1461-1468, AS:683-705).
  action settleEnd(otherGo: bool): bool = all {
    phase == "settle",
    otherGo implies OTHER_EXTENSION_CONTINUES,
    val go = not(aborted) and (settleGo or queued > 0 or otherGo)
    all {
      phase' = if (go) "starting" else "idle",
      queued' = if (go) 0 else queued,
    },
    aborted' = aborted, settleGo' = false, model' = model,
    keepQ, keepT, keepI, keepGhost, keepBounds,
  }

  // ---- The idle wait ends: the server answered, or the 10 min timer ran
  // out (idle-wait.ts:147-179). It closes its entry, then resumes.
  action idleWaitEnds: bool = all {
    iActive,
    sendResume,
    keepBounds,
  }

  // ---- Model switch (controller.ts:134-140). setModel has no streaming
  // guard (AS:2008-2024), so it can come at any time.
  action modelSelect(m: str): bool = all {
    selects < MAX_SELECTS,
    m != model,
    // A hibernation of another scope is cancelled: Recovery.cancel() aborts
    // the wait and the run (controller.ts:243-248). In the TUI, ctx.abort()
    // clears the queues first (IM:1478-1480, AS:2819-2824).
    val leftScope = hActive and scopeOf(m) != "anthropic"
    val cancelH = leftScope
    // transient.skip() ends the wait now and resumes (transient.ts:324, :428-451).
    val skipT = tActive and phase == "waitT"
    // idleWait.skip(): a wait for another model ends and resumes (idle-wait.ts:126-138).
    val skipI = iActive and m != "loc"
    all {
      if (skipI) all {
        // The resume of skip() happens after the transient bookkeeping, but
        // in the same segment.
        if (running) all {
          queued' = (if (cancelH) 0 else queued) + 1,
          phase' = if (cancelH or skipT) "post" else phase,
          aborted' = (aborted or cancelH), settleGo' = settleGo,
          qPending' = if (cancelH) "none" else qPending, qReady' = if (cancelH) false else qReady,
          attempts' = attempts, spent' = spent, hActive' = if (cancelH) false else hActive,
          tPending' = if (cancelH) "none" else tPending,
          tReady' = if (cancelH) false else if (skipT) true else tReady,
          tActive' = if (skipT) false else tActive,
          streak' = if (skipT) streak + 1 else streak,
          iActive' = false, entryOpen' = false, idleEndedBy' = idleEndedBy,
        } else all {
          startRun("resume", false, false),
        },
        badResume' = (badResume or not(owed)),
        owed' = false,
        resumes' = resumes + 1,
      } else all {
        phase' = if (cancelH or skipT) "post" else phase,
        aborted' = (aborted or cancelH),
        queued' = if (cancelH) 0 else queued, settleGo' = settleGo,
        qPending' = if (cancelH) "none" else qPending, qReady' = if (cancelH) false else qReady,
        attempts' = attempts, spent' = spent, hActive' = if (cancelH) false else hActive,
        tPending' = if (cancelH) "none" else tPending,
        tReady' = if (cancelH) false else if (skipT) true else tReady,
        tActive' = if (skipT) false else tActive,
        streak' = if (skipT) streak + 1 else streak,
        keepI,
        // Ghost: leaving the limit's scope ends what the hibernation owes.
        badResume' = badResume, owed' = if (leftScope) false else owed, resumes' = resumes,
      },
      model' = m,
    },
    lastKind' = lastKind,
    selects' = selects + 1, requests' = requests, inputs' = inputs, cancels' = cancels, reloads' = reloads, clones' = clones, navs' = navs, offOpen' = offOpen,
  }

  // ---- Esc. While a run is active, the wait lines listen first
  // (wait.ts:51-57): the transient line calls transient.cancel(), the
  // hibernation line Recovery.cancel(), the idle line idleWait.cancel() (with
  // an empty editor). Then Pi's onEscape clears the queues and aborts
  // (IM:2377-2379, IM:3852-3869, AS:1971-1981). While idle, only the idle
  // line acts (controller.ts:44-47, idle-wait.ts:116-124).
  action esc: bool = all {
    cancels < MAX_CANCELS,
    running or iActive,
    if (running) all {
      phase' = if (phase == "waitT" or phase == "waitH") "post" else phase,
      aborted' = true, queued' = 0, settleGo' = settleGo,
    } else all {
      phase' = phase, aborted' = aborted, queued' = queued, settleGo' = settleGo,
    },
    model' = model,
    qPending' = if (hActive) "none" else qPending, qReady' = if (hActive) false else qReady,
    attempts' = attempts, spent' = spent, hActive' = false,
    tPending' = if (tActive or hActive) "none" else tPending,
    tReady' = if (tActive or hActive) false else tReady,
    tActive' = false, streak' = streak,
    iActive' = false, entryOpen' = if (iActive) false else entryOpen, idleEndedBy' = idleEndedBy,
    owed' = false, badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
    cancels' = cancels + 1, requests' = requests, inputs' = inputs, selects' = selects, reloads' = reloads, clones' = clones, navs' = navs, offOpen' = offOpen,
  }

  // /rate-limit-recovery cancel (controller.ts:312). Extension commands run
  // at once, also while a run is active (AS:1636-1644). Recovery.cancel()
  // (controller.ts:243-248) aborts the run only through a hibernation's ctx.
  action cancelCommand: bool = all {
    cancels < MAX_CANCELS,
    phase' = if (phase == "waitT" or phase == "waitH") "post" else phase,
    aborted' = (aborted or hActive), queued' = if (hActive) 0 else queued, settleGo' = settleGo, model' = model,
    qPending' = "none", qReady' = false, attempts' = attempts, spent' = spent, hActive' = false,
    tPending' = "none", tReady' = false, tActive' = false, streak' = streak,
    iActive' = false, entryOpen' = if (iActive) false else entryOpen, idleEndedBy' = idleEndedBy,
    owed' = false, badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
    cancels' = cancels + 1, requests' = requests, inputs' = inputs, selects' = selects, reloads' = reloads, clones' = clones, navs' = navs, offOpen' = offOpen,
  }

  // ---- /reload. The TUI refuses it while a run is active (IM:5328-5332).
  // session_shutdown of the old module (controller.ts:160): idleWait.stop(true)
  // keeps the entry open. A new Recovery, then session_start(reload)
  // (controller.ts:154-158, AS:2998-3030): restoreIdleWait restores an open
  // entry younger than 48 h (controller.ts:168-180). The model assumes it is.
  action reload: bool = all {
    reloads < MAX_RELOADS,
    not(running),
    phase' = phase, aborted' = false, queued' = queued, settleGo' = false, model' = model,
    qPending' = "none", qReady' = false, attempts' = 0, spent' = 0, hActive' = false,
    tPending' = "none", tReady' = false, tActive' = false, streak' = 0,
    // stop(true) writes an open entry for a wait that is active (idle-wait.ts:143-147).
    iActive' = (entryOpen or iActive), entryOpen' = (entryOpen or iActive), idleEndedBy' = idleEndedBy,
    keepGhost,
    reloads' = reloads + 1, requests' = requests, inputs' = inputs, selects' = selects, cancels' = cancels, clones' = clones, navs' = navs, offOpen' = offOpen,
  }

  // ---- /clone while idle: a new session with a copy of the branch
  // (ASR:174-235). session_start(fork) restores nothing (controller.ts:158).
  // The failure belongs to the old session, so nothing is owed in the new one.
  action clone: bool = all {
    clones < MAX_CLONES,
    not(running),
    phase' = phase, aborted' = false, queued' = queued, settleGo' = false, model' = model,
    qPending' = "none", qReady' = false, attempts' = 0, spent' = 0, hActive' = false,
    tPending' = "none", tReady' = false, tActive' = false, streak' = 0,
    iActive' = false, idleEndedBy' = idleEndedBy,
    entryOpen' = (CLONE_COPIES_ENTRIES and entryOpen and not(FORK_CLOSES_ENTRY)),
    owed' = false, badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
    clones' = clones + 1, requests' = requests, inputs' = inputs, selects' = selects, cancels' = cancels, reloads' = reloads, navs' = navs, offOpen' = false,
  }

  // ---- The user leaves the session while idle and comes back: /resume away
  // and back (ASR newSession, switchSession) or a new `pi --continue`.
  // session_shutdown of the old module: idleWait.stop(true) keeps the entry
  // open (controller.ts:160). session_start(resume) (controller.ts:154-158):
  // restoreIdleWait with RESTART_RESTORE_MAX_AGE_MS, 10 min (idle-wait.ts:20).
  // late: the user came back after that limit. openWait refuses the entry
  // (idle-wait.ts:63), and nothing closes it. The code gives the failure up on
  // purpose, so no resume is owed after a late return.
  action leave(late: bool): bool = {
    // stop(true) writes an open entry for a wait that is active (idle-wait.ts:143-147).
    val open = entryOpen or iActive
    all {
      navs < MAX_NAVS,
      not(running),
      phase' = phase, aborted' = false, queued' = queued, settleGo' = false, model' = model,
      qPending' = "none", qReady' = false, attempts' = 0, spent' = 0, hActive' = false,
      tPending' = "none", tReady' = false, tActive' = false, streak' = 0,
      iActive' = (open and not(late)),
      entryOpen' = (open and not(late and START_CLOSES_STALE_ENTRY)),
      idleEndedBy' = idleEndedBy,
      owed' = (owed and not(late)), badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
      navs' = navs + 1, offOpen' = offOpen, requests' = requests, inputs' = inputs, selects' = selects, cancels' = cancels, reloads' = reloads, clones' = clones,
    }
  }

  // ---- /tree while idle: AgentSession.navigateTree. The TUI aborts only a
  // run that is active (IM:4645-4650), and the controller has no session_tree
  // handler (controller.ts:123-165), so the idle wait goes on.
  // The model holds two branches: this one and one other.
  // keepsEntry: the move stays on this branch (the failure and its entry stay).
  // Else the user goes to the other branch: at first a point before the
  // failure, later back. Pi moves the leaf, then emits session_tree
  // (agent-session.js:3379-3398), so an entry that a session_tree handler
  // writes goes to the new branch. No resume is owed after a move away.
  action tree(keepsEntry: bool): bool = {
    // Fixes: TREE_CLOSES_BEFORE_MOVE closes on this branch before the move;
    // TREE_ENDS_IDLE_WAIT closes on the new branch after it. cancel() writes
    // a closed entry only for a wait that is active (idle-wait.ts:118-119).
    val ends = TREE_CLOSES_BEFORE_MOVE or TREE_ENDS_IDLE_WAIT
    val here = entryOpen and not(TREE_CLOSES_BEFORE_MOVE and iActive)
    all {
      navs < MAX_NAVS,
      not(running),
      keepPi, keepQ, keepT,
      iActive' = (iActive and not(ends)),
      entryOpen' = if (keepsEntry) (entryOpen and not(ends and iActive)) else (offOpen and not(TREE_ENDS_IDLE_WAIT and iActive)),
      offOpen' = if (keepsEntry) offOpen else here,
      idleEndedBy' = idleEndedBy,
      owed' = (owed and keepsEntry), badResume' = badResume, lastKind' = lastKind, resumes' = resumes,
      navs' = navs + 1, requests' = requests, inputs' = inputs, selects' = selects, cancels' = cancels, reloads' = reloads, clones' = clones,
    }
  }

  // Nothing more happens: keeps TLC from reporting a deadlock at the bounds.
  action stutter: bool = all {
    keepPi, keepQ, keepT, keepI, keepGhost, keepBounds,
  }

  action step = any {
    userPrompt,
    otherMessage,
    context,
    nondet kind = KINDS.oneOf()
    messageEnd(kind),
    turnEnd,
    transientTimer,
    hibernateTimer,
    postRun,
    nondet otherGo = Set(true, false).oneOf()
    settleEnd(otherGo),
    idleWaitEnds,
    nondet m = MODELS.oneOf()
    modelSelect(m),
    esc,
    cancelCommand,
    reload,
    clone,
    nondet late = Set(true, false).oneOf()
    leave(late),
    nondet keepsEntry = Set(true, false).oneOf()
    tree(keepsEntry),
    stutter,
  }

  // ---- Properties ----

  // At most one wait at a time: hibernation, the in-run backoff and the idle wait.
  val oneWait = (if (hActive) 1 else 0) + (if (tActive) 1 else 0) + (if (iActive) 1 else 0) <= 1

  // A resume (agent_before_settle continue, or the idle wait's message) only
  // for a failure of this session that nothing else carried on, cancelled or
  // resumed before.
  val resumeOwed = not(badResume)

  // The attempt and wait budgets of hibernation and of the transient streak.
  val withinBudgets = attempts <= MAX_RECOVERIES and spent <= BUDGET and streak <= MAX_STREAK

  // An open entry on the branch always has a live wait behind it while the
  // session is open: no wait is left for a later reload to start.
  val openEntryHasWait = entryOpen implies iActive

  // ---- Witnesses (false in a rare state; traces reach it) ----
  val witnessNoHibernateResume = not(qReady)
  val witnessNoTransientResume = not(tReady)
  val witnessNoAttemptCap = attempts < MAX_RECOVERIES
  val witnessNoStreakCap = streak < MAX_STREAK
  val witnessNoRestore = not(reloads > 0 and iActive)
  val witnessNoUserEndsIdle = idleEndedBy != "user"
  val witnessNoOtherEndsIdle = idleEndedBy != "other"
  // A late return left an open entry with no wait behind it (F3).
  val witnessNoLateReturn = not(navs > 0 and entryOpen and not(iActive))
  // /tree left the idle wait running with its entry off the branch (F4).
  val witnessNoTreeAway = not(navs > 0 and iActive and not(entryOpen))
  // /tree left an open entry on the other branch (F5).
  val witnessNoOffOpen = not(offOpen)
  // Two moves, then a /reload that restores a wait (the F5 path).
  val witnessNoBackThenRestore = not(navs == MAX_NAVS and reloads > 0 and iActive)

  val safety = oneWait and resumeOwed and withinBudgets
}
