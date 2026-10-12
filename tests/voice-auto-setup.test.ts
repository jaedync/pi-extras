import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvisionOptions } from "../lib/voice/provision.ts";

const home = mkdtempSync(join(tmpdir(), "voice-auto-"));
process.env.PI_VOICE_HOME = home;
const { Setup, startAutoSetup } = await import("../extensions/voice.ts");

interface Host {
	offline?: boolean;
	provisioned?: boolean;
	input?: boolean;
}

function host(over: Host = {}) {
	const state = { offline: false, provisioned: false, input: false, ...over };
	const calls = { hasInput: 0, probe: 0, stop: 0, start: 0 };
	let found: (() => void) | undefined;
	const deps = {
		offline: () => state.offline,
		provisioned: () => state.provisioned,
		hasInput: () => (calls.hasInput++, state.input),
		probe: (onFound: () => void) => {
			calls.probe++;
			found = onFound;
			return () => { calls.stop++; };
		},
		start: () => { calls.start++; },
	};
	return { state, calls, deps, found: () => found!() };
}

test("a host known to have a microphone starts setup at session start, with no probe", () => {
	const h = host({ input: true });
	startAutoSetup(h.deps);
	assert.deepEqual(h.calls, { hasInput: 1, probe: 0, stop: 0, start: 1 });
});

test("offline or already set up, nothing is checked, probed or started", () => {
	for (const over of [{ offline: true, input: true }, { provisioned: true, input: true }]) {
		const h = host(over);
		const stop = startAutoSetup(h.deps);
		stop();
		assert.deepEqual(h.calls, { hasInput: 0, probe: 0, stop: 0, start: 0 }, JSON.stringify(over));
	}
});

test("an undecided host probes, and starts setup only when the probe finds a microphone", () => {
	const h = host();
	startAutoSetup(h.deps);
	assert.deepEqual(h.calls, { hasInput: 1, probe: 1, stop: 0, start: 0 });
	h.found();
	assert.equal(h.calls.start, 1);
});

test("a probe verdict after dispose, after setup finished, or when offline starts nothing", () => {
	const disposed = host();
	startAutoSetup(disposed.deps)();
	assert.equal(disposed.calls.stop, 1, "dispose stops the probe");
	disposed.found();
	assert.equal(disposed.calls.start, 0);

	const done = host();
	startAutoSetup(done.deps);
	done.state.provisioned = true;
	done.found();
	assert.equal(done.calls.start, 0);

	const offline = host();
	startAutoSetup(offline.deps);
	offline.state.offline = true;
	offline.found();
	assert.equal(offline.calls.start, 0);
});

test("a probe verdict while a dictation's setup runs does not install twice", async () => {
	let runs = 0;
	let release!: () => void;
	const gate = new Promise<void>((done) => (release = done));
	const provision = async (_options: ProvisionOptions): Promise<"done" | "busy"> => {
		runs++;
		await gate;
		return "done";
	};
	const setup = new Setup({ home, provision, onProgress: () => {}, onFinish: () => {}, onCallbackError: (error) => assert.fail(String(error)) });
	const h = host();
	startAutoSetup({ ...h.deps, start: () => setup.start() });
	setup.start(); // the first dictation
	h.found();
	release();
	await new Promise((done) => setTimeout(done, 20));
	assert.equal(runs, 1);
	setup.dispose();
});
