# The verification record

A record is a folder, usually `formal/<area>/`, with:

- `<name>.qnt`: the model.
- `fv.json`: the checks, what each expects, the covered code and the sync commit.
- `traces.itf.jsonl.gz`: traces for the conformance test (`fv.mjs traces`).
- `README.md`: the promise, the properties, the bounds, the results and the findings.
- Optional live repro scripts for findings.

## fv.json

```json
{
  "spec": "delivery.qnt",
  "quint": "0.33.1",
  "invariants": ["oneCompletion", "boundedSends"],
  "syncCommit": "b96bac5",
  "covers": [
    { "path": "lib/shell-jobs-delivery.ts", "what": "attachDelivery, flush, sendCompletion" }
  ],
  "checks": [
    { "name": "faithful", "why": "Finding F1.", "expect": { "violates": "oneCompletion" } },
    {
      "name": "assume-fix", "why": "Assume the platform fix.",
      "replace": [{ "from": "pure val FLAG = true", "to": "pure val FLAG = false" }],
      "expect": "pass"
    },
    {
      "name": "mutant-send-ignores-binding", "base": "assume-fix",
      "mirrors": "lib/shell-jobs-delivery.ts:71 without `runtime.delivery !== binding`",
      "replace": [{ "from": "if (binding != b or not(outbox.contains(j)))", "to": "if (not(outbox.contains(j)))" }],
      "expect": { "violates": "oneCompletion" }
    }
  ],
  "traces": { "check": "faithful", "out": "traces.itf.jsonl.gz", "n": 200, "steps": 40, "seed": "0x5eed", "witnesses": ["witnessNoFailed"] }
}
```

- `invariants`: the properties that a `pass` check runs. A check that
  expects a violation runs only that invariant.
- `base`: the replacements of that check apply first. Chains are allowed.
- A check named `mutant-...` must say in `mirrors` which code change it
  copies. Name a mutant that must pass `survivor-...` and give the reason in
  `why`.
- `covers` paths are relative to the repository root. `drift` reads them.
- `syncCommit` is the commit at which you last confirmed that the model
  describes the covered code.

## Conformance test pattern

The test lives in the project's own test folder and runs with its tests.
Read `traces.itf.jsonl.gz` (one ITF document per line, gzip). For each trace:

1. Build the code side from the first state: the real module, its runtime
   objects, and fakes for the platform. A fake copies the platform rule that
   the model uses, with a comment that cites the platform source. The replay
   cannot tell whether that rule is true of the platform: check it with a
   live script against the real platform.
2. For each next state, read `mbt::actionTaken` and `mbt::nondetPicks` (a
   pick is `{ "tag": "Some", "value": ... }`), and run the code that the
   action stands for. Make each pending promise of the code controllable (a
   fake read that resolves when the trace says so).
3. Let microtasks settle (two `setImmediate` turns), then compare the code
   state with the model state, field by field, with the trace and step
   number in the message.

ITF values: `{"#bigint": "3"}` is a number, `{"#set": [...]}` a set,
`{"#map": [[k, v], ...]}` a map, `{"#tup": [...]}` a tuple. Records and lists
are plain JSON.

Code that the test cannot run (a function that is not exported, a handler
inside an extension) can be copied into the test in a few lines. Cite the
source line of each copy, and say in the README that the replay does not
check it.

Then prove that the test can fail: change the real code one guard at a time
(the same changes as the model mutants), run the test, and restore the file.
A change that the test does not catch is either a guard that no model
behavior needs (compare with the survivors) or a branch that no trace
reaches (add a witness).

The pilot record is `formal/shell-jobs-delivery/` in the pi-extras
repository, with its test `tests/shell-jobs-delivery-conformance.test.mts`.
