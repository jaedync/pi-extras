# Tool defaults

These are starting points, not rules. Each switch needs a side-by-side run
on the same commit (SKILL.md, step 5). Tools change fast: check the current
version and its documentation before a switch, and take a newer tool when it
is faster on this repository.

## JavaScript and TypeScript

| Job | Default | Notes |
| --- | --- | --- |
| Lint | `oxlint`, with every rule that the code can pass | Keep ESLint only for a rule that oxlint does not have and that found real bugs. |
| Typecheck | `bun check`, or `tsc` from TypeScript 7 | `bun check` reports the same errors as TypeScript 7 `tsc` on all cores. Compare both outputs with `diff` before the switch. |
| Format | `oxfmt` (or Biome) | Run in check mode in CI. |
| Install and scripts | `bun install` | Measure it against the current package manager with a warm and a cold cache. |
| Tests | Vitest | `isolate: false` when the files reset their state; `sequence.shuffle` to find leaks. |
| Tests (node:test) | `node --test` with a shared file list module | No import-graph selection. For timings, add `--test-reporter=<skill>/scripts/node-test-timings-reporter.mjs --test-reporter-destination=timings.xml`. |
| Selection | `vitest --changed <base>`, `jest --changedSince <base>`, `nx affected`, `turbo run test --affected` | Always together with `ci.mjs select`. |

## Python

| Job | Default | Notes |
| --- | --- | --- |
| Lint and format | `ruff check`, `ruff format --check` | |
| Typecheck | `ty` or `pyrefly` | Compare with mypy or pyright before the switch. |
| Install | `uv sync --frozen` | Cache `.venv`, keyed on `uv.lock` and the Python version. |
| Tests | pytest with `pytest-xdist -n auto` | `pytest-randomly` to find leaks. |
| Selection | `pytest --testmon` | Its database must come from main. |
| Shards | `ci.mjs shards` from a `--junit-xml` report (`-o junit_family=xunit1`), or `pytest-split` | |

## Other stacks

- Go: `go test ./...` keeps a test cache; cache `~/.cache/go-build` and
  `~/go/pkg/mod`. Use `gotestsum --junitfile` for timings.
- Rust: `cargo nextest` (with `--partition`), and `sccache` or
  `Swatinem/rust-cache` for the build.

## Runners

Faster or dedicated runners cut waiting and running time. Each needs an
account or a bill, so the user decides:

- Blacksmith, or another hosted runner service.
- Larger GitHub-hosted runners (more cores for each job).
- A self-hosted runner on a machine that the user owns.

Give each choice with the expected monthly cost, from the runner minutes
in the audit.
