import { test } from "node:test";
import assert from "node:assert/strict";
import { NAMESPACE, intercomNameGate } from "../lib/herdr-intercom-gate.ts";
import { fakeIntercom } from "./support/fake-intercom.ts";

function fakeTimers() {
	const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const later = (fn: () => void, ms: number) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; };
	return { timers, later };
}

test("gate: with no pi-intercom on the event bus, a name is set at once", () => {
	const { later, timers } = fakeTimers();
	const ran: string[] = [];
	const gate = intercomNameGate({ emit: () => {} }, { later });
	gate.run(() => ran.push("a"));
	assert.deepEqual(ran, ["a"]);
	assert.equal(timers.length, 0);
	// An event bus that throws (an old Pi, a broken listener) counts as no pi-intercom.
	const broken = intercomNameGate({ emit: () => { throw new Error("boom"); } }, { later });
	broken.run(() => ran.push("b"));
	assert.deepEqual(ran, ["a", "b"]);
});

test("gate: it registers one namespace that cannot own the channel", () => {
	const intercom = fakeIntercom();
	intercomNameGate(intercom.events, fakeTimers());
	assert.equal(intercom.state.registrations.length, 1);
	assert.equal(intercom.state.registrations[0]!.namespace, NAMESPACE);
	assert.equal(intercom.state.registrations[0]!.ownerEligible, false);
	assert.match(NAMESPACE, /^[a-z0-9][a-z0-9._/-]{0,63}$/);
});

test("gate: while pi-intercom connects, a name waits, and only the last one is set when the registration is done", () => {
	const intercom = fakeIntercom(false);
	const { later, timers } = fakeTimers();
	const ran: string[] = [];
	const gate = intercomNameGate(intercom.events, { later });
	gate.run(() => ran.push("first"));
	gate.run(() => ran.push("second"));
	assert.deepEqual(ran, []);
	assert.equal(timers.length, 1, "one fallback timer, not one for each name");
	intercom.connect(false);
	assert.deepEqual(ran, []);
	intercom.connect(true);
	assert.deepEqual(ran, ["second"]);
	assert.equal(timers[0]!.cancelled, true);
	intercom.connect(true);
	assert.deepEqual(ran, ["second"], "a later connection runs nothing again");
});

test("gate: when pi-intercom is connected, a name is set at once", () => {
	const intercom = fakeIntercom(true);
	const ran: string[] = [];
	const gate = intercomNameGate(intercom.events, fakeTimers());
	gate.run(() => ran.push("a"));
	assert.deepEqual(ran, ["a"]);
});

test("gate: a pi-intercom that never connects gets the name after the wait", () => {
	const intercom = fakeIntercom(false);
	const { later, timers } = fakeTimers();
	const ran: string[] = [];
	const gate = intercomNameGate(intercom.events, { later, waitMs: 7_000 });
	gate.run(() => ran.push("a"));
	assert.equal(timers[0]!.ms, 7_000);
	timers[0]!.fn();
	assert.deepEqual(ran, ["a"]);
	intercom.connect(true);
	assert.deepEqual(ran, ["a"]);
});

test("gate: cancel drops a waiting name; the gate still works for the next session", () => {
	const intercom = fakeIntercom(false);
	const { later, timers } = fakeTimers();
	const ran: string[] = [];
	const gate = intercomNameGate(intercom.events, { later });
	gate.run(() => ran.push("a"));
	gate.cancel();
	assert.equal(timers[0]!.cancelled, true);
	intercom.connect(true);
	assert.equal(ran.length, 0);
	intercom.connect(false);
	gate.run(() => ran.push("b"));
	assert.equal(timers.length, 2, "a new wait after the cancel");
	intercom.connect(true);
	assert.deepEqual(ran, ["b"]);
});

test("gate: a name that throws is reported, and the gate stays usable", () => {
	const intercom = fakeIntercom(false);
	const errors: unknown[] = [];
	const ran: string[] = [];
	const gate = intercomNameGate(intercom.events, { ...fakeTimers(), onError: (error) => errors.push(error) });
	gate.run(() => { throw new Error("pi refused"); });
	intercom.connect(true);
	assert.equal(errors.length, 1);
	gate.run(() => ran.push("b"));
	assert.deepEqual(ran, ["b"]);
});

test("gate: a channel whose snapshot throws is reported and no longer waited for", () => {
	const errors: unknown[] = [];
	const ran: string[] = [];
	const events = {
		emit: (_channel: string, data: unknown) => {
			(data as { onReady(channel: unknown): void }).onReady({ snapshot: () => { throw new Error("gone"); } });
		},
	};
	const { later, timers } = fakeTimers();
	const gate = intercomNameGate(events, { later, onError: (error) => errors.push(error) });
	gate.run(() => ran.push("a"));
	gate.run(() => ran.push("b"));
	assert.deepEqual(ran, ["a", "b"]);
	assert.equal(errors.length, 1);
	assert.equal(timers.length, 0);
});

test("gate: after one wait that ends with no connection, renames run at once until pi-intercom connects", () => {
	// pi-intercom with enabled=false (or a broker that is down) listens on the bus but never connects.
	const intercom = fakeIntercom(false);
	const { later, timers } = fakeTimers();
	const ran: string[] = [];
	const gate = intercomNameGate(intercom.events, { later });
	gate.run(() => ran.push("a"));
	timers[0]!.fn();
	gate.run(() => ran.push("b"));
	assert.deepEqual(ran, ["a", "b"]);
	assert.equal(timers.length, 1, "no second wait");
	// Once it connects, a later disconnect gets the wait back.
	intercom.connect(true);
	intercom.connect(false);
	gate.run(() => ran.push("c"));
	assert.deepEqual(ran, ["a", "b"]);
	assert.equal(timers.length, 2);
});
