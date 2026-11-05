---
name: untangle-codebase
description: Refactor a codebase or one area of it so that pieces that change together sit together and pieces that do not are not tied. Lists every hidden link, needless link, surplus piece and special case with file:line, redesigns from first principles, fixes in small tested commits on a branch, and measures the result (special-case count, import cycles, imports of volatile code, files that change together with no import). Optional passes remove comments that restate the code and tests that cannot catch a bug. Use when the user runs /skill:untangle-codebase or asks to untangle, de-tangle or restructure a codebase for agents.
disable-model-invocation: true
argument-hint: "[area or concern to focus on]"
---

<!-- Based on "untangle-codebase" by Maze (caldoai/skills, MIT, commit 442c299,
https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md).
This version adds the instruments, the baseline, the branch, the stop rule and
the measured report. -->

# Untangle a codebase

Refactor the code so that an agent reads less for each change, breaks less
without noticing, and finds root causes faster. Treat it as a goal: finish it.

Ask one question of every piece: **should these pieces change together?**
Fix every place where the code gives the wrong answer.

If the user gave an area (a folder, a feature, a concern), work only there.
Imports into and out of the area are in scope; code outside the area is not.

## Hard rules

- Work on a new branch in a separate worktree. Do not push. Do not merge.
  The user reviews the decision log and the diff first.
- Record a baseline before the first edit (step 2). Intended behavior must be
  the same at the end, except for bugs that the refactor fixed. Name each one.
- Make one fix in each commit. Run the tests after each commit. If they fail
  and the fix does not explain it, revert the commit, do not patch around it.
- Do not change a public interface (exports used outside the area, CLI flags,
  file formats, settings, tool schemas) without a line for it in the log.
- Stop rule for check rounds: stop when a round finds no new critical or high
  issue. After 3 rounds, ask the user. A critical or high finding needs a
  repro (a failing test, a probe output or a number), or it is medium at most.

## Instruments

`scripts/untangle.mjs` needs only Node 22 or later and git. Run it from the
skill folder, or give its full path. Each command takes a path (default `.`).

- `graph <path>`: import cycles; **imports of more volatile code** (an
  importer that changed much less often than what it imports, from git
  history); **hidden links** (files that change in the same commits with no
  import either way); fan-in, fan-out and instability. `--by dir` groups by
  folder. `--save` and `--compare` measure before and after.
- `special-cases <path>`: counts swallowed errors, retries and fixed waits,
  disabled tests, turned-off type or lint checks and TODO notes. The total is
  the progress number. Branches on one literal value are shown but not in the
  total, because a branch over a closed union is often good design.
  `--list <category>` prints each hit with file:line.
- `skeleton <path>`: the source with function bodies left out, with line
  numbers, so the whole area fits in one context. It is approximate.

The numbers find candidates. They do not decide. A hidden link can be a test
and its subject, or a feature and its changelog. Check each one in the code.

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

1. Make the worktree and branch. Put working files in `.untangle/` at its
   root and add `.untangle/` to `.git/info/exclude`.
2. Run the test suite, the typecheck and the linter. Save the exact commands
   and the pass, fail and skip counts in `.untangle/baseline.md`. A test that
   fails before you start is not your regression: list it.
3. Save the numbers: `graph <area> --save .untangle/graph-before.json` and
   `special-cases <area> --save .untangle/special-before.json`.
4. Look at the tests of the area. Where the behavior that you will move has
   no test, write characterization tests first (tests that pin what the code
   does now), and commit them before any refactor.

### 3. List every problem

Do not change code in this step. Use the skeleton, the graph, the git
history and the special-case list. For more than about 6,000 lines, start
read-only scouts in parallel, one for each batch of files, with the brief in
[references/scout-brief.md](references/scout-brief.md). Check each scout
claim in the code before you log it.

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

Do the fixes in the log order, one commit each. Run the tests after each one.
Remove the special cases that the redesign makes unnecessary, and keep the
ones the system still needs (with the reason in the log). Do not hunt for
bugs separately. A structural fix can fix some bugs: log each one.

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

- A test that repeats the implementation checks the code against itself.
  Remove it.
- A test tied to internals breaks when the code changes but the behavior does
  not. Rewrite it against the behavior.
- A test that cannot fail checks nothing. Before you remove it, prove it:
  break the code that it covers (a mutation: flip a condition, return a
  constant) and show that the test still passes. Put the probe in the log.
- List every removed test with its reason in the log, so the user can review
  each one.

### 6. Check, and repeat until done

Start fresh reviewer subagents on a strong model with the brief in
[references/review-brief.md](references/review-brief.md). They did not do the
work. They search the changed area for hidden links, needless links, surplus
and special cases that remain, and for behavior changes. Fix the confirmed
findings, then start the next round. Use the stop rule in Hard rules.

You are done when:

- As few special cases are left as possible. The count is the best measure
  of how close you are.
- A typical change lands in one place.
- Every import is reasonable, and nothing imports code that is more volatile
  than itself, or the log says why it must.
- A review round finds no new critical or high issue.
- The tests, the typecheck and the linter give the baseline results or
  better. Run them in full at the end.

### 7. Report

- Run `graph <area> --compare .untangle/graph-before.json` and
  `special-cases <area> --compare .untangle/special-before.json`. Give the
  numbers before and after. Explain each number that got worse.
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
- Rerun `graph` after each group of fixes. A new cycle is a regression.
