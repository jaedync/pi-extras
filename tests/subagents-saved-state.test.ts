/**
 * What the index and session files keep across a restart or a /reload: a
 * held answer, records with odd paths, a stopped run's report, unread mail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { parkHost, takeParked } from "../lib/subagents/host.ts";
import { hostHarness } from "./support/host-harness.ts";

test("a held answer stays held when a quiet host is renewed after a /reload", async () => {
	const h = hostHarness({ resumePolicy: "notify" });
	try {
		const host = h.open(h.portsFor("first"));
		const name = h.spawn(host, "Ask main something");
		await tick();
		host.park();
		const session = {};
		parkHost(session, host, { log: () => undefined });
		const asked = host.team.send(name, "main", "Which branch?", { expectReply: true });
		await sleep(10);
		await takeParked(session)!.close("reload");
		await asked;
		const reopened = h.open(h.portsFor("next"));
		await reopened.restore("startup");
		await sleep(20);
		for (const item of reopened.mail.pending()) reopened.mail.acknowledge(item.id);
		assert.equal(reopened.team.get(name)?.state, "interrupted");
		// What Service.renew does once an adopted host from an older generation is quiet.
		const renewed = h.open(h.portsFor("renewed"), { lease: reopened.handOver(), generation: 2 });
		await reopened.retire();
		const answer = await renewed.team.send("main", name, "release/2.0");
		assert.equal(answer.ok && answer.delivered, "inbox", "the answer waits for the user to resume it");
		assert.equal(renewed.team.get(name)?.state, "interrupted");
		await renewed.close();
	} finally { h.cleanup(); }
});
