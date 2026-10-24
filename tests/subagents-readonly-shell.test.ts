/**
 * `readOnlyShell`: a read-only child that also gets bash, which runs in a
 * sandbox with read-only files, a private /tmp, no network and no view of
 * other processes. Without a sandbox, its bash does not run at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAllowlist } from "../lib/subagents/allowlist.ts";
import { childToolNames, noShell } from "../lib/subagents/child.ts";
import { childInstructions } from "../lib/subagents/format.ts";
import { readOnlyShellFor, readOnlyShellPrefix, NO_HIDING } from "../lib/subagents/sandbox.ts";
import { unixSocketFilter } from "../lib/subagents/seccomp.ts";
import { subagentTool } from "../lib/subagents/tools.ts";
import { teamHarness } from "./support/team-harness.ts";

test("a read-only shell child gets bash beside the read tools, and no tool that writes", () => {
	const parent = ["read", "bash", "edit", "write", "grep", "web_search", "message"];
	assert.deepEqual(childToolNames(parent, true, [], true), ["read", "grep", "find", "ls", "bash", "web_search"]);
	assert.deepEqual(childToolNames(parent, true), ["read", "grep", "find", "ls", "web_search"], "plain readOnly has no bash");
	const available = childToolNames(parent, true, [], true);
	assert.deepEqual(checkAllowlist(["read", "bash"], available, true, true), { ok: true, tools: ["read", "bash"] });
	const refused = checkAllowlist(["bash", "edit"], available, true, true);
	assert.ok(!refused.ok && /cannot list edit/.test(refused.error));
	const plain = checkAllowlist(["bash"], childToolNames(parent, true), true);
	assert.ok(!plain.ok && /cannot list bash/.test(plain.error));
});

test("readOnlyShell makes the child read-only, and only an agent with a shell can pass one on", () => {
	const h = teamHarness();
	const shell = h.spawn("Look.", { name: "looker", readOnlyShell: true });
	assert.equal(h.team.get(shell)!.readOnly, true);
	assert.equal(h.team.get(shell)!.readOnlyShell, true);
	const plain = h.spawn("Read.", { name: "reader", readOnly: true });
	const refused = h.team.spawn({ task: "x", parent: plain, model: "m", readOnly: true, fork: false, blocking: false, readOnlyShell: true });
	assert.ok(!refused.ok && /A read-only subagent without a shell can't start one with readOnlyShell/.test(refused.error));
	const kept = h.team.spawn({ task: "x", parent: shell, model: "m", readOnly: true, fork: false, blocking: false, readOnlyShell: true });
	assert.ok(kept.ok && kept.record.readOnlyShell === true);
});

test("the Linux prefix: read-only root, fresh /dev, /proc and /tmp, no network, own process view, then the hidden paths", () => {
	const prefix = readOnlyShellPrefix(NO_HIDING, "linux");
	assert.ok(prefix);
	assert.deepEqual(prefix.slice(0, 2), ["/bin/sh", "-c"]);
	assert.match(prefix[2]!, /^exec "\$0" "\$@" 3<'.+no-unix\.bpf'$/);
	assert.deepEqual(prefix.slice(3), ["bwrap", "--seccomp", "3", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--tmpfs", "/tmp",
		"--unshare-net", "--die-with-parent", "--setenv", "GIT_OPTIONAL_LOCKS", "0"]);
	assert.equal(readOnlyShellPrefix(NO_HIDING, "win32"), undefined);
	const root = mkdtempSync("/tmp/subagents-roshell-");
	try {
		mkdirSync(join(root, "repo", "sub"), { recursive: true });
		assert.deepEqual(readOnlyShellPrefix(NO_HIDING, "linux", undefined, join(root, "repo", "sub"))!.slice(-3), ["--ro-bind", root, root], "a folder under /tmp stays seen");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the macOS profile denies writes but to the null devices, and denies the network", () => {
	const prefix = readOnlyShellPrefix({ dirs: ["/secret"], files: [] }, "darwin", () => true);
	assert.ok(prefix);
	const profile = prefix[2]!;
	assert.match(profile, /\(deny file-write\* \(subpath "\/"\)\)/);
	assert.match(profile, /\(allow file-write\* \(literal "\/dev\/null"\)/);
	assert.match(profile, /\(deny network\*\)/);
	assert.match(profile, /\(deny file-read\* \(subpath "\/secret"\)\)/);
});

test("the seccomp filter: 10 instructions for x64 and arm64, none for an unknown architecture", () => {
	assert.equal(unixSocketFilter("x64")!.length, 80);
	assert.equal(unixSocketFilter("arm64")!.readUInt32LE(12), 0xc00000b7, "the arm64 audit architecture");
	assert.equal(unixSocketFilter("riscv64"), undefined);
});

test("without a sandbox, the child's bash refuses every command", async () => {
	const bash = { name: "bash", label: "bash", description: "", parameters: {}, execute: async () => assert.fail("must not run") };
	const off = noShell(bash as never, "bwrap failed: no user namespaces");
	await assert.rejects(off.execute("id", { command: "ls" }, undefined, undefined, undefined as never), /bash is off: readOnlyShell needs a sandbox .* bwrap failed: no user namespaces/);
});

test("the spawn is refused where no read-only shell sandbox runs", async () => {
	const h = teamHarness();
	const allowed = [{ ref: "anthropic/claude-opus-5-5", model: { provider: "anthropic", id: "claude-opus-5-5", name: "Opus" } }];
	let problem: string | undefined = "bwrap is not installed.";
	const tool = subagentTool({ team: h.team, allowed: allowed as never, fallbackModel: allowed[0]!.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now,
		childTools: (readOnly, shell) => childToolNames(["read", "bash", "edit"], readOnly, [], shell), shellProblem: () => problem }, "main");
	const run = (params: Record<string, unknown>) => (tool.execute as any)("id", params, undefined, undefined);
	await assert.rejects(run({ task: "x", readOnlyShell: true }), /readOnlyShell needs a sandbox .* bwrap is not installed\./);
	problem = undefined;
	await run({ task: "x", name: "looker", readOnlyShell: true, tools: ["bash"] });
	assert.equal(h.team.get("looker")!.readOnlyShell, true);
	assert.deepEqual(h.team.get("looker")!.tools, ["bash"]);
	await h.team.close();
});

test("the child's instructions say what its shell can do", () => {
	const text = childInstructions({ name: "looker", parent: "main", readOnly: true, readOnlyShell: true, canSpawn: false, roster: "" });
	assert.match(text, /Your bash runs in a sandbox: files are read-only, \/tmp is private and empty at each command, there is no network/);
	assert.match(text, /git log, git show and git diff work/);
});

const bwrapWorks = process.platform === "linux" && spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "true"]).status === 0;

test("a real read-only shell: reads and git work; writes, the network and the hidden folder don't", { skip: !bwrapWorks && "needs a working bwrap" }, () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagents-roshell-")));
	try {
		const repo = join(root, "repo");
		const hidden = join(root, "hidden");
		mkdirSync(repo); mkdirSync(hidden);
		writeFileSync(join(hidden, "secret"), "s");
		writeFileSync(join(repo, "a.txt"), "a\n");
		const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
		git("init", "-q"); git("add", "a.txt"); git("commit", "-qm", "first");
		writeFileSync(join(repo, "a.txt"), "b\n");
		const prefix = readOnlyShellFor({ dirs: [hidden], files: [] }, (why) => assert.fail(why), repo);
		assert.ok(prefix);
		const run = (command: string) => spawnSync(prefix[0]!, [...prefix.slice(1), "sh", "-c", command], { encoding: "utf8", cwd: repo });
		assert.equal(run("cat a.txt").stdout, "b\n");
		assert.match(run("git log --oneline").stdout, /first/);
		assert.match(run("git diff").stdout, /^\+b$/m);
		assert.equal(run("git status --short").stdout, " M a.txt\n");
		assert.match(run("echo x > made.txt").stderr, /Read-only file system/);
		assert.equal(run("echo t > /tmp/t && cat /tmp/t").stdout, "t\n", "/tmp takes writes");
		assert.equal(run("test -e /tmp/t && echo kept || echo gone").stdout, "gone\n", "a fresh /tmp at each command");
		assert.equal(run("tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '").stdout, "lo\n", "only loopback");
		assert.ok(Number(run("ls /proc | grep -c '^[0-9]'").stdout) < 10, "only its own processes");
		assert.equal(run(`ls -A ${JSON.stringify(hidden)}`).stdout, "");
		assert.equal(run("echo hi > /dev/null && echo ok").stdout, "ok\n");
		const unix = run(`python3 -c "import socket; socket.socket(socket.AF_UNIX).connect('/run/dbus/system_bus_socket')"`);
		assert.match(unix.stderr, /PermissionError: \[Errno 13\]/, "no Unix socket can be made");
		assert.equal(run(`python3 -c "import socket; a, b = socket.socketpair(); a.send(b'p'); print(b.recv(1).decode())"`).stdout, "p\n", "socketpair still works");
		assert.equal(run("echo a | cat | tr a b").stdout, "b\n", "pipes work");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
