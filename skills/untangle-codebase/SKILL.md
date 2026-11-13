---
name: untangle-codebase
description: Refactor a codebase or one area of it so that pieces that change together sit together, with every hidden or needless link and special case listed at file:line, small tested commits, a measured result, and optional passes that remove comments that restate the code and tests that cannot catch a bug. Use when the user runs /skill:untangle-codebase or asks to untangle, de-tangle or restructure a codebase for agents.
disable-model-invocation: true
argument-hint: "[area or concern to focus on]"
---

<!-- Based on "untangle-codebase" by Maze (caldoai/skills, MIT, commit 442c299,
https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md).
This version adds the instruments, the baseline, the branch, the stop rule and
the measured report. -->

# Untangle a codebase

Refactor the code so that an agent reads less for each change, breaks less
without noticing, and finds root causes faster. Treat it as a goal: finish it,
inside the budget (see Hard rules).

Ask one question of every piece: **should these pieces change together?**
Fix every place where the code gives the wrong answer.

If the user gave an area (a folder, a feature, a concern), work only there.
Code outside the area changes only to follow an interface change of the area
(see Hard rules).

## Hard rules

- Work on a new branch in a separate worktree, from a clean, committed base.
  Write the base commit in `.untangle/baseline.md`. Do not push. Do not
  merge. The user reviews the decision log and the diff first.
- Record a baseline before the first edit (step 2). Behavior must be the same
  at the end, except for the bugs that the log names as fixed.
- A refactor commit does not change behavior. It does not change an assertion
  about behavior that a caller can see. In the same commit, you can change a
  test's import path or a renamed name; you cannot change what it asserts. If
  a test fails after a refactor commit, revert the commit. Do not edit the
  test to match.
- A bug fix is its own commit: first a test that fails, then the fix, then a
  line in the log. A rewrite of a test that checks internals is its own
  commit too, before the fix that needs it.
- Interfaces used outside the repository (published exports, CLI flags and
  output, file formats, settings, tool schemas, network APIs) do not change.
  Log a change that they need under "Not fixed" as a proposal for the user.
- An interface used only inside the repository can change. Update every
  caller in the same commit, and run the full typecheck and the full test
  suite, not only the tests of the area. `untangle.mjs graph` lists the files
  outside the area that import it.
- Stop rule for check rounds: stop when a round has no confirmed critical or
  high finding that is not fixed. After 3 rounds, stop and report. A critical
  or high finding needs a repro (a failing test, a probe output or a number),
  or it is medium at most.
- Budget: if the user or the harness gives a time or cost limit, stop at 80
  percent of it. Then finish the commit in progress, run the full checks and
  report. List the open items under "Not fixed".

## Instruments

`scripts/untangle.mjs` needs only Node 22 or later and git. Run it from the
worktree root with the full path of the script, so that the area path and
`--save` paths are relative to the worktree. Each command takes a path
(default `.`).

- `graph <path>`: import cycles; **imports of more volatile code** (an
  importer that changed much less often than what it imports, from git
  history, in changes per month; a module with no commit older than 60 days
  is not judged); **hidden links** (files that change in the same commits
  with no import either way); **importers outside the area**; fan-in, fan-out
  and instability. Cycles made only of `import type` edges are labeled.
  `--by dir` groups by folder. `--save` and `--compare` measure before and
  after. Only more modules in cycles counts as worse. After the first commit,
  add `--history-until <base>` to each run, so that your own commits do not
  add hidden links. On a repository younger than `--min-age` (60 days), the
  volatile-import list is empty and says nothing.
- `special-cases <path>`: counts swallowed errors and fallback values,
  retries and fixed waits, disabled tests, turned-off type or lint checks and
  TODO notes. It reads code without comments and strings, and notes only in
  comments. The total is the progress number. Branches on one literal value are shown but not in the
  total, because a branch over a closed union is often good design.
  `--list <category>` prints each hit with file:line.
- `skeleton <path>`: the source of a folder or a file with function bodies
  left out, with line numbers, so the whole area fits in one context. It is
  approximate. `--depth 1` keeps one more level.

Cycles are the most reliable number. The numbers find candidates. They do
not decide. A hidden link can be a test
and its subject, or a feature and its changelog. Check each one in the code.
The special-case count reads names and shapes, not meaning: a rename of a
retry name can move it, and JSX text with `/*` or one backtick can hide a few
lines. Before you report a change in the count, read the hits that left and
the hits that came (`--compare` lists the new ones).

## Helpers

Steps 3 and 6 use helper agents: scouts that read batches of code, and
reviewers that did not do the work. Use the subagent tool when you have it.
Without one, ask the user how to run them. A fallback must give read-only
tools (no shell for scouts), a cost cap or a hard time limit, a fixed model,
and a final text report with its cost. Save scout reports in
`.untangle/scouts/` and review reports in `.untangle/reviews/round-<N>.md`.

## Steps

### 1. Ask

Ask the user which of these optional passes to do, with these exact
descriptions. Use a form when the harness has one. Then do only those.

| Pass | What it does |
| --- | --- |
| **Comments** | Remove comments that only restate the code. |
| **Tests** | Remove tests that would not catch a real bug, and fix the ones that fail without one. |

Also confirm the area and the test command, if they are not clear.

### 2. Set up and record the baseline

1. Make the worktree and branch from a clean, committed base. Put working
   files in `.untangle/` at its root and add `.untangle/` to the exclude file
   (`git rev-parse --git-path info/exclude` gives its path; in a linked
   worktree it is shared). Write the base commit in `.untangle/baseline.md`.
2. Run the test suite, the typecheck and the linter. Save the exact commands
   and the pass, fail and skip counts in `.untangle/baseline.md`. A test that
   fails before you start is not your regression: list it. Look for a time
   limit in the test runner: a run near the limit can fail for time only.
3. Save the numbers: `graph <area> --save .untangle/graph-before.json` and
   `special-cases <area> --save .untangle/special-before.json`.

### 3. List every problem

Do not change code in this step. Use the skeleton, the graph, the git
history and the special-case list. For more than about 6,000 lines, start
read-only scouts in parallel, one for each batch of files, with the brief in
[references/scout-brief.md](references/scout-brief.md). Give each scout the
graph and special-case rows for its files (use `--json` or a large `--limit`,
not the top 20).

A scout claim is a hypothesis. Triage before you check: scouts can give 30
findings for each 1,000 lines, more than a run can check.

1. Check first the claims with the most leverage: one fix behind several
   claims, and a case that one of two similar handlers covers and the other
   does not (that shape found real bugs in the pilot).
2. Open the code for each claim that you log as a problem.
3. Log the claims that you did not check under "Not checked", with their
   scout and file:line.

Write every problem in `.untangle/decisions.md`, in the format of
[references/decision-log.md](references/decision-log.md). There are only
three ways to get the question wrong.

**Hidden links:** pieces that must change together, where the code does not
show it.

- Copies of logic or values: change one and the others must change too, but
  nothing says so.
- A module that reads a global or a file that another module sets.
- A feature split across folders by layer, or related code in different
  folders, so that one change needs all of them (colocation).
- A call order or a convention that callers must know (explicit over
  implicit).

**Needless links:** pieces tied together that change for different reasons.

- Callers that depend on internals (encapsulation).
- Stable code that imports more volatile code (dependency direction).
- A general function with a parameter that only one workflow understands
  (caller vocabulary).
- A shallow module: its interface changes each time its internals do, so its
  callers change too (deep modules).

**Surplus:** pieces with no reason of their own to change.

- Wrappers that only pass calls through.
- Extension points and settings for things that never vary (speculative
  generality).
- Dead code.

Also write down every **special case**: code that exists for one situation
instead of following from how the system works. Examples: an `if` for one
value, a parameter for one caller, a swallowed exception, a retry or a sleep,
a disabled test. Each one is a requirement that the design did not cover. Use
them to find what the system needs to be.

### 4. Redesign from first principles

Find the fixes as if the system had known today's requirements from the
start. Look for one fix behind several problems: it often looks nothing like
them. Do not fix special cases one at a time.

Test each fix against three rules, also a fix that looks better in the code:

- Pieces that change together end up together.
- Pieces that do not change together are not tied.
- Everything depends on what changes less.

Write each fix above the problems that it solves. Give each fix its risk
(which behavior could change) and the test that guards it. Order the fixes so
that the safest ones with the most problems under them come first.

### 5. Fix everything on the list

Do the fixes in the log order. For each fix:

1. Look at the tests of the behavior that the fix moves. Where it has no
   test, write characterization tests first (tests that pin what the code
   does now). Commit them on their own, and see them pass.
2. Make the fix in one commit, or in a short series of commits that each
   pass the tests.
3. Run the tests of the area after each commit, and the full suite after a
   change to an interface. Fill in the commit and the result in the log.
4. Rerun `graph <area>`. A new cycle is a regression: fix it before the next
   fix.

Remove the special cases that the redesign makes unnecessary, and keep the
ones the system still needs (with the reason in the log). Do not hunt for
bugs separately. When a fix shows a bug, fix it in its own commit as the
Hard rules say, or log it under "Not fixed".

If the user chose **Comments**:

- A comment that restates the implementation (`// sort first so the binary
  search works`) changes only when the code does. Remove it, also when it is
  phrased as a reason.
- A comment about something outside the code (`// the proxy drops
  websockets, so we poll`) changes when that outside thing does, and the code
  cannot show it. Keep it.
- A comment that explains a workaround (`// wait 100ms because the cache is
  not ready yet`) goes when the redesign removes the problem behind it.

If the user chose **Tests**, do this pass last, because the tests are the
safety net for the other fixes. A test must fail on a regression, and only
then.

- A scout claim about a test is a hypothesis until a probe confirms it. In
  the pilot, most "cannot fail" claims were wrong.
- Run each probe with a time limit (`timeout 120`) and one test
  (`--test-name-pattern`): a mutation can make a test hang.
- To find tests that use private members, rename the private member and
  see which tests break.
- A test that repeats the implementation checks the code against itself.
- A test tied to internals breaks when the code changes but the behavior does
  not. Rewrite it against the behavior, in its own commit.
- A test that cannot fail checks nothing.
- Each removed test needs proof in the log. Give one of these:
  - a mutation probe: break the code that the test covers (flip a condition,
    return a constant), and show that the rest of the suite still fails on
    the mutation, so the removed test added nothing;
  - for a test that cannot fail: the same mutation, with the test itself
    still passing;
  - the name of a kept test that checks the same behavior;
  - for a test of dead code that you remove: no caller at the base
    (`git grep` output), and the live rule has its own tests.
- A test with no proof stays. List every removed test with its reason and its
  proof in the log, so the user can review each one.

### 6. Check, and repeat until done

Start fresh reviewer subagents on a strong model with the brief in
[references/review-brief.md](references/review-brief.md). They did not do the
work. They search the changed area for hidden links, needless links, surplus
and special cases that remain, and for behavior changes. Each round after the
first reviews the new commits. Check each finding in the code before you act
on it: a reviewer can be wrong too. Fix the confirmed findings, then start
the next round. Use the stop rule in Hard rules. A new `fix:` commit after
the last round needs one more round, also when the last round was clean.

You are done when all of these are true:

- Each problem in the log is fixed, or it is under "Kept special cases" or
  "Not fixed" with a reason.
- Each special case that is left is in the log, with the reason that the
  system needs it. The count is the best measure of how close you are.
- `graph --compare` shows no more modules in cycles than the baseline.
- Each import of more volatile code and each hidden link in
  `graph-before.json` is checked and logged: fixed, or the reason that it
  must stay. A new hidden link in the final run is logged too; "made by the
  refactor commits" is a valid reason.
- The last review round has no confirmed critical or high finding that is
  not fixed.
- The full tests, the typecheck and the linter give the baseline results or
  better.

### 7. Report

- Run `graph <area> --history-until <base> --compare .untangle/graph-before.json`
  and `special-cases <area> --compare .untangle/special-before.json`. Give
  the numbers before and after. Explain each number that got worse. A
  special-case count that did not go down is not a failure when each one
  left is a real boundary: the count does not see removed copies or second
  owners of a rule. Say what the fixes removed instead.
- The test, typecheck and lint results against the baseline.
- The fixes, each with the problems that it solved and its commit.
- Public interface changes, bugs fixed, removed comments and removed tests.
- What you did not fix, and why.
- The branch, the worktree path and how to review the diff
  (`git diff <base>...<branch>`). Do not merge or push.

## Tips

- Enter where the leverage is highest: the files with the most hidden links,
  the most special cases or the highest churn.
- Keep the decision log current. It keeps the work on track after a context
  compaction.
- Use git as evidence of how often pieces change and what changes together.
  The files that change with one file:
  `git show --format= --name-only $(git log --format=%H -- <file>) | sort | uniq -c | sort -rn`.
