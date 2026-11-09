# Write an ast-grep rule

Use this page when the catalog does not have a pattern that the repository repeats.

## Find the node

1. Put a small example in a file, for example `/tmp/x.ts`.
2. Print its syntax tree: `ast-grep run -l ts -p 'try { f() } catch {}' --debug-query=cst /tmp/x.ts`.
3. Find the node kind that holds the defect (`catch_clause`, `as_expression`,
   `non_null_expression`, `comment`, `except_clause`).

## Write the rule

A rule file has one rule. Use the fields of the catalog rules:

```yaml
id: ts-swallowed-catch          # unique in the repository; the baseline uses it
language: typescript            # one language for each rule; copy the rule for tsx
severity: warning               # warning or hint; do not use error (the scan exits 1)
message: One sentence that names the defect.
note: One or two sentences that tell the reader what to do.
metadata:
  family: swallowed-error       # the group in the measure table
  precision: high               # high, medium or low: how often a site is the defect
  overlap: { eslint: [no-empty] }   # linter rules that enforce the same thing
rule:
  kind: statement_block
  regex: '^\{\s*\}$'
  inside: { kind: catch_clause, field: body }
```

Rules that help:

- `pattern` matches code shapes with metavariables: `$P.catch($H)`, `await $F($MS)`.
- `kind` and `regex` match one node and its text. `regex` is a Rust regex: it has no
  look-around and no back-references.
- `inside`, `has` and `not` relate nodes. Add `stopBy: end` to search all ancestors or
  descendants, not only the parent or children.
- `constraints` limit a metavariable: `MS: { kind: number }`.
- `ignores` (a list of globs, relative to `sgconfig.yml`) skips files. `slop adopt
  --exclude-tests` adds the test globs.

YAML: put a value in double quotes when it has `: ` or starts with a backtick. In a regex in
single quotes, write a single quote as `''`.

## Test the rule

Put a test file in the rule-test folder, with the name `<id>-test.yml`:

```yaml
id: ts-swallowed-catch
valid:                     # code that must not match
  - 'try { f(); } catch (error) { log(error); }'
invalid:                   # code that must match
  - 'try { f(); } catch {}'
```

- Put each false site that you found while you sampled in `valid:`.
- Put each form of the defect in `invalid:` (with and without a parameter, with a comment).
- Run `ast-grep test --skip-snapshot-tests`. The ratchet runs the same tests first.

## Count and record

1. Count the sites: `ast-grep scan --filter <id> --json=stream | wc -l`.
2. Read at least 10 sites before you keep the rule.
3. Run `slop ratchet --update`: a new rule gets its first count.
