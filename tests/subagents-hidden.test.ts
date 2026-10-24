/**
 * A child can't read other agents' sessions and reports, or main's session,
 * with read, grep, find or ls: an independent opinion must not see the work
 * of the agents beside it. Its own files, its subagents' and the reports it
 * was given stay readable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readGuard } from "../lib/subagents/child.ts";
import { hiddenFrom, hiddenReason, type HiddenPaths } from "../lib/subagents/hidden.ts";
import { bwrapHiding, hidingFor, seatbeltHiding, seatbeltProfile, NO_GIT_WRITES } from "../lib/subagents/sandbox.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

function place() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagents-hidden-")));
	const dir = join(root, "agent", "sessions", "subagents");
	const mine = join(dir, "s1", "t_scout_1.jsonl");
	const other = join(dir, "s1", "t_impl_2.jsonl");
	const main = join(root, "agent", "sessions", "--proj--", "main.jsonl");
	const project = join(root, "proj");
	for (const folder of [join(dir, "s1"), join(root, "agent", "sessions", "--proj--"), project]) mkdirSync(folder, { recursive: true });
	for (const file of [mine, other, main, mine.replace(".jsonl", ".run-1.report.md"), other.replace(".jsonl", ".run-1.report.md")]) writeFileSync(file, "x");
	const hidden: HiddenPaths = { dirs: [dir], files: [main], readable: (path) => path === mine || path.startsWith(mine.replace(/\.jsonl$/, ".")) };
	return { root, dir, mine, other, main, project, hidden, done: () => rmSync(root, { recursive: true, force: true }) };
}

const HIDDEN = /is hidden from subagents/;

test("read refuses other agents' files and main's session, and allows the child's own", () => {
	const p = place();
	try {
		assert.match(hiddenReason(p.hidden, "read", { path: p.other }, p.project) ?? "", HIDDEN);
		assert.match(hiddenReason(p.hidden, "read", { path: p.other.replace(".jsonl", ".run-1.report.md") }, p.project) ?? "", HIDDEN);
		assert.match(hiddenReason(p.hidden, "read", { path: p.main }, p.project) ?? "", HIDDEN);
		assert.match(hiddenReason(p.hidden, "read", { path: join(p.dir, "s1", "index.json") }, p.project) ?? "", HIDDEN, "a file that does not exist yet is hidden too");
		assert.equal(hiddenReason(p.hidden, "read", { path: p.mine }, p.project), undefined);
		assert.equal(hiddenReason(p.hidden, "read", { path: p.mine.replace(".jsonl", ".run-1.report.md") }, p.project), undefined);
		assert.equal(hiddenReason(p.hidden, "read", { path: "README.md" }, p.project), undefined, "an ordinary file");
		assert.equal(hiddenReason(p.hidden, "edit", { path: p.other }, p.project), undefined, "only the read tools");
	} finally { p.done(); }
});

test("a relative path, a symlink or ~ that lands in the folder is hidden too", () => {
	const p = place();
	try {
		symlinkSync(join(p.dir, "s1"), join(p.project, "peek"));
		assert.match(hiddenReason(p.hidden, "read", { path: "peek/t_impl_2.jsonl" }, p.project) ?? "", HIDDEN);
		assert.match(hiddenReason(p.hidden, "read", { path: `../agent/sessions/subagents/s1/t_impl_2.jsonl` }, p.project) ?? "", HIDDEN);
		assert.match(hiddenReason(p.hidden, "read", { path: `@${p.other}` }, p.project) ?? "", HIDDEN);
	} finally { p.done(); }
});

test("ls and find and grep refuse the folder, and grep and find a folder that holds it; ls of a folder above only lists names", () => {
	const p = place();
	try {
		for (const tool of ["ls", "find", "grep"]) assert.match(hiddenReason(p.hidden, tool, { path: join(p.dir, "s1") }, p.project) ?? "", HIDDEN, tool);
		assert.match(hiddenReason(p.hidden, "grep", { path: p.root }, p.project) ?? "", /holds a folder hidden from subagents/);
		assert.match(hiddenReason(p.hidden, "find", { path: join(p.root, "agent") }, p.project) ?? "", /holds a folder hidden from subagents/);
		assert.match(hiddenReason(p.hidden, "grep", { path: join(p.root, "agent", "sessions", "--proj--") }, p.project) ?? "", /holds a file hidden from subagents/, "main's session");
		assert.equal(hiddenReason(p.hidden, "ls", { path: join(p.root, "agent") }, p.project), undefined);
		assert.equal(hiddenReason(p.hidden, "grep", { path: p.mine }, p.project), undefined, "its own file");
		assert.equal(hiddenReason(p.hidden, "grep", {}, p.project), undefined, "the default is the cwd");
		assert.match(hiddenReason(p.hidden, "grep", {}, p.root) ?? "", /holds a folder hidden/, "a cwd that holds the folder");
	} finally { p.done(); }
});

test("the read guard blocks a call before it runs, and replaces a result whose path became hidden", async () => {
	const p = place();
	try {
		const handlers = new Map<string, (event: unknown) => unknown>();
		(readGuard(p.hidden, p.project) as { factory(pi: never): void }).factory({ on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) } as never);
		const blocked = handlers.get("tool_call")!({ toolName: "read", input: { path: p.other } }) as { block: boolean; reason: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, HIDDEN);
		assert.equal(handlers.get("tool_call")!({ toolName: "read", input: { path: "README.md" } }), undefined);
		// A link the same reply made after the check: the result is replaced.
		symlinkSync(join(p.dir, "s1"), join(p.project, "late"));
		const replaced = handlers.get("tool_result")!({ toolName: "read", input: { path: "late/t_impl_2.jsonl" }, content: [{ type: "text", text: "secret" }] }) as { content: Array<{ text: string }>; isError: boolean };
		assert.equal(replaced.isError, true);
		assert.match(replaced.content[0]!.text, HIDDEN);
		assert.equal(handlers.get("tool_result")!({ toolName: "bash", input: { command: "cat late/x" }, content: [] }), undefined, "bash is the sandbox's job");
	} finally { p.done(); }
});

const agent = (name: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
	name, parent: "main", depth: 1, task: "t", model: "m", readOnly: false, fork: false, blocking: false,
	state: "idle", createdAt: 0, activity: null, toolCalls: 0, usage: NO_USAGE, runs: 1, ...extra,
});

test("a child may read its own files, its subagents' and the reports of the agents it started after, unless afterReports is false", () => {
	const p = place();
	try {
		const file = (name: string) => join(p.dir, "s1", `t_${name}_1.jsonl`);
		for (const name of ["lead", "helper", "impl", "review", "blind", "peer"]) writeFileSync(file(name), "x");
		const records = [
			agent("lead", { sessionFile: file("lead"), depth: 1 }),
			agent("helper", { sessionFile: file("helper"), parent: "lead", depth: 2 }),
			agent("impl", { sessionFile: file("impl") }),
			agent("review", { sessionFile: file("review"), after: ["impl"] }),
			agent("blind", { sessionFile: file("blind"), after: ["impl"], afterReports: false }),
			agent("peer", { sessionFile: file("peer") }),
		];
		const byName = new Map(records.map((record) => [record.name, record]));
		const team = { get: (name: string) => byName.get(name), list: () => records, under: (name: string, ancestor: string) => byName.get(name)?.parent === ancestor };
		const hidden = hiddenFrom(p.dir, p.main, () => team);
		const report = (name: string) => file(name).replace(".jsonl", ".run-1.report.md");
		const may = (who: string, path: string) => hidden(byName.get(who)!).readable(path);
		assert.equal(may("lead", report("lead")), true, "its own report");
		assert.equal(may("lead", file("helper")), true, "its subagent's session");
		assert.equal(may("lead", file("peer")), false);
		assert.equal(may("helper", file("lead")), false, "not its parent's");
		assert.equal(may("review", report("impl")), true, "the report it was given");
		assert.equal(may("blind", report("impl")), false, "afterReports: false");
		assert.equal(may("blind", report("blind")), true);
		assert.deepEqual(hidden(byName.get("peer")!).files, [p.main]);
	} finally { p.done(); }
});

test("the sandbox hides the folders with an empty tmpfs and the files with /dev/null; seatbelt denies their reads last", () => {
	const p = place();
	try {
		assert.deepEqual(bwrapHiding({ dirs: [p.dir, "/missing/dir"], files: [p.main, "/missing/file"] }), ["--tmpfs", p.dir, "--ro-bind", "/dev/null", p.main]);
		assert.deepEqual(seatbeltHiding({ dirs: ["/a/b"], files: ["/a/m.jsonl"] }), ['(deny file-read* (subpath "/a/b"))', '(deny file-read* (literal "/a/m.jsonl"))']);
		assert.ok(seatbeltProfile(["/x/repo"], NO_GIT_WRITES, { dirs: ["/a/b"], files: [] }).endsWith('(deny file-read* (subpath "/a/b"))'));
	} finally { p.done(); }
});

const bwrapWorks = process.platform === "linux" && spawnSync("bwrap", ["--dev-bind", "/", "/", "true"]).status === 0;

test("a real bwrap sandbox: bash can't read the hidden folder or main's session, and reads the rest", { skip: !bwrapWorks && "needs a working bwrap" }, () => {
	const p = place();
	try {
		writeFileSync(join(p.project, "plain.txt"), "plain");
		const prefix = hidingFor({ dirs: [p.dir], files: [p.main] }, (why) => assert.fail(why));
		assert.ok(prefix);
		const run = (command: string) => spawnSync(prefix[0]!, [...prefix.slice(1), "sh", "-c", command], { encoding: "utf8", cwd: p.project });
		assert.equal(run(`ls -A ${JSON.stringify(p.dir)}`).stdout, "", "an empty folder");
		assert.notEqual(run(`cat ${JSON.stringify(p.other)}`).status, 0);
		assert.equal(run(`cat ${JSON.stringify(p.main)}`).stdout, "", "main's session reads as empty");
		assert.equal(run("cat plain.txt").stdout, "plain");
		assert.equal(run("echo made > made.txt && cat made.txt").stdout, "made\n", "it can still write outside");
	} finally { p.done(); }
});
