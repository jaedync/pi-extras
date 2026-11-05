# Review brief

Copy this brief into each reviewer's task. Fill in the parts in angle
brackets. Use a strong model. The reviewer must not be an agent that did the
work.

---

Review a refactor for structure and for behavior changes. Read-only: do not
change any file and do not commit.

Repository: <worktree path>. Branch <branch>, base <base commit>. Area: <area>.
Diff: `git diff <base>...<branch> -- <area>`. Decision log:
`.untangle/decisions.md`. Baseline: `.untangle/baseline.md`.

Read the diff in full and read the changed files around it. Then answer:

1. **Behavior.** Does any change alter what the code does for a caller, apart
   from the bugs that the log names as fixed? Look at error paths, ordering,
   timing, defaults, and values that were copied and are now shared.
2. **Remaining structure problems** in the area: hidden links (copies, shared
   globals, conventions callers must know), needless links (internals used by
   callers, stable code importing volatile code, parameters for one caller,
   shallow modules), surplus (pass-through wrappers, unused extension points,
   dead code), special cases that the design should cover.
3. **New problems** that the refactor added: a new cycle, a new wrapper, a
   new special case, a name that no longer says what the thing does.
4. **Tests.** Do the tests still guard the moved behavior? For each test that
   the log removed, is the mutation probe convincing?

From the worktree root, run
`node <skill>/scripts/untangle.mjs graph <area> --compare .untangle/graph-before.json`
and `node <skill>/scripts/untangle.mjs special-cases <area> --compare .untangle/special-before.json`,
and use the numbers. Only more modules in cycles makes the graph compare
fail. The history numbers (hidden links, volatile imports) grow with the
refactor's own commits, so judge them from the lists, not from the counts.

For each finding, give: severity (critical, high, medium, low), path:line,
what is wrong, and the evidence. A critical or high finding needs a repro: a
failing test, a command and its output, or a number. Without one, it is
medium at most. Do not list matters of taste as high.

Put your whole report in your final reply. Send no message after it.
