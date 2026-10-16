/** Where a reply's live thinking shows: in the transcript, under it in the phase spinner's tail, or nowhere. */
import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { livePlace, liveTailShown } from "../lib/tool-display/live-thinking.ts";
import { installThinkingTail, markAside, type ThinkingHost, type ThinkingMode } from "../lib/tool-display/thinking.ts";

initTheme("dark");

const LIVE = Array.from({ length: 8 }, (_, index) => `step ${index + 1} of the plan`).join("\n\n");
const live = (text = LIVE) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] }) as never;
const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).replace(/\u00a0/g, " ").trim()).filter((line) => line !== "");

function host(over: Partial<ThinkingHost> = {}): ThinkingHost {
	return { mode: () => "tail", hiddenAtStart: () => true, theme: () => undefined, gutter: () => true, summary: () => "∴ Thought for 1.0s", ...over };
}

function streaming(hide = true): AssistantMessageComponent {
	const reply = new AssistantMessageComponent(undefined, hide);
	reply.updateContent(live(), true);
	return reply;
}

const click = (reply: AssistantMessageComponent) =>
	reply.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 60, height: 20 } as never);

test("the live thinking has one place: open fold group, the spinner's tail, or none", () => {
	const place = (folded: boolean, open: boolean, mode: ThinkingMode, toggled: boolean) => livePlace({ folded, open, mode, toggled });
	for (const mode of ["tail", "collapsed", "full"] as const) {
		assert.equal(place(true, true, mode, false), "inline", "an open group shows it");
		assert.equal(place(true, true, mode, true), "inline");
		assert.equal(place(true, false, mode, false), "none", "a closed group: only its line");
		assert.equal(place(true, false, mode, true), "tail", "a closed group after ctrl+t: the tail, as unfolded");
	}
	assert.equal(place(false, false, "tail", false), "tail");
	assert.equal(place(false, false, "full", true), "tail");
	assert.equal(place(false, false, "collapsed", false), "none", "collapsed: no live view");
	assert.equal(place(false, false, "collapsed", true), "tail", "until ctrl+t");
	assert.equal(livePlace({ folded: false, open: false, mode: "collapsed", toggled: false, aside: true }), "inline", "no spinner draws an aside reply's tail");
});

test("the phase spinner draws the tail by the same rule, from what Tool Display publishes", () => {
	assert.equal(liveTailShown({ hidesLiveThinking: true, folds: false, thinking: "tail" }), true);
	assert.equal(liveTailShown({ hidesLiveThinking: false, folds: false, thinking: "tail" }), false, "Pi draws thinking itself");
	assert.equal(liveTailShown({ hidesLiveThinking: true, folds: true, thinking: "tail" }), false);
	assert.equal(liveTailShown({ hidesLiveThinking: true, folds: true, thinking: "tail", thinkingToggled: true }), true);
	assert.equal(liveTailShown({ hidesLiveThinking: true, folds: true, thinking: "tail", thinkingToggled: true, liveOpen: true }), false, "the open group shows it");
	assert.equal(liveTailShown({ hidesLiveThinking: true, folds: false, thinking: "collapsed", thinkingToggled: true }), true);
});

test("in an open fold group the live thinking shows as its tail, and a click or ctrl+t shows it in full", () => {
	let mode: ThinkingMode = "tail";
	const undo = installThinkingTail(host({ mode: () => mode, opens: () => true }));
	try {
		const reply = streaming();
		const tail = plain(reply.render(60));
		assert.equal(tail.length, 3, "the newest three lines");
		assert.match(tail.at(-1)!, /step 8 of the plan$/);
		click(reply);
		assert.equal(plain(reply.render(60)).length, 8, "a click: every step");
		click(reply);
		reply.setHideThinkingBlock(false);
		assert.equal(plain(reply.render(60)).length, 8, "ctrl+t: every step");
		reply.setHideThinkingBlock(true);
		mode = "full";
		reply.updateContent(live(), true);
		assert.equal(plain(reply.render(60)).length, 8, "full rests in full");
		mode = "collapsed";
		reply.updateContent(live(), true);
		assert.equal(plain(reply.render(60)).length, 3, "collapsed has no live label; it shows the tail");
	} finally {
		undo();
	}
});

test("outside an open group the live thinking stays out of the transcript", () => {
	for (const over of [{}, { folds: () => true }, { opens: () => false }] as Partial<ThinkingHost>[]) {
		const undo = installThinkingTail(host(over));
		try {
			const reply = streaming();
			assert.deepEqual(plain(reply.render(60)), []);
			reply.setHideThinkingBlock(false);
			assert.deepEqual(plain(reply.render(60)), [], "ctrl+t moves it to the spinner's tail, not here");
		} finally {
			undo();
		}
	}
});

test("Tool Display hears Pi's hide-thinking setting from each reply it builds and from ctrl+t", () => {
	const heard: boolean[] = [];
	const undo = installThinkingTail(host({ hidden: (hide) => { heard.push(hide); } }));
	try {
		const reply = streaming(true);
		assert.equal(heard.at(-1), true);
		reply.setHideThinkingBlock(false);
		assert.equal(heard.at(-1), false);
		const aside = new AssistantMessageComponent(undefined, true);
		markAside(aside);
		aside.updateContent(live(), true);
		assert.equal(heard.at(-1), false, "a reply drawn outside Pi's transcript keeps the setting it was made with");
	} finally {
		undo();
	}
});

test("a reply drawn outside Pi's transcript shows its live thinking itself, as no spinner draws it there", () => {
	const undo = installThinkingTail(host());
	try {
		const reply = new AssistantMessageComponent(undefined, true);
		markAside(reply);
		reply.updateContent(live(), true);
		assert.equal(plain(reply.render(60)).length, 3, "the tail");
		reply.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: LIVE }, { type: "text", text: "Done." }] } as never, false);
		assert.deepEqual(plain(reply.render(60)), ["∴ Thought for 1.0s", "● Done."], "once done, the label as in Pi's transcript");
	} finally {
		undo();
	}
});

test("an empty thinking block at the end does not make the reply's finished thinking live", () => {
	const undo = installThinkingTail(host());
	try {
		const reply = new AssistantMessageComponent(undefined, true);
		reply.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "Plan." }, { type: "text", text: "Said." }, { type: "thinking", thinking: "" }] } as never, true);
		assert.deepEqual(plain(reply.render(60)), ["∴ Thought for 1.0s", "● Said."]);
	} finally {
		undo();
	}
});
