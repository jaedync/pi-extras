/** A real parent session reloads (support/reload-harness.mts): a child in main's directory gets the project's .pi/ only as main's trust decision says, before and after a /reload. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyPackage, parent, projectWithPi, removeScratch, until } from "./support/reload-harness.mts";

for (const trusted of [false, true]) {
	test(`a child in main's directory gets the project's .pi/ only when main trusts it (${trusted ? "trusted" : "not trusted"})`, { timeout: 60_000, skip: process.platform === "win32" }, async () => {
		const p = await parent(copyPackage().root, { cwd: projectWithPi(), trusted });
		try {
			p.release("local");
			await p.spawn("local", "Look at the repository");
			await until("local finishes", () => p.record("local")?.state === "idle");
			assert.equal(p.record("local")?.report, trusted ? "local done on build 1 with PROJECT-SYSTEM, PROJECT-APPEND, PROJECT-PREFIX" : "local done on build 1");
		} finally { await p.close(); }
	});
}

test("a /reload after the user trusts the project gives later children its .pi/: the next module reads main's decision again", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const p = await parent(copyPackage().root, { cwd: projectWithPi(), trusted: false });
	try {
		p.release("before");
		await p.spawn("before", "Look before the user trusts it");
		await until("before finishes", () => p.record("before")?.state === "idle");
		assert.equal(p.record("before")?.report, "before done on build 1");
		p.session.settingsManager.setProjectTrusted(true);
		await p.session.reload();
		p.release("after");
		await p.spawn("after", "Look after the user trusts it");
		await until("after finishes", () => p.record("after")?.state === "idle");
		assert.equal(p.record("after")?.report, "after done on build 1 with PROJECT-SYSTEM, PROJECT-APPEND, PROJECT-PREFIX");
	} finally { await p.close(); }
});

test.after(removeScratch);
