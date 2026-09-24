import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore, approvalsPath, parseAppList, parseApprovals } from "../lib/computer-use/approvals.ts";

test("the approvals file lives in the Computer Use service's group container", () => {
	assert.equal(approvalsPath("/Users/me"), "/Users/me/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json");
});

test("only the exact shape ChatGPT itself writes is treated as writable", () => {
	assert.deepEqual(parseApprovals(undefined), { writable: true, ids: [] });
	assert.deepEqual(parseApprovals('{\n  "approvedBundleIdentifiers": ["com.apple.finder"]\n}'), { writable: true, ids: ["com.apple.finder"] });
	for (const text of ["not json", "[]", '{"approvedBundleIdentifiers":"com.apple.finder"}', '{"approvedBundleIdentifiers":[1]}', '{"approvedBundleIdentifiers":[],"other":true}', '{}']) {
		const state = parseApprovals(text);
		assert.equal(state.writable, false, text);
	}
	// Unknown extras still show what can be read, but are never rewritten.
	assert.deepEqual(parseApprovals('{"approvedBundleIdentifiers":["com.apple.finder"],"v":2}').ids, ["com.apple.finder"]);
});

function scratch() {
	const home = mkdtempSync(join(tmpdir(), "cu-approvals-"));
	const path = approvalsPath(home);
	const container = join(home, "Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService");
	return { home, path, container, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("allowing and revoking rewrite the file the way ChatGPT does, and keep its mode", () => {
	const { path, container, done } = scratch();
	try {
		mkdirSync(join(container, "Library/Application Support/Software"), { recursive: true });
		writeFileSync(path, JSON.stringify({ approvedBundleIdentifiers: ["com.apple.finder"] }), { mode: 0o644 });
		const store = new ApprovalStore(path);
		store.allow("com.apple.Safari");
		store.allow("com.apple.Safari");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { approvedBundleIdentifiers: ["com.apple.finder", "com.apple.Safari"] });
		store.revoke("com.apple.finder");
		assert.deepEqual(store.read(), { writable: true, ids: ["com.apple.Safari"] });
		assert.equal(statSync(path).mode & 0o777, 0o644);
	} finally { done(); }
});

test("a file in an unexpected shape is never overwritten", () => {
	const { path, container, done } = scratch();
	try {
		mkdirSync(join(container, "Library/Application Support/Software"), { recursive: true });
		const original = '{"approvedBundleIdentifiers":["com.apple.finder"],"schema":2}';
		writeFileSync(path, original);
		const store = new ApprovalStore(path);
		assert.throws(() => store.revoke("com.apple.finder"), /manage apps in the ChatGPT app/);
		assert.equal(readFileSync(path, "utf8"), original);
	} finally { done(); }
});

test("the store refuses a missing service or a malformed bundle identifier", () => {
	const { path, container, done } = scratch();
	try {
		const store = new ApprovalStore(path);
		assert.throws(() => store.allow("com.apple.finder"), /Computer Use has not been set up/);
		mkdirSync(container, { recursive: true });
		for (const id of ["", "../x", "a b", "com.apple.finder\n", "x".repeat(300)]) assert.throws(() => store.allow(id), /not a bundle identifier/, id);
		store.allow("com.apple.finder");
		assert.deepEqual(store.read().ids, ["com.apple.finder"]);
	} finally { done(); }
});

test("list_apps output becomes named apps with bundle identifiers", () => {
	const text = [
		"iTerm2 — /Applications/iTerm.app/ — com.googlecode.iterm2 [frontmost, running, last-used=2026-09-23, uses=1]",
		"Finder — /System/Library/CoreServices/Finder.app/ — com.apple.finder [running]",
		"garbage line",
		"Evil\u001b[2J — /tmp/Evil.app/ — bad id [running]",
	].join("\n");
	assert.deepEqual(parseAppList(text), [
		{ name: "iTerm2", path: "/Applications/iTerm.app/", bundleId: "com.googlecode.iterm2", running: true },
		{ name: "Finder", path: "/System/Library/CoreServices/Finder.app/", bundleId: "com.apple.finder", running: true },
	]);
});
