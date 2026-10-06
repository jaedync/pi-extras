import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { checkoutOf, resolveCwd } from "../lib/subagents/checkout.ts";
import { createLauncher } from "../lib/subagents/child.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import { Team } from "../lib/subagents/team.ts";
import { NO_USAGE, type AgentRecord, type SpawnRequest } from "../lib/subagents/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));

function repository(path: string): string {
	mkdirSync(path, { recursive: true });
	git(path, "init", "-q");
	git(path, "config", "user.name", "Test");
	git(path, "config", "user.email", "test@example.invalid");
	writeFileSync(join(path, "tracked.txt"), "committed\n");
	git(path, "add", "-A");
	git(path, "commit", "-qm", "initial");
	return path;
}

/** A home folder that is not a repository, with two repositories, two plain folders, a file and a link to the first repository. */
function places(t: TestContext) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "subagent-cwd-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const one = repository(join(home, "one"));
	const two = repository(join(home, "two"));
	mkdirSync(join(one, "sub"));
	const notes = join(home, "notes");
	const drafts = join(home, "drafts");
	mkdirSync(notes);
	mkdirSync(drafts);
	writeFileSync(join(home, "file.txt"), "not a directory\n");
	symlinkSync(one, join(home, "link"), "dir");
	return { home, one, two, notes, drafts };
}

const request = (name: string, patch: Partial<SpawnRequest> = {}): SpawnRequest => ({ name, task: "Write", parent: "main", model: "test/model",
	readOnly: false, fork: false, blocking: false, ...patch });
const record = (name: string, patch: Partial<AgentRecord> = {}): AgentRecord => ({ name, parent: "main", depth: 1, task: "Write", model: "test/model",
	readOnly: false, fork: false, blocking: false, state: "idle", activity: null, runs: 1, createdAt: 1, toolCalls: 0, usage: NO_USAGE, ...patch });

/** A team in `cwd` whose children run until it closes. */
function crew(cwd?: string) {
	const launched: AgentRecord[] = [];
	const team = new Team({ maxConcurrent: 8, maxDepth: 4, replyTimeoutMs: 100, ...(cwd ? { cwd } : {}), deliverToMain() {},
		launcher: { async launch(child) {
			launched.push(child);
			return { prompt: () => new Promise<void>(() => {}), steer() {}, abort: async () => {}, dispose: async () => {},
				messages: () => [], takeQueued: () => [], lastText: () => undefined };
		} },
	});
	return { team, launched };
}

function spawned(team: Team, wanted: SpawnRequest): AgentRecord {
	const result = team.spawn(wanted);
	assert.ok(result.ok, result.ok ? "" : result.error);
	return result.record;
}

test("cwd: ~ is the home folder, links resolve, and it must name an existing directory", (t) => {
	const { home, one, notes } = places(t);
	assert.equal(resolveCwd("~", home), home);
	assert.equal(resolveCwd("~/notes", home), notes);
	assert.equal(resolveCwd(`${notes}/`, home), notes);
	assert.equal(resolveCwd(join(home, "link", "sub"), home), join(one, "sub"));
	assert.throws(() => resolveCwd(join(home, "missing"), home), { message: `cwd ${join(home, "missing")} does not exist.` });
	assert.throws(() => resolveCwd(join(home, "file.txt"), home), { message: `cwd ${join(home, "file.txt")} is not a directory.` });
	assert.throws(() => resolveCwd("notes", home), /^Error: cwd must be an absolute path or start with ~\/: notes$/);
	assert.throws(() => resolveCwd("~other/notes", home), /absolute path or start with ~\//);
	for (const bad of [`${notes}\nrm -rf`, `${notes}\x1b[2J`, `${notes}\tx`, `${notes}\x7f`]) assert.throws(() => resolveCwd(bad, home), /control characters/, JSON.stringify(bad));
});

test("a checkout is git's top level of a directory, through links and subdirectories, or the directory itself outside git", (t) => {
	const { home, one, notes } = places(t);
	assert.equal(checkoutOf(one), one);
	assert.equal(checkoutOf(join(one, "sub")), one);
	assert.equal(checkoutOf(join(home, "link")), one);
	assert.equal(checkoutOf(join(home, "link", "sub")), one);
	assert.equal(checkoutOf(notes), notes);
});

test("a child spawned with cwd starts there and keeps its checkout; its helpers inherit both", async (t) => {
	const { home, one } = places(t);
	const { team, launched } = crew(home);
	const scout = spawned(team, request("scout", { cwd: join(home, "link", "sub") }));
	assert.equal(scout.cwd, join(one, "sub"));
	assert.equal(scout.checkout, one);
	const helper = spawned(team, request("helper", { parent: "scout" }));
	assert.equal(helper.cwd, join(one, "sub"));
	assert.equal(helper.checkout, one);
	const plain = spawned(team, request("plain"));
	assert.equal(plain.cwd, undefined, "without cwd it starts where the parent session works");
	assert.equal(plain.checkout, home);
	await tick();
	assert.equal(launched.find((child) => child.name === "scout")?.cwd, join(one, "sub"));
	await team.close();
});

test("a bad cwd is refused with what is wrong, and nothing starts", async (t) => {
	const { home } = places(t);
	const { team } = crew(home);
	for (const [cwd, error] of [[join(home, "missing"), /does not exist/], [join(home, "file.txt"), /is not a directory/], ["notes", /absolute path/]] as const) {
		const result = team.spawn(request("scout", { cwd }));
		assert.match(result.ok ? "" : result.error, error);
	}
	assert.equal(team.list().length, 0);
	await team.close();
});

test("writers in different repositories edit side by side; in one repository they conflict, through a link or a subdirectory too", async (t) => {
	const { home, one, two } = places(t);
	const { team } = crew(home);
	spawned(team, request("a", { cwd: one }));
	spawned(team, request("b", { cwd: two }));
	spawned(team, request("c", { cwd: join(home, "link", "sub") }));
	await tick();
	assert.equal(team.claimEdit("a", join(one, "a.txt")), undefined);
	assert.equal(team.claimEdit("b", join(two, "b.txt")), undefined, "another repository: no conflict");
	assert.equal(team.claimEdit("c", join(one, "sub", "c.txt")),
		`a is editing files in the checkout ${one} until its run ends. Do work that does not edit files, or tell main you need a worktree (isolation: "worktree").`);
	assert.match(team.claimEdit("c", join(home, "link", "c.txt")) ?? "", /^a is editing files in the checkout /, "the link is the same checkout");
	await team.close();
});

test("outside git, children with different cwds edit side by side; the same cwd, or none, conflicts", async (t) => {
	const { home, notes, drafts } = places(t);
	const { team } = crew(home);
	for (const [name, cwd] of [["a", notes], ["b", drafts], ["c", `${notes}/`], ["d", undefined], ["e", undefined], ["f", "~"]] as const) {
		spawned(team, request(name, cwd === "~" ? { cwd: home } : cwd ? { cwd } : {}));
	}
	await tick();
	assert.equal(team.claimEdit("a", join(notes, "a.md")), undefined);
	assert.equal(team.claimEdit("b", join(drafts, "b.md")), undefined, "another directory: no conflict");
	assert.equal(team.claimEdit("c", join(notes, "c.md")),
		`a is editing files outside git, for the workspace ${notes}, until its run ends. Do work that does not edit files, or tell main you need a cwd of your own.`);
	assert.equal(team.claimEdit("d", join(home, "d.md")), undefined);
	assert.match(team.claimEdit("e", join(home, "e.md")) ?? "", literal(`d is editing files outside git, for the workspace ${home},`), "two children in the parent's folder still conflict");
	assert.match(team.claimEdit("f", join(home, "f.md")) ?? "", /^d is editing/, "a cwd that is the parent's folder is the same checkout");
	await team.close();
});

test("without a cwd anywhere, children outside git still share one lock", async () => {
	const { team } = crew();
	spawned(team, request("a"));
	spawned(team, request("b"));
	assert.equal(team.claimEdit("a"), undefined);
	assert.match(team.claimEdit("b") ?? "", /^a is editing files outside git until its run ends\./);
	await team.close();
});

test("a worktree comes from the repository at cwd, even when the parent's folder is not a repository", async (t) => {
	const { home, one, two, notes } = places(t);
	const { team, launched } = crew(home);
	writeFileSync(join(one, "sub", "notes.txt"), "uncommitted\n");
	const isolated = spawned(team, request("iso", { cwd: join(one, "sub"), isolation: "worktree" }));
	const tree = join(`${one}.worktrees`, "iso");
	assert.equal(isolated.worktree?.path, tree);
	assert.equal(isolated.checkout, tree);
	assert.equal(isolated.cwd, join(tree, "sub"), "it starts in the same directory of its worktree");
	assert.equal(spawned(team, request("top", { cwd: one, isolation: "worktree" })).cwd, join(`${one}.worktrees`, "top"));
	assert.equal(spawned(team, request("deep", { cwd: join(one, "sub"), isolation: "worktree", parent: "iso" })).cwd, join(`${one}.worktrees`, "deep", "sub"));
	assert.equal(spawned(team, request("aide", { parent: "iso" })).cwd, join(tree, "sub"), "a helper starts where its parent does");
	const nest = spawned(team, request("nest", { parent: "iso", isolation: "worktree" }));
	assert.deepEqual([nest.worktree?.path, nest.cwd], [join(`${tree}.worktrees`, "nest"), join(`${tree}.worktrees`, "nest", "sub")],
		"a helper's own worktree is made from where its parent works, and it starts in the same directory");
	assert.match(git(one, "worktree", "list"), /one\.worktrees\/iso /);
	const parentless = team.spawn(request("lost", { isolation: "worktree" }));
	assert.match(parentless.ok ? "" : parentless.error, /^Worktree isolation needs a git repository in the parent's workspace\./, "no cwd: today's rule");
	const plain = team.spawn(request("plain", { cwd: notes, isolation: "worktree" }));
	assert.match(plain.ok ? "" : plain.error, literal(`Worktree isolation needs a git repository in ${notes}.`));
	const stray = team.spawn(request("stray", { parent: "iso", cwd: two }));
	assert.match(stray.ok ? "" : stray.error, literal(`iso's subagents work in its worktree ${isolated.worktree?.path}.`));
	const own = spawned(team, request("own", { parent: "iso", cwd: two, isolation: "worktree" }));
	assert.equal(own.worktree?.path, join(`${two}.worktrees`, "own"), "a worktree of its own may come from anywhere");
	spawned(team, request("reader", { readOnly: true }));
	const hooks = team.spawn(request("hooks", { parent: "reader", readOnly: true, cwd: two, isolation: "worktree" }));
	assert.match(hooks.ok ? "" : hooks.error, /^reader is read-only, so its subagents can't make a worktree from a cwd\./, "git would run that repository's hooks");
	assert.ok(team.spawn(request("looks", { parent: "reader", readOnly: true, cwd: two })).ok, "reading there is fine");
	await tick();
	assert.equal(launched.find((child) => child.name === "iso")?.worktree?.path, isolated.worktree?.path);
	await team.close();
});

test("a message resumes a writer at once; its next edit takes the lock of its checkout, so the same checkout waits and another does not", async (t) => {
	const { home, one, two } = places(t);
	const { team } = crew(home);
	team.restore([record("a", { cwd: one, checkout: one }), record("c", { cwd: two, checkout: two })]);
	spawned(team, request("b", { cwd: one }));
	await tick();
	assert.equal(team.claimEdit("b", join(one, "b.txt")), undefined);
	assert.deepEqual(await team.send("main", "a", "Continue"), { ok: true, delivered: "resumed" });
	assert.deepEqual(await team.send("main", "c", "Continue"), { ok: true, delivered: "resumed" });
	await tick();
	assert.equal(team.get("a")?.state, "running");
	assert.match(team.claimEdit("a", join(one, "a.txt")) ?? "", literal(`b is editing files in the checkout ${one} until its run ends.`));
	assert.equal(team.claimEdit("c", join(two, "c.txt")), undefined);
	await team.close();
});

test("a child whose cwd is gone is not resumed", async (t) => {
	const { home } = places(t);
	const { team } = crew(home);
	const gone = join(home, "removed");
	team.restore([record("a", { cwd: gone, checkout: gone })]);
	const result = await team.send("main", "a", "Continue");
	assert.match(result.ok ? "" : result.error, literal(`The child workspace no longer exists: ${gone}.`));
	await team.close();
});

test("the index keeps each child's cwd and checkout, and a restore keeps them", async (t) => {
	const { home, one } = places(t);
	const dir = join(home, "index");
	const worktree = { path: join(`${one}.worktrees`, "iso"), branch: "subagent/iso", base: "a".repeat(40) };
	new ChildIndex(dir, "parent", home).save([record("a", { cwd: join(one, "sub"), checkout: one }), record("old"), record("iso", { worktree }),
		record("moved", { checkout: "/where/main/was" })]);
	const loaded = new ChildIndex(dir, "parent", home).load(() => {});
	assert.deepEqual(loaded.map((child) => [child.cwd, child.checkout]), [[join(one, "sub"), one], [undefined, undefined], [undefined, undefined], [undefined, "/where/main/was"]]);
	const { team } = crew(home);
	team.restore(loaded);
	assert.equal(team.get("a")?.cwd, join(one, "sub"));
	assert.equal(team.get("a")?.checkout, one);
	assert.equal(team.get("old")?.checkout, home, "a record saved before checkouts gets the parent session's");
	assert.equal(team.get("iso")?.checkout, worktree.path);
	assert.equal(team.get("moved")?.checkout, home, "without a cwd it resumes where main works now, so its checkout follows");
	await team.close();
	for (const bad of [{ cwd: "relative/path" }, { checkout: "relative" }, { cwd: `${one}\nx` }, { cwd: `${one}\x1b[2J` }, { checkout: 3 }]) {
		new ChildIndex(dir, "parent", home).save([record("a", bad as never)]);
		assert.throws(() => new ChildIndex(dir, "parent", home).load(() => {}), /Invalid child index/, JSON.stringify(bad));
	}
});

function sdkHarness(trust: { resources?: boolean; decision?: boolean | null; fallback?: string } = {}) {
	const directories: string[] = [];
	/** What each settings manager was told: the trust it was created with, then the decision set on it. */
	const settings: Array<{ created?: boolean; set?: boolean }> = [];
	const asked: string[] = [];
	const session = { sessionFile: undefined, bindExtensions: async () => {}, subscribe: () => () => {}, dispose() {} };
	const sdk = {
		SettingsManager: { create: (cwd: string, _agentDir: string, options?: { projectTrusted?: boolean }) => {
			directories.push(cwd);
			const told: { created?: boolean; set?: boolean } = { ...(options?.projectTrusted !== undefined ? { created: options.projectTrusted } : {}) };
			settings.push(told);
			return { getDefaultProjectTrust: () => trust.fallback ?? "ask", setProjectTrusted: (value: boolean) => { told.set = value; } };
		} },
		hasTrustRequiringProjectResources: (dir: string) => { asked.push(dir); return trust.resources ?? true; },
		ProjectTrustStore: class { get(dir: string) { asked.push(`store ${dir}`); return trust.decision ?? null; } },
		SessionManager: { inMemory: (cwd: string) => { directories.push(cwd); return {}; } },
		DefaultResourceLoader: class { constructor(options: { cwd: string }) { directories.push(options.cwd); } async reload() {} },
		resolveCliModel: () => ({ model: { provider: "test", api: "test", id: "model" } }),
		createAgentSession: async (options: { cwd: string }) => { directories.push(options.cwd); return { session }; },
	};
	return { directories, settings, asked, sdk };
}

test("a child with cwd gets its settings, resources, session and tools there", async (t) => {
	const { notes } = places(t);
	const { sdk, directories } = sdkHarness();
	const launcher = createLauncher({ sdk: sdk as never, agentDir: notes, cwd: "/parent", sessionDir: null,
		modelRuntime: async () => ({}) as never, toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "" });
	const child = await launcher.launch(record("a", { cwd: notes, checkout: notes }), { update() {} });
	assert.deepEqual(directories, [notes, notes, notes, notes]);
	await child.dispose();
	await assert.rejects(launcher.launch(record("b", { cwd: join(notes, "gone") }), { update() {} }), /workspace no longer exists/);
});

/** A launcher whose parent works in `agentDir` too, which exists. */
const launcherFor = (sdk: unknown, agentDir: string) => createLauncher({ sdk: sdk as never, agentDir, cwd: agentDir, sessionDir: null,
	modelRuntime: async () => ({}) as never, toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "" });

test("a child with a cwd of its own uses that directory's project settings only as Pi would trust them without a prompt", async (t) => {
	const { notes, one } = places(t);
	const cases = [
		[{ resources: false }, true, "nothing there needs trust"],
		[{ decision: true }, true, "you trusted it"],
		[{ decision: false }, false, "you did not trust it"],
		[{}, false, "no decision, and no one to ask"],
		[{ fallback: "always" }, true, "defaultProjectTrust: always"],
	] as const;
	for (const [trust, expected, why] of cases) {
		const { sdk, settings } = sdkHarness(trust);
		const child = await launcherFor(sdk, notes).launch(record("a", { cwd: notes, checkout: notes }), { update() {} });
		assert.deepEqual(settings, [{ created: false, set: expected }], why);
		await child.dispose();
	}
	const { sdk, settings, asked } = sdkHarness();
	const child = await launcherFor(sdk, notes).launch(record("main-place"), { update() {} });
	assert.deepEqual([settings, asked], [[{}], []], "a child in main's directory keeps today's settings");
	await child.dispose();
	const tree = join(`${one}.worktrees`, "iso");
	mkdirSync(join(tree, "sub"), { recursive: true });
	const isolated = sdkHarness({ decision: true });
	const inTree = await launcherFor(isolated.sdk, notes).launch(record("iso", { cwd: join(tree, "sub"), checkout: tree,
		worktree: { path: tree, branch: "subagent/iso", base: "a".repeat(40) } }), { update() {} });
	assert.deepEqual(isolated.asked, [join(one, "sub"), `store ${join(one, "sub")}`], "a worktree takes the trust of the place it was made from");
	assert.deepEqual(isolated.directories, [join(tree, "sub"), join(tree, "sub"), join(tree, "sub"), join(tree, "sub")]);
	await inTree.dispose();
});
