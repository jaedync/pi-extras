#!/usr/bin/env python3
"""Apply each guard change (one or more text pairs in one file) to the real code, one at a time, run the conformance test, and restore the file.

    python3 formal/subagents-lifecycle/code-mutants.py "$PWD" [name ...]

It prints CAUGHT or missed for each change, then `git diff --stat` of lib/ and extensions/ (must be clean)."""
import subprocess, sys, json
ROOT = sys.argv[1]
M = [
 ("stop-keeps-launch", "lib/subagents/team.ts", "const launch = (this.launches.get(name) ?? 0) + 1;\n\t\tif (options.by", "const launch = this.launches.get(name) ?? 0;\n\t\tif (options.by",
  [("\t\tthis.launches.set(name, launch);\n\t\t// An interrupted", "\t\t// An interrupted")]),
 ("stop-ignores-relaunch", "lib/subagents/team.ts", "if (this.launches.get(name) !== launch || this.records.get(name)?.state !== \"stopped\") {", "if (false) {"),
 ("work-ignores-gone", "lib/subagents/team.ts", "await handle.prompt(next);\n\t\t\tif (this.gone(name, launch)) return false;", "await handle.prompt(next);"),
 ("open-ignores-gone", "lib/subagents/team.ts", "\t\tif (this.gone(name, launch)) {\n\t\t\tawait handle.dispose();\n\t\t\treturn null;\n\t\t}\n", ""),
 ("stop-keeps-resume", "lib/subagents/team.ts", "\t\tthis.slots.remove(name);\n\t\tthis.parkResume(name);\n", "\t\tthis.slots.remove(name);\n"),
 ("stop-drops-unread", "lib/subagents/team.ts", "stopReason: options.reason, report: report(), ...this.unreadLeft(name) });", "stopReason: options.reason, report: report() });"),
 ("resume-ignores-slots", "lib/subagents/team.ts", "if (this.slots.free()) return void this.run(name, text);", "return void this.run(name, text);"),
 ("finish-keeps-waiters", "lib/subagents/team.ts", "\t\tthis.answers.forget(name);\n\t\tthis.settleWaiters(name, record);\n", "\t\tthis.answers.forget(name);\n"),
 ("resume-failed-drops-message", "lib/subagents/team.ts", "\t\tconst previous = this.records.get(name)!;\n\t\tthis.parkResume(name);\n", "\t\tconst previous = this.records.get(name)!;\n\t\tthis.resumePrompts.park(name);\n"),
 ("fallback-keeps-session", "lib/subagents/team.ts", "activity: `switching to ${step.to}` });\n\t\tvoid this.sessions.release(name);", "activity: `switching to ${step.to}` });"),
 ("late-skips-queue", "lib/subagents/team.ts", "const late = [...handle.takeQueued(), ...this.takeInbox(name)];", "const late = [...this.takeInbox(name)];"),
 ("stop-no-abort", "lib/subagents/team.ts", "await handle?.abort().catch(() => undefined);", "await undefined;"),
 ("settle-skips-finish", "lib/subagents/team.ts", "this.patch(name, { state: \"idle\", endedAt: this.now(), activity: null, report, unread: undefined });\n\t\tthis.finish(name);", "this.patch(name, { state: \"idle\", endedAt: this.now(), activity: null, report, unread: undefined });\n\t\tthis.pump();"),
 ("stop-refuses-ending", "lib/subagents/team.ts", "if (!record || (!LIVE_STATES", "if (!record || this.ending.has(name) || (!LIVE_STATES"),
 ("old-stop-clears-ending", "lib/subagents/team.ts", "if (this.ending.get(name) === launch) this.ending.delete(name);", "this.ending.delete(name);"),
 ("old-stop-clears-parent-mark", "lib/subagents/team.ts", "if (this.stoppedByParent.get(name) === launch) this.stoppedByParent.delete(name);", "this.stoppedByParent.delete(name);",
  [("const silent = mark !== undefined && mark === this.launches.get(name);", "const silent = mark !== undefined;")]),
 ("gate-no-reabort", "lib/subagents/child-prompt.ts", "\t\t\t\t\tif (disposition === \"started\" && run.aborted) abortAgain(\"the abort at the run's start\");\n", ""),
 ("gate-abort-skips-prompt", "lib/subagents/child-prompt.ts", "Promise.all([session.abort(), run?.ended])", "Promise.all([session.abort()])"),
 ("gate-no-compaction-abort", "lib/subagents/child-prompt.ts", "\tsession.subscribe?.((event) => {", "\tvoid ((event: { type: string }) => {"),
 ("dispose-no-wait", "lib/subagents/child.ts", "\t\tif (gate.busy()) await gate.shut().catch(() => undefined);\n", ""),
 ("gate-abort-unbounded", "lib/subagents/child-prompt.ts", "await (run && !run.started ? bounded(done) : done);", "await done;"),
 ("gate-no-shut-listener", "lib/subagents/child-prompt.ts", "\tagent?.subscribe((event) => {", "\tvoid ((event: { type: string }) => {"),
 ("check-skips-steers", "lib/subagents/team.ts", "\t\t\tconst landing = handle.steering?.();\n\t\t\tif (landing) await landing;\n", ""),
 ("prompt-skips-steers", "lib/subagents/child-prompt.ts", "\t\t\tconst landing = steering();\n\t\t\tif (landing) await landing;\n", ""),
 ("pump-starts-any", "lib/subagents/slots.ts", "if (record?.state !== \"queued\") { this.dropGoOn(name); continue; }", ""),
 ("stop-relaunch-ignores-state", "lib/subagents/team.ts", "if (this.launches.get(name) !== launch || this.records.get(name)?.state !== \"stopped\") {", "if (this.launches.get(name) !== launch) {"),
 ("run-settles-without-late", "lib/subagents/team.ts", "\t\t\t\tnext = this.late(name, handle);\n", "\t\t\t\tnext = null;\n"),
 ("open-no-dispose", "lib/subagents/team.ts", "if (this.gone(name, launch)) {\n\t\t\tawait handle.dispose();\n\t\t\treturn null;", "if (this.gone(name, launch)) {\n\t\t\treturn null;"),
]
only = sys.argv[2:] 
out = []
for name, path, a, b, *more in M:
    if only and name not in only: continue
    f = f"{ROOT}/{path}"; src = open(f).read()
    pairs = [(a, b), *(more[0] if more else [])]
    bad = [x for x, _ in pairs if src.count(x) != 1]
    if bad: out.append((name, f"PATTERN x{src.count(bad[0])}")); continue
    changed = src
    for x, y in pairs: changed = changed.replace(x, y)
    open(f, "w").write(changed)
    try:
        r = subprocess.run(["node", "--test", "tests/subagents-lifecycle-conformance.test.mts"], cwd=ROOT, capture_output=True, text=True, timeout=600)
        txt = r.stdout + r.stderr
        first = next((l.strip() for l in txt.splitlines() if "differ" in l or "Error" in l or "assert" in l.lower()), "")
        out.append((name, "CAUGHT" if r.returncode != 0 else "missed", first[:220]))
    finally:
        open(f, "w").write(src)
for o in out: print(" | ".join(o))
d = subprocess.run(["git", "diff", "--stat", "--", "lib", "extensions"], cwd=ROOT, capture_output=True, text=True).stdout
print("git diff lib extensions:", d.strip() or "clean")
