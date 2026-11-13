---
name: code-slop-rules
description: Turn the sloppy code patterns that a repository has (swallowed errors, empty catch blocks, `.catch(() => {})`, `as any`, `as never`, `as unknown as`, non-null `!`, ts-ignore, eslint-disable, type-ignore, noqa, bare except, fixed sleeps, empty default branches, "for now" and workaround comments) into tested ast-grep rules and a ratchet that fails when a count goes up. Use when the user asks for slop rules, ast-grep rules, a lint ratchet, deterministic checks instead of review rounds, or to stop agents adding sloppy code, or runs /skill:code-slop-rules.
---

# Code slop rules

A review round finds sloppy code again and again, and each round costs tokens and time.
A rule finds the same code in a second and gives the same answer every time. This skill
makes rules for the patterns that a repository really has, and adds a **ratchet**: each rule
has a recorded site count, and the check fails when a count goes up. Old sites do not block
work. New sites do.

Measure first. Write a rule only for a pattern with real sites. Do not write a rule that a
linter of the repository already enforces.

## Related skills

This skill finds syntax patterns in code. Other skills cover other kinds of defects:

- **ui-redline**: generated-looking UI in a rendered page (gradients, glows, emoji icons,
  spacing, contrast). Use it for screens. This skill does not check CSS or rendered pages.
- **formal-verification**: logic defects that depend on the order of events (races, retries,
  locks, at-most-once delivery). A syntax rule cannot find those. Use it for designs.
- **untangle-codebase**: its `special-cases` count is a progress number for one refactor.
  This skill turns patterns into rules that stay in the test suite after the work ends.

## The tool

All commands: `node <skill-dir>/scripts/slop.mjs <command>` (below: `slop`). Every command
takes `--help`. Run the commands from the repository root.

| Command | What it does |
| --- | --- |
| `slop setup [--check]` | Finds ast-grep: `$AST_GREP_BIN`, the repository's `node_modules`, `~/.cache/pi-code-slop-rules`, then `PATH`. Without one, it installs the pinned `@ast-grep/cli` into the cache. `--check` only reports. |
| `slop measure [paths...]` | Runs every catalog rule (`catalog/`), counts sites in source and in tests apart, scans each file of the last 300 fix commits before and after the fix, reads the linters' rule state, and prints a table with a verdict for each rule. `--json <file>` keeps the full data. `--samples <n>` sets the number of sample sites for each rule. |
| `slop adopt <rule-id...>` | Copies catalog rules into `lint/slop/rules` and their tests into `lint/slop/rule-tests`, and writes `sgconfig.yml` when it is missing. `--exclude-tests a,b` makes the named rules skip test files. `--tsx` adds a tsx copy of each TypeScript rule. |
| `slop ratchet` | Runs the rule tests, counts the sites of each rule, and compares the counts with `lint/slop/baseline.json`. Exit 1 when a count is higher, a rule has no recorded count, or a rule or `sgconfig.yml` was removed or changed since the baseline (the baseline keeps a hash of each). The output names each file that rose with its sites. Exit 2 when the scan did not finish (a signal, a missing summary, output that is not JSON). `--update` writes the counts; it refuses a higher count, a removed rule and a changed rule unless you also give `--allow-increase`. |

The catalog has TypeScript rules (they also parse `.js` and `.mjs`) and Python rules. Each
rule has a test file with valid and invalid cases. Each rule's `metadata` gives its family,
its precision, and the linter rules that overlap it.

## Procedure

### 1. Set up

Run `slop setup --check`. If it fails, run `slop setup`. For a Node repository, add the
pinned CLI as a development dependency, so that CI and every clone use the same version:
`npm install -D --save-exact @ast-grep/cli@0.51.1`. With `npm ci --ignore-scripts`, the
package's postinstall does not run. The tool finds the native binary without it. For a
repository without Node, use `uv tool install ast-grep-cli==0.51.1`.

### 2. Measure

Run `slop measure --json <file>` and read the whole output. Keep the JSON file outside the
repository. Each row gives:

- **Sites**, **Source**, **Tests**: the count now. A test file is a file under `tests/`,
  `test/`, `__tests__/` or `spec/`, or a `*.test.*` or `*.spec.*` file.
- **Fixes that removed sites**: fix commits whose changed files had fewer sites after the
  fix, with their Found-by trailers. This is evidence that the pattern takes part in real
  bugs. It is a correlation, not a proof: read the example commits.
- **Fixes that added sites**: fix commits that added sites. A high number shows a habit of
  quick repairs that a rule can stop.
- **Linter**: the configured linter rules that already enforce the pattern.
- **Verdict**: `adopt` (real sites, high precision, no linter), `sample` (low or medium
  precision: read sites first), `skip: linter`, or `skip: no sites`.

Then look for patterns that the catalog does not have:

- Read the fix commits with `git log -E -i --grep='^fix' --stat` and the review findings in
  the project notes. Look for a code shape that more than one fix removed.
- In the owner's repositories, commits carry a `Found-by:` trailer. Read the `review` and
  `use` fixes first: those are bugs that tests did not catch.
- For each repeated shape, write a rule in `lint/slop/rules` with a test file (see
  `references/rule-writing.md`), and count its sites with `ast-grep scan --filter <id>`.

### 3. Decide each rule

Do not trust the verdict alone. For each rule with sites, read at least 10 sites (use
`--samples 10`, or `ast-grep scan --filter <id> --json=stream`). Then decide:

- **Adopt** when most sites are the defect that the message names. A site that is right by
  design still counts. The ratchet only stops new sites, and a person who adds a new one on
  purpose gives the reason with `--allow-increase`.
- **Refine** when the false sites have a shape that you can exclude (for example, a sleep
  inside a poll loop). Add the shape to the rule's `not:`, add it to the `valid:` cases, and
  measure again.
- **Drop** when a syntax rule cannot tell the defect from correct code. Example: a fallback
  `?? ""` is dead only when the left side can never be missing, and only the types know
  that. A type-aware linter rule (`@typescript-eslint/no-unnecessary-condition`) is the
  right tool for it.
- **Skip** when a configured linter enforces it. Say so in the report. When the measure says
  "rule state unknown", read the linter config yourself before you decide.
- **Scope**: decide for each rule if test files count. Type escapes in test fakes (`as any`,
  `as never`) are often a habit of the whole suite, and a rule there blocks most new tests.
  Exclude tests for those rules with `--exclude-tests`, and report the test count as a
  follow-up. Swallowed errors and fixed sleeps are defects in tests too: keep tests in.

Keep the list of dropped rules with the reason for each. The report needs it.

### 4. Adopt and record the baseline

1. Run `slop adopt <id...> [--exclude-tests <id,...>]`.
2. Run `slop ratchet --update`. This writes `lint/slop/baseline.json` with a count for each
   rule and file, and a list of the worst files.
3. Add the ratchet to the repository's test command, before the slow suites. For npm: a
   script `"lint:slop": "node <path>/slop.mjs ratchet"` that `npm test` runs. If the skill
   folder is not in the repository, copy `scripts/` into the repository (for example
   `scripts/slop/`). CI must not depend on a skill install.
4. Do not fix old sites in the same change. The ratchet makes the counts go down over time.
   List the worst files in the report as a follow-up.

### 5. Prove that the check bites

Add one new violation of an adopted rule to a source file. Run the ratchet. It must exit 1
and name the file and line. Remove the violation and run the ratchet again: it must pass.
Put both outputs in the report. A check that you did not see fail is not proven.

### 6. Report

Give:

- The rule table: rule, sites (source and tests), scope, fix-commit evidence, and the reason
  you adopted it.
- The dropped candidates, each with its count and reason (no sites, a linter enforces it,
  low precision).
- The ratchet command and where the test command runs it.
- The failing output of the deliberate violation.
- The worst files, as a follow-up list.

## Ratchet rules

- Never use `--allow-increase` to make a check pass without a reason. Put the reason in
  the commit message.
- When a count goes down, run `slop ratchet --update` in the same commit to lock the gain.
- Every rule change (a wider or a narrower pattern, a new `files` or `ignores`, a change to
  `sgconfig.yml`) fails the ratchet until you run `--update --allow-increase`. Say in the
  commit message that the rules changed, not the code.
- A `// ast-grep-ignore` or `# ast-grep-ignore` comment hides the next line from every
  rule. The `ts-lint-disable` and `py-noqa` rules count these comments, so a hidden site is
  still a new site. Adopt one of them in each language that the repository has.
- The ratchet scans the files that git does not ignore. An untracked source file counts on
  your machine but not in CI. A new `.gitignore` entry can hide files: read such changes in
  review.
- A lower count is not locked until you run `--update`. Until then, new sites up to the old
  count pass.

## Limits

- ast-grep reads syntax, not types. It cannot see that a value can be null, or that a cast
  is safe. Use the type checker and a type-aware linter for those.
- One TypeScript rule set parses `.js` and `.mjs` too. The TypeScript grammar accepts plain
  JavaScript, but JSX in a `.js` file does not parse. Map such files to `tsx` in
  `languageGlobs`, and adopt the rules with `--tsx`: a rule has one language.
- A count is a count of syntax sites. A file that moves code to another file keeps the
  total, and the ratchet passes. The ratchet compares totals per rule; the per-file counts
  only explain a failure.
