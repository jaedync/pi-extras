---
name: speed-up-ci
description: Make a repository's CI fast without letting it lie. Audit the last runs (waiting, setup and running at p50 and p95), fix the biggest bucket first, pack test shards by recorded time, run only the tests that a PR diff can reach (with full-run triggers and a canary that must go red), and keep the full suite before main. Use when the user asks to speed up CI, cut CI time, shard tests, run only affected tests or make PR checks faster, or runs /skill:speed-up-ci.
---

<!-- Based on Pontus Abrahamsson's CI prompt and thread (2026-11-15):
https://x.com/pontusab/status/2121982070193058191 -->

# Speed up CI

Make CI as fast as possible without letting it lie. The default target: a PR
gets its result in under 2 minutes at the median and under 3 minutes at p95.
The user can set a different target. Some targets need a bill or a matrix
change (for example more macOS runners). Then report the lowest time that
you can reach without them, and give each option with its cost.

`scripts/ci.mjs` (in this skill's folder; Node 22.18 or later, and `gh` for
the audit) does the measurement and the deterministic parts:

- `ci.mjs audit`: pull the last runs and split each job into waiting, setup
  and running, at p50 and p95.
- `ci.mjs timings` and `ci.mjs shards`: record seconds per test file, and pack
  files onto shards by those seconds.
- `ci.mjs select`: decide if a PR runs only the affected tests or the full
  suite.

Run `node <skill>/scripts/ci.mjs <command> --help` for the options.

## Rules that outrank speed

1. The full suite runs before anything reaches the main branch: in a merge
   queue, or on each push to main when there is no queue. Selection only
   makes PR feedback narrower.
2. Never get faster by hiding failures. Do not add retries, wider timeouts,
   skipped or quarantined tests, `continue-on-error`, or a lower coverage
   gate. A check that needs a retry has a bug. Find the bug.
3. Do not add an account, a secret, a paid service or a larger bill
   yourself. Put each one in a list for the user, with the expected monthly
   cost.
4. One small PR (or commit) for each change, with before and after numbers
   from real CI runs, not from local runs. Until the user approves the
   pushes, label each "after" number as measured locally or expected.
5. Get the user's approval before each push, PR, branch deletion or
   repository setting change. The canary in step 3 and the before and after
   runs need pushes, so ask for them together, in one list.

## Before you start

Copy `scripts/ci.mjs` and its `lib/` folder into the repository (for
example as `.ci/ci.mjs` and `.ci/lib/`). Then CI does not depend on this
skill, and the snippets can call `node .ci/ci.mjs`. When the repository
already contains this skill, call the scripts where they are.

## 1. Audit

```bash
node <skill>/scripts/ci.mjs audit --runs 150 --save .ci-audit/before.json
```

- The audit reads the repository of the current directory. Use `--repo`,
  `--workflow`, `--event pull_request` or `--branch` to narrow it.
- Waiting is the time from job creation to a runner start. It includes a
  wait on `needs:` jobs. Setup is the runner start, checkout, toolchain,
  caches and the dependency install. Running is the rest.
- Cancelled and skipped runs are left out, because `cancel-in-progress`
  makes many short ones. Jobs that fail-fast cancelled are left out too.
- Use `--success-only` for the before and after numbers: a failed run often
  ends early, so it makes the times look short.
- The critical path is the job that ended last in each run. The author waits
  for that job. Runner minutes are what the runs cost.
- If the step names hide setup (for example `make deps`), add
  `--setup-pattern 'make deps'`.
- Fix the biggest critical-path bucket first. It is rarely the tests, so do
  not start by deleting tests.
- Keep the saved file out of commits. It is the "before" number for the
  report.

## 2. Hit the budgets

These are the default budgets. Each item says what usually gets a job there.
`references/github-actions.md` has the workflow snippets, and
`references/tools.md` has the tool defaults for each stack.

- **Waiting, under 10 s.** Queue time counts as job time: a 5-second job that
  queues 10 minutes is a 10-minute job. Cancel a branch's run in progress when
  a new commit lands (`concurrency` with `cancel-in-progress` on PRs only).
  Faster or dedicated runners (Blacksmith, larger GitHub runners, a
  self-hosted runner) need an account or a bill: put them in the list.
- **Setup, under 30 s.** Get PR cache hits above 95% by saving caches from
  main, because a PR can read the caches of its base branch. Cache the
  installed dependency folder (`node_modules`, `.venv`), not only the
  package manager cache. Use a blobless clone (`filter: blob:none`), not a
  shallow one: selection needs the merge base.
- **Lint, under 5 s; typecheck, under 5 s; format check.** Measure the fast
  tools from `references/tools.md` against the current ones (step 5).
- **Tests, under 60 s for each shard.**
  - Do not load the app again for each test file when the runner can share it
    (for example Vitest `isolate: false`). Reset state after every file, and
    write the cleanup rules into the project's `AGENTS.md`.
  - Run the tests in random order to find tests that leak state.
  - Shard by measured duration (step 4). Give each shard its own database or
    service.
  - Use more cores before more shards, and set the test concurrency to the
    core count. If tests depend on timing, measure their failure rate at the
    new concurrency before you keep it.
  - Shards multiply with the OS and runtime matrix. GitHub limits the jobs
    that run at the same time (on the Free plan: 20 jobs, of which 5 are
    macOS). Jobs above the limit wait, and the wait counts. Give each OS its
    own shard count.
- **Shape.** Run lint, typecheck, build and tests as parallel jobs, not as
  steps of one job. Then move slow side checks (migrations, other apps'
  tests, the install smoke test) out of the slowest job into their own jobs.
  A tool cache inside the dependency folder (for example
  `node_modules/.cache`) must be restored after the install step, because
  `npm ci` empties that folder.
- **Local, under 9 s.** Add a pre-push hook that runs format, lint and
  typecheck on the changed files. Use a hook, not a line in `AGENTS.md`,
  because agents skip steps. Use the repository's own fastest commands. If
  one of them alone is over the budget (a full typecheck), leave it to CI
  and say so.
- **Keep it fast.** Set `timeout-minutes` on every job near its budget, so a
  slow job fails instead of slowly getting slower. Run the audit again after
  each change.

## 3. Run only the affected tests on PRs

1. Pick the selector for the stack: `vitest --changed <base>`,
   `jest --changedSince <base>`, `nx affected`, `turbo run test --affected`,
   or `pytest --testmon`. Each one follows the import graph from the diff.
2. Run `ci.mjs select` first. It prints `full` when the diff touches an input
   that no import reaches: lockfiles and manifests, tool config, `.github/`,
   snapshots, fixtures, mocks, patches, migrations, containers, environment
   files, and `.ci/` itself. It also prints `full` for a deleted file (no
   selector finds the tests that imported it) and when it cannot compute the
   diff. Add the repository's own inputs to `.ci/full-run.txt`, one glob per
   line, as in `.gitignore`.
3. Look for inputs that reach tests with no import edge: a module loaded from
   a string at run time, a client that the build generates, a value that a
   test reads from the environment through a helper, a file that a test
   reads from disk. Add each one to `.ci/full-run.txt`.
4. Prove that selection cannot pass a bad change. On a scratch branch, break
   a test through a path that the selector cannot see (a fixture, a config
   value, a generated file). Push it, and confirm that the PR goes red. If
   it goes green, add that path as a trigger and try again. Delete the branch
   after.
5. If one heavy test mounts the whole app, every change reaches it. Split it,
   or give it its own job, so that it does not pull the full suite into each
   PR.

The merge queue and the main branch always run the full suite (rule 1).

If the test runner has no import-graph selector (for example `node:test` or
plain scripts), do not write one. Skip this step, say so in the report, and
get the gain from shards and caches.

## 4. Shard by recorded time

Equal file counts give unequal shards. Record the time of each test file on
main, and pack the files by that time:

```bash
# On main: write a report, then the timings file (save it as a cache or an artifact).
npx vitest run --reporter=default --reporter=junit --outputFile.junit=report.xml
node .ci/ci.mjs timings report.xml --out .ci/timings.json

# Once for each run: the runner's own file list, then the plan for all shards.
npx vitest list --filesOnly > test-files.txt
node .ci/ci.mjs shards --timings .ci/timings.json --files test-files.txt --count 8 --matrix
```

- Get the file list from the test runner, not from a `git ls-files`
  pattern. A pattern that differs from the runner's include list leaves
  files out of every shard. A runner with no list mode (`node:test`) needs
  one shared list module that the full run and the shards both use, and a
  test that compares that list with the files on disk.
- Compute the plan once for each run, and give each shard its list (the
  `plan` job in `references/github-actions.md`). Shards that restore the
  timings by themselves can get different files, and then a test file runs
  on no shard. The other safe method is a committed timings file.
- Give each shard its files as exact paths. Vitest treats a file argument
  as a substring, so `a.test.ts` also runs `a.test.tsx`.
- `timings` reads JUnit XML (Vitest; Jest with `jest-junit` and
  `addFileAttribute: true`; pytest with `-o junit_family=xunit1`) and Vitest
  or Jest JSON reports. Node's own JUnit reporter cannot time a file: use
  `scripts/node-test-timings-reporter.mjs` as an extra `--test-reporter`. Use `--prefix <path>/` only when the file list has
  repository paths and the runner names files relative to a package.
- A new file gets the median time. Missing timings give an even split by
  count, with a warning when no listed file matches the timings.
- `--count 8` prints the seconds of each shard. Use it to pick the shard
  count: add shards until the largest shard is under the budget.

## 5. Change tools only with a side-by-side run

The tools in `references/tools.md` are defaults. A team needs a measured
reason to keep an old tool. Take a newer tool when it is faster on this
repository.

Before each switch, run the old and the new tool side by side on the same
commit. List every finding that the new tool misses. If it misses a rule
that matters, keep the old tool for that rule only, or keep the old tool.

## 6. Report

- One line for each change: what changed, the PR or commit, and the before
  and after p50 and p95 from real runs.
- The total CI time and the runner minutes, before and after (from the
  audit).
- **Needs the user**: each account, secret, paid service or larger bill,
  with the expected monthly cost.
- The canary result from step 3.
- What is not verified, and why.

## Traps

- A faster PR run with a full run that nobody runs before merge.
- A retry, a longer timeout or a skipped test that makes CI green, not
  correct.
- An audit of the runner time only: waiting can be the largest bucket.
- A shallow clone (`fetch-depth: 1`) that breaks the merge base for
  selection.
- A cache key on the lockfile alone, saved only from PRs, so main never
  warms it.
- A new linter or type checker that reports fewer problems, taken as
  "faster".
- Numbers from a local machine in place of CI runs.
