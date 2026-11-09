#!/usr/bin/env python3
"""Apply each guard change (one or more text pairs in one file) to the real code, one at a time, run the
conformance test of the mail model, and restore the file.

    python3 formal/subagents-mail/code-mutants.py "$PWD" [name ...]

It prints CAUGHT or missed for each change, then `git diff --stat` of lib/ and extensions/ (must be clean
when the run started clean)."""
import subprocess, sys

ROOT = sys.argv[1]
D = "lib/subagents/deliver.ts"
W = "lib/subagents/main-watch.ts"
M = [
 # The fixes of F1 to F4, each reverted.
 ("f1-ack-not-owed", D, "\t\t\tthis.starting.delete(id);\n\t\t\tthis.owing.set(id, from);\n", "\t\t\tthis.starting.delete(id);\n"),
 ("f1-fail-keeps-starting", D, "\t\t\tthis.owing.delete(message.details.id);\n\t\t\tthis.starting.delete(message.details.id);\n", "\t\t\tthis.owing.delete(message.details.id);\n"),
 ("f2-last-said-counts-custom", W, '.findLast((e) => (e as { type?: string }).type === "message")',
  '.findLast((e) => (e as { type?: string }).type === "message" || (e as { type?: string }).type === "custom_message")'),
 ("f3-mark-ignores-aborted", W, "stopMark = stoppedRun || !checked || event.aborted ?", "stopMark = stoppedRun || !checked ?"),
 ("f4-failed-needs-not-aborted", W, '(event.reason === "manual" && (compactionStopped || stoppedByCompaction(ctx)))',
  '(event.reason === "manual" && compactionStopped && !event.aborted)'),
 ("f4-old-fix-handler-order", W, '(event.reason === "manual" && (compactionStopped || stoppedByCompaction(ctx)))',
  '(event.reason === "manual" && compactionStopped)'),
 # The earlier guards (README, "How the model stays true to the code").
 ("no-unshift-after-failed-send", D, "\t\t\t\tthis.outbox.unshift({ message, wakes });\n", ""),
 ("wakes-alone-starts-turn", D, 'const options = route === "wake" && wakes ?', "const options = wakes ?"),
 ("queue-mail-not-owed", D, 'if (wakes) (route === "queue" ? this.owing : this.starting).set(', 'if (wakes && route !== "queue") this.starting.set('),
 ("route-ignores-settling", W, 'return running && !settling ? "queue" : "hold";', 'return running ? "queue" : "hold";'),
 ("landed-keeps-pending", D, "\t\tif (this.pendingItems.delete(id)) this.onChange();\n", "\t\tthis.onChange();\n"),
 ("drain-returns-nothing", D, "\t\tconst taken = this.takeOutbox();\n\t\tthis.dispose();\n\t\treturn taken;", "\t\tthis.takeOutbox();\n\t\tthis.dispose();\n\t\treturn [];"),
 ("compacted-no-remind", W, "\t\tif (stopped) mail()?.remind();\n", ""),
 ("stop-mark-ignores-checked", W, "stopMark = stoppedRun || !checked || event.aborted ?", "stopMark = stoppedRun || event.aborted ?"),
]
only = sys.argv[2:]
out = []
for name, path, a, b, *more in M:
    if only and name not in only:
        continue
    f = f"{ROOT}/{path}"
    src = open(f).read()
    pairs = [(a, b), *(more[0] if more else [])]
    bad = [x for x, _ in pairs if src.count(x) != 1]
    if bad:
        out.append((name, f"PATTERN x{src.count(bad[0])}", ""))
        continue
    changed = src
    for x, y in pairs:
        changed = changed.replace(x, y)
    open(f, "w").write(changed)
    try:
        r = subprocess.run(["node", "--import", "./tests/support/keep-alive.mjs", "--test", "tests/subagents-mail-conformance.test.mts"],
                           cwd=ROOT, capture_output=True, text=True, timeout=600)
        txt = r.stdout + r.stderr
        first = next((l.strip() for l in txt.splitlines() if "differ" in l or "AssertionError" in l), "")
        out.append((name, "CAUGHT" if r.returncode != 0 else "missed", first[:220]))
    finally:
        open(f, "w").write(src)
for o in out:
    print(" | ".join(o))
d = subprocess.run(["git", "diff", "--stat", "--", "lib", "extensions"], cwd=ROOT, capture_output=True, text=True).stdout
print("git diff lib extensions:", d.strip() or "clean")
