---
name: implicit-state-machines
description: Find the implicit state machines in a codebase (state kept in loose booleans, mode enums, nullable fields or timestamps whose combinations imply phases, with transitions spread over many handlers), check each finding against the code, and sort them into clusters that need design thought, quick fixes, enum candidates and ones that are fine. Fans out read-only scout subagents over the source in batches, then one strong evaluating pass. Use when the user asks to find implicit state machines, hidden states, impossible states, state conflicts or mode flags in an app or library, or runs /skill:implicit-state-machines. It is read-only and changes no code.
---

<!-- Based on Steve Ruiz's prompt "find all of the implicit state machines in my app"
(2026-10-31, https://x.com/steveruizok/status/2116552016218710389) and the scout,
evaluate and sort method in its replies. -->

# Implicit state machines

An implicit state machine is behavior that has states and transitions, but no
place in the code names them. The states live in a combination of values, and
the transitions live in many handlers. The scan makes them explicit, because
an implicit machine often has states that conflict: two flags that can both be
true when only one should be, a transition that one handler forgets, or a
phase that no code can leave.

The scan is read-only. It reports. It does not fix.

## What counts

Count it when two or more of these are true for one concern:

- **Loose flags:** several booleans that describe one thing (`isLoading`,
  `isSaving`, `hasError`), where only some combinations make sense.
- **Mode values:** an enum, a string union or a magic string that selects
  behavior (`mode`, `status`, `phase`, `kind`), checked in many places.
- **Implied phases:** nullable fields, timestamps or counters whose presence
  or order means a phase (`startedAt && !endedAt` means "running").
- **Spread transitions:** the values change in several handlers, callbacks,
  timers or effects, and no single function owns the change.
- **Guards:** `if` checks that refuse an action in some phase, repeated in
  more than one place.
- **Retry and lifecycle loops:** attempt counters, backoff, "pending" sets,
  connect and reconnect, open and close, start and stop.

Do not count:

- One boolean with no partner and one writer.
- A real, explicit state machine (a reducer over a closed union, a statechart
  library, a class whose only state field is a union with one transition
  function). List it as "explicit" only when it shows the pattern to copy.
- Plain configuration that does not change at run time.

## Steps

1. **Map the source.** List the source files with their line counts. Leave out
   generated code, vendored code, lock files, build output and fixtures. Keep
   tests apart: read them only to confirm a finding. Say what you left out.
2. **Make batches.** Group the files by directory or feature, about 3,000 to
   6,000 lines for each batch. Each scout must read its whole batch, so keep a
   batch inside its context with room to spare. One very large file is its
   own batch.
3. **Start the scouts.** Use the subagent tool when you have it. Start one
   read-only scout for each batch, in parallel, on a fast and cheap model (the
   user's model notes say which one). Give each scout the brief in
   [references/scout-brief.md](references/scout-brief.md), with its file list
   and the definition above. With no subagent tool, do the batches yourself,
   one at a time, and say so in the report.
4. **Evaluate.** On a strong model, merge the scout findings. For a large
   scan (more than about 8 scouts), start one evaluator for each area (3 to 5
   areas, each with the reports of its scouts), so that each evaluator can
   open the code for all of its findings. Copy the scout reports to a folder
   that the evaluators can read: a read-only or sandboxed evaluator may not
   see the session folders of other subagents. Tell each scout and evaluator
   to put its whole report in its final reply and to send nothing after it:
   a later short reply can replace the saved report. If that happens, take
   the longest final text from the subagent's session file.
   - Join the findings that are one machine seen from several files.
   - **Check each claim in the code.** Open every cited file and line for each
     finding that you place in "needs design thought" or "quick fix". Scouts
     on cheap models can draw a wrong conclusion from correct lines: a guard
     that looks missing can sit in a caller, and a "conflict" can be
     impossible because one writer sets both values. Drop or correct a
     finding that the code does not support, and count the drops.
   - Look for conflicts across batches: one machine whose states are set in
     one batch and read with other assumptions in another.
5. **Sort** each checked finding into one group:
   - **Needs design thought:** a cluster of related machines, a conflict that
     can happen, or a fix that changes behavior or an interface.
   - **Quick fix:** a real bug or a missing transition with a local fix.
   - **Enum candidate:** loose flags or strings that one closed type (enum,
     discriminated union) would make safer, with low risk.
   - **Fine as it is:** small, local and correct. Name the reason.
6. **Report.** Write two parts:
   - **Summary list:** for each finding, a title, one or two sentences, the
     group, and the most important files with line numbers. Put "needs design
     thought" first.
   - **Detail document:** for each finding, the states (named), the values
     that hold them, the transitions with file:line, the conflicts or
     impossible states that can occur with a concrete sequence of events, and
     a sketch of the explicit form (a union type and one transition
     function). Add the method: batches, scouts, models, what you left out,
     how many findings the check dropped.
   Publish the report as a page when you have a publishing tool. Otherwise
   write it to a Markdown file and give the path.

## Quotas

- Every source file is in exactly one batch, and its scout reads all of it.
- Every finding cites file:line for each state value and for each transition.
- The evaluator opens the code for every finding outside "fine as it is".
- The report says how many findings the scouts made, how many the check
  dropped or merged, and how many remain in each group.

## Hard rules

- Change no code, and create no branch or commit. The user decides what to fix.
- A conflict is a claim. Give the sequence of events that reaches it, or mark
  it "possible, not shown".
- Do not inflate the count. One machine seen in five files is one finding.
