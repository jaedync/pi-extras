---
name: formal-verification
description: Formally verify the part of a codebase where a bug costs the most and example tests reach the least (races, retries, cursors, locks, at-most-once delivery, reload and restart hand-over, protocol or state-machine logic). It writes a Quint model of the design with each action cited to code, checks every order of events within stated bounds with TLC, shows each property fail on a mutant that copies a code change, replays model traces against the real code in a conformance test, and leaves a record (fv.json) that one command reruns. Installs its free tools at user scope. Use when the user asks to formally verify, model-check, prove an invariant, find race or interleaving bugs, check a state machine exhaustively, or runs /skill:formal-verification [area].
---

<!-- Adapts the goals of Lauren Tan's pstack skills create-formal-verification-skill
and maintain-formal-verification-skill (MIT, https://github.com/cursor/plugins/tree/main/pstack):
the strongest target, a tool chosen with a reason, a property shown to fail on a broken
variant, findings that stay findings, honest bounds, and a sync commit. The text, the
record format, fv.mjs and the conformance replay are new. -->

# Formal verification

An example test checks the cases that someone wrote. A model checker checks
every order of events in a model, within stated bounds. Bugs in async code
often need an order that nobody wrote: a reload during a read, an ack during
a retry, a kill during an exit. This skill finds those orders.

There are two axes:

| | On a model of the design | On the code |
|---|---|---|
| **Check** (exhaustive within bounds, gives a counterexample) | Quint or TLA+ with TLC, Apalache | Kani, CBMC; property tests for TypeScript |
| **Prove** (all states, no bound) | Apalache `--inductive-invariant`, TLAPS, Lean | Verus, Dafny |

This skill does the first cell well: a Quint model checked with TLC. A model
is separate from the code, so the skill also makes a conformance test that
replays model traces against the real code. Read
[references/tools.md](references/tools.md) when the target is not a design
question (a parser, arithmetic, a Rust or C function), or when a bound is
not enough and a proof is cheap.

## Tools

`scripts/fv.mjs` (Node 22 or later, no dependencies) is the instrument.
`<skill>` below is the folder of this file.

```sh
node <skill>/scripts/fv.mjs setup                 # Quint 0.33.1 and a Temurin 21 JRE in ~/.cache/pi-formal-verification
node <skill>/scripts/fv.mjs check <record>        # every check; exit 1 when a result is not the expected one
node <skill>/scripts/fv.mjs check <record> --only <name> --trace
node <skill>/scripts/fv.mjs traces <record>       # random and witness traces for the conformance test
node <skill>/scripts/fv.mjs drift <record>        # covered files changed after the sync commit
```

`setup` installs pinned versions with checksums at user scope. Quint then
downloads Apalache (which carries TLC) and its simulator into `~/.quint` on
the first run. When a download fails, fix the cause. Do not fall back to a
weaker method, such as a hand trace or more example tests.

## Steps

1. **Pick the target.** If the user named an area or a bug, start there.
   Otherwise pick the strongest target, not the easiest one: a promise the
   code makes, where a break harms users and example tests rarely reach the
   breaking order. Good sources:
   - The findings of `/skill:implicit-state-machines`, when a report exists.
     Its "needs design thought" clusters and its loose delivery flags are
     natural models. Search earlier reports before you scan again.
   - Code with `await` between a check and the act that depends on it, retry
     and attempt counters, outboxes and acks, leases and locks, cursors,
     reload or restart hand-over, and timeouts that race a result.
   - A promise written down: a tool description, a doc comment, a README line.
   Write the promise and the harm in one sentence each. Say why this target
   beats the next two candidates.
2. **Pick the tool and say why.** The default is Quint with TLC: Quint reads
   like TypeScript, TLC explores every state and gives the shortest
   counterexample, and `quint run --mbt` writes traces that a TypeScript test
   can replay. Pick another tool when the question is about a function's
   output for every input, or when a property must hold at every size
   ([references/tools.md](references/tools.md)).
3. **Read the code and its platform.** List the synchronous segments: in
   JavaScript, the code between two `await`s runs without interruption, and
   every event handler, timer and I/O callback is its own segment. Then read
   the source of the platform the code calls (the framework, the agent host,
   the runtime) for each behavior the code relies on: when a message is
   queued or deferred, how queued work runs (all at once, or one item at a
   time with its own events), what "idle" means, which commands it refuses,
   and where the platform awaits between a check and the act. In the pilot,
   the bug was in that contract, not in the code alone.
4. **Write the model.** Follow
   [references/quint-patterns.md](references/quint-patterns.md). One action
   is one segment, with a comment that cites file:line. Use the code's names.
   Write each promise as an invariant. Keep the bounds as named values at the
   top. Put the model in the project at `formal/<area>/<name>.qnt` unless the
   user asks for another place, or the repository is not yours to change:
   then use a folder outside it and give the path.
5. **State the bounds.** Write what the bounds are (for example 2 jobs, 1
   reload, 3 attempts) and what they leave out: larger sizes, code paths
   left out of the model, platform behaviors assumed, liveness when you check
   only safety. A pass covers the model within the bounds, not the system.
6. **Run the checker and read each result.** Write `fv.json`
   ([references/record-format.md](references/record-format.md)) and run
   `fv.mjs check`. For each violation, replay the trace against the code, one
   step for each action, and judge it:
   - Each step can happen in the code: it is a **finding**. Keep the property
     and the check as they are, and set the check's `expect` to the
     violation. Do not weaken the model or the property to get a pass.
   - A step cannot happen in the code: the model is wrong. Fix the model,
     and say what was wrong.
   To check the rest of the properties under a finding, add a variant check
   that assumes the fix, and name the assumption.
7. **Show that each property can fail.** Add mutant checks. A mutant copies
   one change to the code into the model (a removed check, a reordered step,
   a read of a stale value), and must break a named invariant. Each property
   needs at least one mutant that breaks it. A mutant that breaks nothing is
   information: the guard is not needed by any behavior in the model, or a
   property is missing. Add the property, or keep it as a `survivor-` check
   with the reason.
8. **Tie the model to the code.** Write a conformance test in the project's
   test framework: it replays the traces from `fv.mjs traces` step by step
   against the real code, and after each step compares the code state with
   the model state ([references/record-format.md](references/record-format.md)
   has the pattern). Add witnesses so that the traces reach rare branches.
   Then change the real code, one guard at a time, and run the test. It must
   fail for each change that a model mutant covers. Restore the code after
   each change and confirm with `git diff` that it is clean. Report the
   changes that it did not catch and why.
9. **Check the platform rules and reproduce each finding live.** The
   conformance test runs a fake platform that copies the model's rules, so
   it cannot find a wrong platform rule. Check each rule against the real
   platform with a short script, and run the real code and the real platform
   through each counterexample. Keep these scripts next to the model, not as
   tests that expect the bug. Then ask one fresh reviewer, on a strong model,
   to read every action against the code and the platform source, with the
   severity rule of your instructions. In the pilot, that review found a
   platform rule that the model had wrong, and the fixed model found more
   paths to the bug.
10. **Record and report.** Write `formal/<area>/README.md`: the promise, the
    properties, what the model covers with file names, the bounds and what
    they leave out, the result table, each finding as numbered steps in the
    code's words, the survivors, and the commands. Set `syncCommit` to the
    commit that you checked.

## Quotas

- Every action cites file:line. Every platform behavior cites its source.
- Every invariant is broken by at least one mutant, or the report says why not.
- Every violation is judged as a finding or a model error, with the step
  that decides it.
- The conformance test replays at least 100 traces, and at least 3 code
  changes were shown to make it fail.
- Every platform rule in the model is checked against the real platform, or
  the report lists it as unchecked.
- `fv.mjs check` gives the expected result for every check before you hand off.

## Hard rules

- Findings stay findings. Never weaken a property, remove a behavior or
  shrink a bound to get a pass. Record a smaller bound in the report.
- Do not change product code unless the user asks. Propose fixes.
- Do not delete or weaken existing tests. The model adds to them.
- Move `syncCommit` only after you confirmed that the model describes the
  code at that commit.
- Clean up every scratch change to product code, and check with `git diff`.

## When the code changes later

Run `fv.mjs drift <record>`. For each changed file, read the change and
decide: no effect on the model; the model no longer describes the code (a
segment split, a check moved, a new writer of the same state); the promise
changed on purpose (cite the evidence); or the promise may be broken. Update
the model from the code, not from the result. Rerun `check` and `traces` and
the conformance test, show a mutant still fails, then move `syncCommit`.

## Report

Give the user, in plain words:

- the target, the promise and the harm, and why this target;
- the tool and why;
- each property in one sentence, the bounds, and what they leave out;
- each finding as numbered steps in the code's words, with the harm, the
  live repro result, and the fix options;
- the mutants and which property each broke, and the survivors with reasons;
- the conformance test: traces replayed, code changes caught and missed;
- the commands to rerun, and the record path.
