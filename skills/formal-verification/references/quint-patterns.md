# Modeling async code in Quint

## Shape of a model

```quint
module delivery {
  // Bounds first, as named values, so a variant can change them.
  pure val JOBS = Set("j1", "j2")
  pure val MAX_ATTEMPTS = 3

  var outbox: Set[str]
  var sends: str -> int

  action init = all { outbox' = Set(), sends' = JOBS.mapBy(_ => 0) }

  // One synchronous segment of the code. Cite it.
  // sendCompletion after `await readTail` (lib/shell-jobs-delivery.ts:66-108).
  action readDone(j: str): bool = all {
    outbox.contains(j),
    outbox' = outbox.exclude(Set(j)),
    sends' = sends.setBy(j, n => n + 1),
  }

  action step = any {
    nondet j = JOBS.oneOf()
    readDone(j),
  }

  // A promise of the code, as an invariant.
  val boundedSends = JOBS.forall(j => sends.get(j) <= MAX_ATTEMPTS)
}
```

Every action must assign every variable (`x' = x` for the ones it keeps). A
helper action such as `keepPi` that assigns a group of variables keeps this
short.

## From code to actions

- **One action, one segment.** In JavaScript, code runs without
  interruption from one `await` to the next. An `async` function with two
  awaits is three actions. State that the code reads after an `await` must
  be read again in the next action (this is where stale-read bugs live).
- **An in-flight await is state.** Model a pending promise as a member of a
  set, such as `reading: Set[(str, int)]`, added by the action that starts it
  and removed by the action that resumes after it.
- **Event handlers are actions** with the guard that the platform puts on
  them: `runEnds` needs a run to be active.
- **Microtasks run before timers.** A promise that resolves wins over a timer
  that has not fired yet, so "timeout" and "result" are often exclusive
  guards, not two racing actions. Check this before you model a race.
- **The platform is part of the model.** Read its source for each behavior
  the code relies on, and model it as actions and guards. Cite the source.
  Model the behaviors the platform allows, not the ones its users usually do.
- **Queued work is not one step.** When the platform holds work and runs it
  later, read how: a loop that awaits each item, where each item can start
  new events (a run, its own "settled" event), runs one item at a time.
  Model the items left as state (a list), and let the nested events run
  between items.
- **One operation can have several entry points.** Find every caller of a
  platform operation (a key press, an RPC command, an API for plugins), and
  read what each one does around it. In the pilot, only the key press cleared
  the queue before an abort; the RPC and plugin aborts kept it, and that gave
  the shortest path to the bug.
- **A platform check can be split from its act.** A command that checks a
  condition and then awaits before it acts (a reload that checks "not
  busy", then awaits shutdown handlers) is two actions. Other events can
  make the condition false in between.
- **Over-approximate with care.** Allowing more behaviors than the code has
  is safe for an invariant that passes, but it can give a counterexample
  that cannot happen. Judge each counterexample against the code.
- **Ghost variables** record facts that only a property or a witness reads
  (for example, "a message landed while parked"). Say in a comment that it
  is a ghost. The conformance test does not compare it.

## Finite state

TLC enumerates states, so each value must come from a finite set:

- Bound counters by a guard (`runs < MAX_RUNS`) or by the logic.
- A list that grows with no bound makes the state space infinite: TLC then
  runs without end. Give each growth a bound.
- `nondet x = S.oneOf()` on an empty set disables the action. Write the
  guard first: `all { S != Set(), nondet x = S.oneOf() act(x) }`.
- A `val` cannot assign variables. Use `action` for anything with `x'`.

## Mutants and variants

`fv.json` holds each mutant as text replacements on the model. Write the
model so that a code change is one short, unique replacement: keep each
guard on its own line, and name the values (`val suppressed = job.claimed or
job.delivered`). `fv.mjs` refuses a replacement that is not found exactly
once, so a model edit cannot turn a mutant into the unchanged model.

A variant changes an assumption, for example `pure val RELOAD_DURING_SETTLE =
false`. Use a variant to check the other properties under a finding.

## Witnesses

Random traces rarely reach some states: an attempt cap, a message that lands
during a reload. A witness is an invariant that says "this state never
happens". `fv.mjs traces` asks the simulator for a run that breaks it and
adds that run to the traces. Write one witness for each branch of the code
that the conformance test must reach. A witness that no run breaks within
the step bound shows a branch that the model cannot reach: check whether the
code can.

## Reading a TLC result

- `fv.mjs check --trace` prints each step with the variables that changed.
  A check that expects a violation runs with one worker, so the trace is the
  shortest.
- Quint compiles the invariants into one TLC invariant (`q_inv`). For a pass
  check that fails, `fv.mjs` runs each invariant alone to name the one that
  broke.
- The state count shows the size of the search. A count that does not move
  when a mutant should add behavior means that the mutant changes nothing
  that the search reaches.
