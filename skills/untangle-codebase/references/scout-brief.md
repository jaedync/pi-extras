# Scout brief

Copy this brief into each scout's task. Fill in the parts in angle brackets.
Run scouts read-only and in parallel, on a fast model.

---

List the structural problems in a batch of source files. Read-only: do not
change any file. Read **every file in your batch in full**. Do not skim and do
not sample.

Repository: <path>. Area: <area>. Your batch (<N> files, about <L> lines):
<file list>

Measured hints for your batch (candidates, not facts):
<rows from `untangle.mjs graph` and `special-cases --list all` that touch the batch>

Ask one question of every piece: should these pieces change together? Report
each place where the code gives the wrong answer, in one of these groups:

- **hidden link:** pieces that must change together, where the code does not
  show it. Copies of logic or values; a module that reads a global or file
  that another module sets; one feature spread over folders; a call order or
  a convention that callers must know.
- **needless link:** pieces tied together that change for different reasons.
  Callers that use internals; stable code that imports more volatile code; a
  general function with a parameter for one workflow; a shallow module whose
  interface follows its internals.
- **surplus:** pass-through wrappers; extension points or settings for things
  that never vary; dead code.
- **special case:** code for one situation that does not follow from how the
  system works: an `if` for one value, a parameter for one caller, a
  swallowed exception, a retry or a sleep, a disabled test.

For each finding, write one block:

```
## <short title>
- group: hidden link | needless link | surplus | special case
- where: <path:line>, <path:line>, ...
- what: <one or two sentences: what must change together, or why the tie is wrong>
- evidence: <the lines, the import, the copy, or the co-change count from the hints>
- bug: yes | no | maybe: can this cause wrong behavior now? Give the sequence of events if yes
- outside the batch: <names that this finding uses but that other files define>
- severity: high | medium | low, for how much a fix would help
- confidence: high | medium | low, with one line of reason
```

Rules:

- Cite path:line for every claim. A claim with no line is not a finding.
- One problem that you see in several of your files is one finding.
- Do not propose fixes. The lead designs them across all batches.
- At the end, list the files where you found nothing, so the lead knows that
  you read them.
- Put your whole report in your final reply. Send no message after it.
