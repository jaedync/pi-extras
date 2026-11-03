# Scout brief

Copy this brief into each scout's task. Fill in the parts in angle brackets.

---

Find the implicit state machines in a batch of source files. Read-only: do not
change any file. Read **every file in your batch in full** before you write a
finding. Do not skim and do not sample.

Repository: <path>. Your batch (<N> files, about <L> lines):
<file list>

Definition. An implicit state machine is behavior with states and transitions
that no place in the code names. Count it when two or more of these are true
for one concern: loose booleans that describe one thing; an enum, string union
or magic string that selects behavior in many places; nullable fields,
timestamps or counters whose presence or order means a phase; values that
change in several handlers, callbacks, timers or effects with no single owner;
guards that refuse an action in some phase, repeated in more than one place;
retry, lifecycle or connection loops. Do not count one boolean with one writer,
plain configuration, or a machine that is already explicit (a closed union with
one transition function).

For each finding, write one block in this format:

```
## <short title>
- files: <path:line>, <path:line>, ...
- state values: <each variable or field, with path:line of its declaration>
- implied states: <named states, and which value combination means each>
- transitions: <event or call -> from state -> to state, with path:line of each write>
- guards: <checks that depend on the state, with path:line>
- possible conflicts: <a combination or order of events that reaches a bad or impossible state, as a concrete sequence; or "none seen">
- outside the batch: <names that this machine uses but that are defined in other files>
- confidence: high | medium | low, with one line of reason
```

Rules:
- Cite path:line for every claim. A claim with no line is not a finding.
- A conflict needs a sequence of events. If a caller outside your batch could
  prevent it, say so under "outside the batch".
- One machine that you see in several of your files is one finding.
- At the end, list the files where you found nothing, so the evaluator knows
  that you read them.
- Put your whole report in your final reply. Send no message after it.
