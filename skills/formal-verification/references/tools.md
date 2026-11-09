# Choosing the tool

Let the question choose the tool. Prefer a tool that the project's developers
can install and run with one command.

| Question | Tool | Why |
|---|---|---|
| Can events happen in a bad order? (async code, retries, reload, protocols) | **Quint + TLC** (default) | Quint reads like TypeScript. TLC explores every reachable state and gives the shortest counterexample. `quint run --mbt` writes ITF traces for a conformance test. Installs with npm. |
| The same, but values come from large ranges (counters to 2^32, timestamps) | Quint + Apalache (`quint verify`, the default backend) | Symbolic: Z3 solves for values, so the range does not blow up the state count. Bounded by `--max-steps`. |
| The property must hold at every size and every depth | Apalache `--inductive-invariant` | Proves that the invariant holds in the first state and that every step keeps it. If it passes, it covers all states, with no bound. You often must strengthen the invariant until it is inductive. Try it after TLC passes. |
| A function's output for every input (a parser, a formatter, arithmetic) in TypeScript | fast-check property tests on the real function | No mature verifier runs on TypeScript. Test the real code with generated inputs, not a hand model of the function. |
| Rust code | Kani (bounded, on the code), Stateright (the model is runnable Rust), Verus (proofs on the code) | They run on the implementation, so no model can drift from it. |
| C code | CBMC | Bounded model checking on the code. Confirm that the loop bounds are large enough. |
| A theorem about a model with no bound | TLAPS, Lean | Expensive. Use when a check is not enough and the property is worth it. |

## Raw TLA+

When Quint cannot express the model, or its TLA+ output fails in TLC, write
TLA+ directly. The pinned Java from `fv.mjs setup` runs TLC:

```sh
curl -sSLo ~/.cache/pi-formal-verification/tla2tools-1.8.0.jar \
  https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
# sha256 e1f11b75c4b5bc4478ba0ac5cb6ae28e40a01b0016bc33e0aa97da22dfdbcd7f
java -XX:+UseParallelGC -cp ~/.cache/pi-formal-verification/tla2tools-1.8.0.jar tlc2.TLC -workers 1 Spec.tla
```

`fv.mjs` checks Quint records only. A raw TLA+ model needs its own run
command in its README.

## Later steps

These are not in `fv.mjs` yet:

- Liveness (`eventually`, with `weakFair`): TLC can check it through
  `quint verify --temporal`. It needs fairness for every action that the
  property depends on, and it is slower.
- Inductive invariants with Apalache, as the cheap proof step.
- Trace validation from the code side: log the real code's events, and let
  TLC check that each logged step is a step of the model. This catches code
  behaviors that the model does not have, which a replay of model traces
  cannot catch.
