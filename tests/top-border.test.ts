import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTopBorderMessage, TOP_BORDER_CHANNEL, TopBorderLink, voiceRow } from "../lib/top-border.ts";

function bus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const log: unknown[] = [];
	return {
		log,
		emit(channel: string, data: unknown) {
			log.push(data);
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
}

test("each side hears the other's state, and only changes are announced", () => {
	const events = bus();
	let spinnerHeard = 0;
	const spinner = new TopBorderLink(events, "phase-spinner", () => spinnerHeard++);
	const voice = new TopBorderLink(events, "voice", () => {});
	assert.equal(spinner.peerActive, false);
	voice.set(true);
	assert.equal(spinner.peerActive, true);
	assert.equal(spinnerHeard, 1);
	const sent = events.log.length;
	voice.set(true);
	assert.equal(events.log.length, sent, "no change, no message");
	voice.set(false);
	assert.equal(spinner.peerActive, false);
});

test("a late joiner learns the current state by saying hello", () => {
	const events = bus();
	const spinner = new TopBorderLink(events, "phase-spinner", () => {});
	spinner.set(true);
	const voice = new TopBorderLink(events, "voice", () => {});
	assert.equal(voice.peerActive, false, "missed the announcement");
	voice.hello();
	assert.equal(voice.peerActive, true);
	assert.equal(spinner.peerActive, false, "hello carries voice's own idle state");
});

test("a spinner that answers hello is known even while idle", () => {
	const events = bus();
	const spinner = new TopBorderLink(events, "phase-spinner", () => {});
	let changes = 0;
	const voice = new TopBorderLink(events, "voice", () => changes++);
	assert.equal(voice.peerKnown, false, "an older spinner never answers");
	voice.hello();
	assert.equal(voice.peerKnown, true);
	assert.equal(voice.peerActive, false);
	assert.equal(changes, 1, "first contact repaints");
	spinner.dispose();
	assert.equal(voice.peerKnown, true, "a released row is not a missing spinner");
	voice.dispose();
	assert.equal(voice.peerKnown, false);
});

test("answers to hello do not echo back and forth", () => {
	const events = bus();
	new TopBorderLink(events, "phase-spinner", () => {});
	const voice = new TopBorderLink(events, "voice", () => {});
	voice.hello();
	assert.equal(events.log.length, 2, "one hello and one reply");
});

test("messages from the same role, other channels' shapes and future versions are ignored", () => {
	const events = bus();
	const voice = new TopBorderLink(events, "voice", () => {});
	events.emit(TOP_BORDER_CHANNEL, { v: 1, from: "voice", active: true });
	events.emit(TOP_BORDER_CHANNEL, { v: 1, from: "phase-spinner", active: "yes" });
	events.emit(TOP_BORDER_CHANNEL, "busy");
	assert.equal(voice.peerActive, false);
	assert.equal(parseTopBorderMessage({ v: 2, from: "phase-spinner", active: true })?.active, true, "newer versions keep the v1 fields");
	assert.equal(parseTopBorderMessage({ v: 0, from: "phase-spinner", active: true }), undefined);
});

test("dispose stops listening and releases the row", () => {
	const events = bus();
	const spinner = new TopBorderLink(events, "phase-spinner", () => {});
	const voice = new TopBorderLink(events, "voice", () => {});
	voice.set(true);
	voice.dispose();
	assert.equal(spinner.peerActive, false);
	spinner.set(true);
	assert.equal(voice.peerActive, false);
});

test("a missing event bus leaves the link inert", () => {
	const link = new TopBorderLink(undefined, "voice", () => {});
	link.hello();
	link.set(true);
	assert.equal(link.peerActive, false);
});

test("voice takes the top row only when nothing else needs it", () => {
	const plain = "─".repeat(40);
	assert.equal(voiceRow({ spinnerBusy: false, piWorking: false, topLine: plain, spinnerKnown: true }), "top");
	assert.equal(voiceRow({ spinnerBusy: false, piWorking: false, topLine: `──── ↑ 3 more ────`, spinnerKnown: true }), "top");
	assert.equal(voiceRow({ spinnerBusy: true, piWorking: false, topLine: plain, spinnerKnown: true }), "bottom");
	assert.equal(voiceRow({ spinnerBusy: false, piWorking: true, topLine: plain, spinnerKnown: true }), "bottom", "Pi's own working indicator");
	assert.equal(voiceRow({ spinnerBusy: false, piWorking: false, topLine: "some other editor chrome", spinnerKnown: true }), "bottom");
	assert.equal(voiceRow({ spinnerBusy: false, piWorking: false, topLine: undefined, spinnerKnown: true }), "bottom");
	assert.equal(
		voiceRow({ spinnerBusy: false, piWorking: false, topLine: plain, spinnerKnown: false }),
		"bottom",
		"a spinner without the handshake would draw its summary over the row",
	);
});
