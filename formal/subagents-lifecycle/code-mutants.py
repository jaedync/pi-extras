#!/usr/bin/env python3
"""Apply each guard change to the real code, one at a time, run the conformance test, and restore the file.

    python3 formal/subagents-lifecycle/code-mutants.py "$PWD" [name ...]

It prints CAUGHT or missed for each change, then `git diff --stat` of lib/ and extensions/ (must be clean)."""
import subprocess, sys, json
ROOT = sys.argv[1]
M = [
 ("stop-keeps-launch", "lib/subagents/team.ts", "const launch = (this.launches.get(name) ?? 0) + 1;\n\t\tthis.launches.set(name, launch);\n\t\t// An interrupted", "const launch = (this.launches.get(name) ?? 0);\n\t\t// An interrupted"),
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
 ("stop-no-ending-guard", "lib/subagents/team.ts", "if (!record || this.ending.has(name) || (!LIVE_STATES", "if (!record || (!LIVE_STATES"),
 ("pump-starts-any", "lib/subagents/slots.ts", "if (record?.state !== \"queued\") { this.dropGoOn(name); continue; }", ""),
]
only = sys.argv[2:] 
out = []
for name, path, a, b in M:
    if only and name not in only: continue
    f = f"{ROOT}/{path}"; src = open(f).read()
    if src.count(a) != 1: out.append((name, f"PATTERN x{src.count(a)}")); continue
    open(f, "w").write(src.replace(a, b))
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
