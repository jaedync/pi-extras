# GitHub Actions snippets

Adapt each snippet to the repository. Keep the action versions that the
repository already pins. `.ci/ci.mjs` is a copy of this skill's
`scripts/ci.mjs` and its `lib/` folder in the repository.

Put GitHub context values into `env:` and read them as shell variables. Do
not write `${{ ... }}` inside a `run:` script (GitHub's script injection
guidance).

## Cancel a superseded PR run

```yaml
concurrency:
  # PRs share a group per PR, so a new commit cancels the old run. Other events get a group per run: a shared group
  # on main would cancel the pending runs between two pushes.
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

## Blobless checkout

A blobless clone has all commits, so the merge base for selection is there.
It downloads file contents only for the checked-out commit.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    filter: blob:none
```

## Cache the installed dependencies

A PR can read the caches of its base branch, but not the caches of other
PRs. The workflow must run on push to main, so that main saves the cache
that every PR reads.

```yaml
- uses: actions/cache@v4
  id: deps
  with:
    path: node_modules
    key: deps-${{ runner.os }}-${{ runner.arch }}-node${{ matrix.node }}-${{ hashFiles('package-lock.json', '.npmrc', 'patches/**') }}
- if: steps.deps.outputs.cache-hit != 'true'
  run: npm ci
```

Put every input that changes the installed folder in the key: the OS, the
architecture, the runtime version, the lockfile, the package manager config
and any patches.

## Merge queue: the full suite before main

```yaml
on:
  pull_request:
  merge_group:
  push:
    branches: [main]
```

Turn on the merge queue in the branch protection rules, and make the gate
job (`tests-ok`, below) the required check. That is a repository setting:
ask the user first.

## Shards with selection

The shard plan is the same on every shard only when every shard reads the
same timings file. Separate shard jobs that restore the newest cache can get
different files: a queued shard or a "Re-run failed jobs" can then skip a
test file. So one `plan` job computes the plan once, and the shards get their
file lists from its output. A re-run of failed jobs keeps the outputs of the
`plan` job.

The `plan` job adds one short job to the critical path. To avoid it, commit
`.ci/timings.json` (refresh it with a scheduled PR), and let each shard run
`ci.mjs shards --shard i/n` from the committed file.

Vitest treats each file argument as a substring filter: `a.test.ts` also
runs `a.test.tsx`. Give the shard's files to Vitest as exact `include`
entries:

```ts
// vitest.config.ts
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const shardFiles = process.env.TEST_SHARD_FILES;
export default defineConfig({
  test: {
    // Exact paths from ci.mjs shards. Paths with glob characters ([, ], {, }, *) need escaping.
    ...(shardFiles ? { include: readFileSync(shardFiles, "utf8").split("\n").filter(Boolean) } : {}),
  },
});
```

```yaml
plan:
  runs-on: ubuntu-latest
  timeout-minutes: 2
  outputs:
    mode: ${{ steps.select.outputs.mode }}
    matrix: ${{ steps.plan.outputs.matrix }}
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0, filter: blob:none }
    # ... toolchain and dependency cache ...
    - uses: actions/cache/restore@v4
      with:
        path: .ci/timings.json
        key: test-timings-${{ github.sha }}
        restore-keys: test-timings-
    - id: select
      env:
        EVENT: ${{ github.event_name }}
        BASE_REF: ${{ github.base_ref }}
      run: |
        if [ "$EVENT" = pull_request ]; then
          node .ci/ci.mjs select --base "origin/$BASE_REF" --github-output
        else
          echo mode=full >> "$GITHUB_OUTPUT"
        fi
    - id: plan
      run: |
        # The runner's own list, so the shards cover exactly the files that a full run covers.
        npx vitest list --filesOnly > test-files.txt
        echo "matrix=$(node .ci/ci.mjs shards --timings .ci/timings.json --files test-files.txt --count 4 --matrix)" >> "$GITHUB_OUTPUT"

test:
  needs: plan
  name: test ${{ matrix.shard }}/${{ matrix.of }}
  runs-on: ubuntu-latest
  timeout-minutes: 3
  strategy:
    fail-fast: false
    matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0, filter: blob:none }
    # ... toolchain and dependency cache ...
    - name: Test shard ${{ matrix.shard }} of ${{ matrix.of }}
      env:
        MODE: ${{ needs.plan.outputs.mode }}
        BASE_REF: ${{ github.base_ref }}
        FILES: ${{ toJSON(matrix.files) }}
        TEST_SHARD_FILES: shard.txt
      run: |
        node -e 'for (const f of JSON.parse(process.env.FILES)) console.log(f)' > shard.txt
        # Vitest reads git paths; unquoted paths keep non-ASCII names visible to --changed.
        git config --global core.quotePath false
        if [ "$MODE" = affected ]; then
          npx vitest run --changed "origin/$BASE_REF" --passWithNoTests
        else
          npx vitest run --reporter=default --reporter=junit --outputFile.junit=report.xml
        fi
    - if: github.ref == 'refs/heads/main'
      uses: actions/upload-artifact@v4
      with:
        name: test-report-${{ matrix.shard }}
        path: report.xml
```

- GitHub skips the jobs that need a failed job, and a skipped job reports
  "Success" as a required check. So a red `plan` job would let a PR merge
  with no tests. Make only this gate job the required check:

  ```yaml
  tests-ok:
    needs: [plan, test]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - env:
          PLAN: ${{ needs.plan.result }}
          TEST: ${{ needs.test.result }}
        run: test "$PLAN" = success && test "$TEST" = success
  ```

  The shard count can change, so the names of the shard checks are not
  stable. Do not make them required checks.
- The narrow branch tests for `affected`. Any other value, also an empty
  one, runs the full shard.
- `--passWithNoTests` is only in the `affected` branch. A full run must never
  pass with no tests.
- `--matrix` leaves out empty shards. An empty file list would otherwise make
  Vitest run every file.
- With `test.projects`, the root `include` does not reach each project.
  Read `TEST_SHARD_FILES` in each project's `include`, or run one matrix for
  each Vitest root.
- Job outputs have a size limit (1 MB for each job). For a very large file
  list, upload the plan as an artifact and download it in each shard.

## Record the timings on main

```yaml
timings:
  if: github.ref == 'refs/heads/main'
  needs: test
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with:
        pattern: test-report-*
    - run: node .ci/ci.mjs timings test-report-*/report.xml --out .ci/timings.json
    - uses: actions/cache/save@v4
      with:
        path: .ci/timings.json
        key: test-timings-${{ github.sha }}
```

The restore step with `restore-keys: test-timings-` gets the newest saved
timings. Vitest names files relative to its root, and so does
`vitest list`. These names match, so do not add `--prefix` for them. Use
`--prefix apps/web/` only when the file list has repository paths (for
example from `git ls-files`) and the test runner names files relative to a
package.

## Fail a job that goes over its budget

Set `timeout-minutes` on every job, near its budget. GitHub's smallest unit
is one minute. For a budget in seconds, wrap the step:

```yaml
- run: timeout 60 npx vitest run
```

## Pre-push hook

Save this as `.githooks/pre-push`. Install it once with
`chmod +x .githooks/pre-push` and `git config core.hooksPath .githooks`.

```sh
#!/bin/sh
set -e
base=$(git merge-base HEAD origin/main)
# Committed changes only: the push sends commits, not the work tree.
files=$(git diff --name-only --diff-filter=ACMR "$base" HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs')
[ -z "$files" ] && exit 0
echo "$files" | xargs npx oxfmt --check
echo "$files" | xargs npx oxlint
bun check
```

Measure the hook. It must stay under its budget (9 s by default), or agents
and people turn it off.
