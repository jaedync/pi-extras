import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { agentRoot } from './support/pi-runtime.mjs';
const { createJiti } = createRequire(join(agentRoot, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		"../lib/extras-config.ts": fileURLToPath(new URL("./fixtures/phase-config.mjs", import.meta.url)),
		[fileURLToPath(new URL("../lib/extras-config.ts", import.meta.url))]: fileURLToPath(new URL("./fixtures/phase-config.mjs", import.meta.url)),
		"@earendil-works/pi-coding-agent": fileURLToPath(new URL("./fixtures/phase-editor-api.mjs", import.meta.url)),
		"@earendil-works/pi-tui": createRequire(join(agentRoot, "package.json")).resolve("@earendil-works/pi-tui"),
	},
});
const phaseSpinner = await jiti.import("../extensions/phase-spinner.ts", { default: true });
const { TopBorderLink } = await jiti.import("../lib/top-border.ts");
const { MODE_SPINNERS, REDUCED_FRAME, SPINNER_FRAMES, slotGlyph } = await jiti.import("../lib/band/glyph.ts");
const { DISPLAY_SETTINGS_EVENT } = await jiti.import("../lib/extras-config.ts");
const { foregroundAnsi } = await jiti.import("@earendil-works/pi-tui");
const { renderPiWave } = await jiti.import("../lib/cc-phase.ts");
const waveGlyph = renderPiWave(200, { fg: (_tone, text) => text });
function assertNoWave(h, at, expected) {
	const row = h.render(at)[0];
	assert.ok(!row.startsWith(`─ ${waveGlyph} `), "no PI_WAVE glyph in the divider");
	assert.match(row, expected);
}

/** Pi's interactive layout: transcript, queued messages, status, widgets, editor, widgets, footer. */
function piLayout() {
	const box = () => ({ children: [], lines: [], render() { return [...this.lines]; } });
	const children = Array.from({ length: 7 }, box);
	return { children, queue: children[1], editorBox: children[4] };
}

const {setVerbs}=await import("./fixtures/phase-config.mjs");
function harness(t, events, { layout, nativeStatus = false, theme, verbs = "playful" } = {}) {
 setVerbs(verbs);
	let now = 0;
	let idle = false;
	let pending = false;
	t.mock.method(performance, "now", () => now);
	const handlers = new Map();
	const entries = [];
	phaseSpinner({ on: (name, handler) => handlers.set(name, handler), events, registerEntryRenderer() {}, appendEntry: (type, data) => entries.push({type, data}) });
	const forwarded = [];
	const indicators = [];
	let shown;
	// Pi's own editor draws the status it is given in its top border.
	const base = {
		render: width => [nativeStatus && shown ? `─ ${shown.renderInBorder()} ─` : "─".repeat(width), "input"], getText: () => "", invalidate() {},
		setWorkingStatusIndicator: indicator => { forwarded.push(indicator); shown = indicator; },
	};
	let factory = () => base;
	const ctx = {
		mode: "tui",
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: value => { factory = value; },
			setWorkingIndicator: options => indicators.push(options),
			theme: theme ?? { fg: (_tone, text) => text },
		},
	};
	const emit = (name, event = {}, at = now) => { now = at; if(name==="agent_start")idle=false; handlers.get(name)(event, ctx); };
	emit("session_start");
	let renders = 0;
	const requestRender = () => { renders++; };
	const tui = layout ? { requestRender, children: layout.children } : { requestRender };
	const editor = factory(tui, { borderColor: text => text }, {});
	layout?.editorBox.children.push(editor);
	t.after(() => emit("session_shutdown"));
	const update = (kind, delta, at) => emit("message_update", {
		assistantMessageEvent: { type: kind, delta }, message: { role: "assistant", content: [] },
	}, at);
	const finish = (output, at) => emit("message_end", {
		message: { role: "assistant", usage: { output }, stopReason: "stop" },
	}, at);
	// Pi clears the embedded indicator before showing each replacement.
	const show = (indicator, at = now) => {
		now = at;
		editor.setWorkingStatusIndicator(undefined);
		if (indicator) editor.setWorkingStatusIndicator(indicator);
	};
	return {
		emit, update, finish, show, forwarded, indicators, entries,
		escape: () => editor.decoration.onEscape(),
		setIdle: value => { idle = value; }, setPending: value => { pending = value; },
		get renders() { return renders; },
		advance: (at, ms) => { now = at; t.mock.timers.tick(ms); },
		render: (at = now) => { now = at; return editor.render(120); },
  renderAtWidth: (width,at=now)=>{now=at;return editor.render(width);},
		queue: (at = now) => { now = at; return layout.queue.render(120); },
		settle: () => { idle = true; emit("agent_settled"); },
	};
}

test("live status stays in the divider while only thinking tail precedes the queue",t=>{
 const events=eventBus(),layout=piLayout(),h=harness(t,events,{layout,verbs:null});h.render();h.emit("agent_start");
 h.emit("before_provider_request",{},1000);layout.queue.lines=QUEUED;
 assert.deepEqual(h.queue(),QUEUED);assert.match(h.render()[0],/Sending request… 00:00\.0 ↑/);
 events.emit(DISPLAY_SETTINGS_EVENT,{hidesLiveThinking:true});h.update("thinking_delta","thought ".repeat(200)+"newest",2000);
 const queue=h.queue();assert.deepEqual(queue.slice(-QUEUED.length),QUEUED);assert.ok(queue.some(line=>line.includes("newest")));
 assert.ok(!queue.some(line=>line.includes("… (")),"no phase caption in the transcript area");
 for(const width of [80,130]){const row=h.renderAtWidth(width,15000)[0];assert.match(row,/Still thinking…/);assert.equal((row.match(/Time /g)??[]).length,1);assert.ok(!/\(\d+s/.test(row));}
});

test("the step stopwatch resets at phase/call/tool-title boundaries, not thinking wordings", t => {
	const h = harness(t, eventBus(), { layout: piLayout(), verbs: null });
	h.render(); h.emit("agent_start");
	h.emit("before_provider_request", {}, 100);
	assert.match(h.render(1300)[0], /Sending request… 00:01\.2/);
	h.emit("after_provider_response", { status: 200 }, 1500);
	h.emit("message_start", { message: { role: "assistant" } }, 1700);
	assert.match(h.render(1900)[0], /Waiting for the model… 00:00\.4/);
	h.update("thinking_delta", "first", 2000);
	assert.match(h.render(3400)[0], /Thinking… 00:01\.4/);
	h.update("thinking_delta", "more", 16000);
	assert.match(h.render(17000)[0], /Still thinking… 00:15\.0/);
	assert.match(h.render(48000)[0], /Deep in thought… 00:46\.0/);
	h.update("text_delta", "reply", 50000);
	assert.match(h.render(51200)[0], /Writing reply… 00:01\.2/);
	const call = (type, name, at) => h.emit("message_update", {
		assistantMessageEvent: { type, delta: "{}" }, message: { role: "assistant", content: [{ type: "toolCall", name }] },
	}, at);
	call("toolcall_start", "bash", 52000); call("toolcall_delta", "bash", 52300);
	assert.match(h.render(52600)[0], /Writing bash call… 00:00\.6/);
	call("toolcall_start", "bash", 53000);
	assert.match(h.render(53200)[0], /Writing bash call… 00:00\.2/);
	h.emit("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "{}" }, message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "docs/main.md" } }] } }, 53300);
	assert.match(h.render(53400)[0], /Writing main\.md… /);
	h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" }, 54000);
	assert.match(h.render(56000)[0], /Running bash… 00:02\.0/);
	h.emit("tool_execution_start", { toolCallId: "b", toolName: "read" }, 57000);
	assert.match(h.render(57100)[0], /Running 2 tools… 00:00\.1/);
	h.emit("tool_execution_end", { toolCallId: "a", toolName: "bash" }, 58000);
	h.emit("tool_execution_update", {}, 58500);
	assert.match(h.render(59000)[0], /Running read… 00:01\.0/);
	h.emit("before_provider_request", {}, 60000);
	h.emit("before_provider_request", {}, 62000);
	assert.match(h.render(62300)[0], /Sending request… 00:00\.3/);
});

test("a numeric tool name cannot alias a parallel-tool count in the step clock", t => {
	const h = harness(t, eventBus(), { verbs: null });
	h.emit("agent_start");
	h.emit("tool_execution_start", { toolCallId: "a", toolName: "2" }, 1000);
	assert.match(h.render(2000)[0], /Running 2… 00:01\.0/);
	h.emit("tool_execution_start", { toolCallId: "b", toolName: "read" }, 3000);
	assert.match(h.render(3200)[0], /Running 2 tools… 00:00\.2/);
});

test("Pi status clocks start with the event, while native retry countdowns need no extra clock", async t => {
	const h = harness(t);
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 1000);
	assert.match(h.render(12400)[0], /Compacting context 00:11\.4 Esc cancel/);
	assert.doesNotMatch(h.render()[0], /Time /);
	h.show(undefined); await Promise.resolve();
	h.show(indicator("branchSummary", "Summarizing branch..."), 13000);
	assert.match(h.render(13200)[0], /Summarizing branch 00:00\.2/);
	h.show(indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)"), 14000);
	const countdown = h.render(15000)[0];
	assert.match(countdown, /Retrying \(1\/3\) in 4s Esc cancel/);
	assert.equal((countdown.match(/\d\d:\d\d\.\d/g) ?? []).length, 0, "idle retries already have their countdown");
	h.show(indicator("retry", "Retrying (2/3)..."), 16000);
	assert.match(h.render(16200)[0], /Retrying \(2\/3\) 00:02\.2/);
});

test("a compaction label mentioning in Ns cannot suppress its step clock", t => {
	const h=harness(t);
	h.show(indicator("compaction","Compacting in 4s..."),1000);
	assert.match(h.render(1500)[0],/Compacting in 4s 00:00\.5/);
	assert.doesNotMatch(h.render()[0],/Time /);
});

test("unset verbs selects descriptive phases and worked-for metadata",t=>{
 const layout=piLayout(),h=harness(t,eventBus(),{layout,verbs:null});h.render();h.emit("agent_start");
 h.emit("before_provider_request",{},1000);assert.match(h.render()[0],/Sending request… 00:00\.0 ↑/);
 h.finish(20,41000);h.emit("agent_end");h.settle();
 assert.equal(h.entries[0].data.past,undefined);assert.equal(h.entries[0].data.elapsedMs,41000);
});

test("real extension wires stream timing to the live and retained editor border", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("turn_start");
	h.emit("before_provider_request", {}, 100);
	h.emit("after_provider_response", { status: 200 }, 300);
	h.emit("message_start", { message: { role: "assistant" } }, 400);
	h.update("text_start", undefined, 500);
	h.update("thinking_delta", "thinking", 900);
	h.update("text_delta", "answer", 2900);
	h.finish(100, 5000);
	assert.match(h.render()[0], /TPS 20\.4 ─ TTFT 0\.8s ─ Time 00:05\.0/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	assert.equal(h.render()[1], "input");
	h.setPending(true);
	h.emit("agent_end");
	h.emit("agent_settled"); // Not idle yet: queued work/retry must keep the span.
	h.emit("agent_start", {}, 10000);
	h.setPending(false);
	h.emit("before_provider_request", {}, 11000);
	h.update("toolcall_delta", "{}", 13400);
	h.update("text_delta", "next", 14400);
	h.finish(100, 15000);
	assert.match(h.render()[0], /TPS 22\.5 ─ TTFT 0\.8–2\.4s ─ Time 00:15\.0/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	h.settle();
	h.emit("input");
	assert.match(h.render()[0], /TPS 22\.5 ─ TTFT 0\.8–2\.4s ─ Last 00:15\.0/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	h.emit("agent_start", {}, 20000);
	assert.match(h.render()[0], /Time 00:00\.0/);
	assert.doesNotMatch(h.render()[0], /TTFT|Decode|TPS|•/);
});

test("TPS follows the stream while it flows, then the prompt's average, which the end line keeps", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("turn_start");
	h.emit("before_provider_request", {}, 0);
	for (let at = 1000; at <= 3000; at += 20) h.update("text_delta", "x".repeat(12), at);
	assert.match(h.render(3000)[0], /TPS 150\.0 ─ TTFT 1\.0s/, "the latest second: 12 characters every 20 ms");
	for (let at = 3100; at <= 4000; at += 100) h.update("text_delta", "x".repeat(12), at);
	assert.match(h.render(4000)[0], /TPS {2}30\.0 ─ TTFT/, "it falls as soon as the stream slows");
	assert.doesNotMatch(h.render(5100)[0], /TPS/, "after a silent second it shows the average, and there is none yet");
	h.finish(600, 5200);
	assert.match(h.render(5200)[0], /TPS 115\.4 ─ TTFT/, "600 tokens over the 5.2 s request");
	h.settle();
	assert.ok(Math.abs(h.entries.at(-1).data.tps - 600 / 5.2) < 1e-9, "the end line keeps the average");
});

test("a tool call whose arguments the provider holds stays calm, and turns red once its arguments stop", t => {
	const red = "\x1b[31m", h = harness(t, undefined, { verbs: [], theme: { fg: (tone, text) => (tone === "error" ? red : "") + text } });
	h.emit("agent_start");
	h.emit("turn_start");
	h.emit("before_provider_request", {}, 0);
	h.update("text_delta", "I'll start a reviewer.", 1000);
	h.update("toolcall_start", undefined, 1200);
	assert.ok(!h.render(31000)[0].includes(red), "30 s with a started call and no arguments is not a stall");
	h.update("toolcall_delta", "{\"name\":\"range", 31500);
	assert.ok(h.render(42000)[0].includes(red), "arguments that stop for 10 s are a stall again");
});

test("Pi's working loader is held still only once this row covers it, and moves again after the run", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("turn_start");
	assert.deepEqual(h.indicators, [], "nothing covers the loader yet");
	h.render();
	h.emit("before_provider_request", {}, 100);
	assert.deepEqual(h.indicators, [{ frames: [REDUCED_FRAME] }]);
	h.update("text_delta", "answer", 900);
	h.render();
	h.emit("message_start", { message: { role: "assistant" } }, 1000);
	assert.equal(h.indicators.length, 1, "held once per run");
	h.settle();
	assert.deepEqual(h.indicators, [{ frames: [REDUCED_FRAME] }, undefined]);
});

test("reload clears retained timing and tool messages cannot finalize a model sample", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("before_provider_request", {}, 100);
	h.update("text_delta", "first", 200);
	h.emit("message_end", { message: { role: "toolResult", usage: { output: 999 } } }, 500);
	h.update("text_delta", "last", 1200);
	h.finish(40, 3000);
	h.settle();
	h.emit("input");
	assert.match(h.render()[0], /TPS 13\.8 ─ TTFT 0\.1s ─ Last/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	h.emit("session_start");
	assert.doesNotMatch(h.render()[0], /TTFT|Decode|TPS|Last|Time/);
});

// Pi's indicator paints its own spinner; only its words should reach the border.
function indicator(kind, message) {
	return {
		kind,
		setMessage(next) { message = next; },
		renderInBorder: () => `\x1b[36m⠋\x1b[39m \x1b[2m${message}\x1b[22m`,
		renderSpinnerInBorder: () => "\x1b[36m⠋\x1b[39m",
		dispose() {},
	};
}

const COMPACT_FRAMES = /\S/;
const RETRY_FRAMES = /\S/;

test("compaction replaces the phase slot with its own spinner, timer, and Pi's label", async t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("context", {}, 1000);
	h.show(indicator("compaction", "Auto-compacting... (Esc to cancel)"), 2000);
	const line = h.render(9300)[0];
	assert.match(line, /Auto-compacting 00:07\.3 Esc cancel /);
	assert.match(line, /Time 00:09\.3 ─$/);
	assert.match(line.slice(0, 3), COMPACT_FRAMES);
	assert.doesNotMatch(line, /⠋|Prep|\.\.\./);
	h.show(undefined, 9400);
	await Promise.resolve();
	assert.match(h.render()[0], /…/);
});

test("retry keeps one event timer across attempts and yields to live request phases", async t => {
	const h = harness(t);
	h.emit("agent_start");
	const first = indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)");
	h.show(first, 1000);
	first.setMessage("Retrying (1/3) in 2s... (Esc to cancel)");
	let line = h.render(3000)[0];
	assert.match(line, /Retrying \(1\/3\) in 2s Esc cancel /);
	assert.match(line.slice(0, 3), RETRY_FRAMES);
	h.emit("before_provider_request", {}, 5000);
	assert.match(h.render(5500)[0], /… sending request 00:00\.5 ↑ /);
	h.show(indicator("retry", "Retrying (2/3) in 8s... (Esc to cancel)"), 8000);
	await Promise.resolve();
	assert.match(h.render(9000)[0], /Retrying \(2\/3\) in 8s /);
	h.show(undefined, 9500);
	await Promise.resolve();
	h.show(indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)"), 20000);
	assert.match(h.render(20000)[0], /Retrying \(1\/3\)/);
});

test("manual compaction shows while idle and the working indicator stays hidden", t => {
	const h = harness(t);
	const working = indicator("working", "Working...");
	h.show(working, 0);
	assert.doesNotMatch(h.render()[0], /Working/);
	const compaction = indicator("compaction", "Compacting context... (Esc to cancel)");
	h.show(compaction, 100);
	assert.match(h.render(1600)[0], /Compacting context 00:01\.5 Esc cancel/);
	assert.doesNotMatch(h.render()[0], /Time /);
	assert.equal(h.forwarded.at(-1), compaction);
});

function eventBus() {
	const handlers = new Map();
	return {
		emit: (channel, data) => { for (const handler of handlers.get(channel) ?? []) handler(data); },
		on: (channel, handler) => {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
}

test("a recording borrows the idle top row, but live runs and statuses keep it", async t => {
	const events = eventBus();
	const voice = new TopBorderLink(events, "voice", () => {});
	voice.set(true); // Already recording when the session starts: the spinner's hello must learn it.
	const h = harness(t, events);
	assert.equal(voice.peerActive, false);
	h.emit("agent_start");
	assert.equal(voice.peerActive, true, "a run is busy");
	assert.match(h.render()[0], /Time 00:00\.0/, "the live run keeps the row");
	h.finish(10, 1000);
	h.settle();
	h.emit("input");
	assert.equal(voice.peerActive, false);
	assert.equal(h.render()[0], "─".repeat(120), "the last-run summary steps aside");
	voice.set(false);
	assert.match(h.render()[0], /Last 00:01\.0/, "and comes back afterwards");
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 2000);
	assert.equal(voice.peerActive, true, "an idle status is busy too");
	h.show(undefined, 3000);
	assert.equal(voice.peerActive, true, "Pi clears before each replacement, so a clear waits a tick");
	await Promise.resolve();
	assert.equal(voice.peerActive, false);
});

const QUEUED = ["", " Steering: check the logs", " ↳ Alt+Up to edit all queued messages"];

function laidOut(t, events) {
	const layout = piLayout();
	const h = harness(t, events, { layout });
	h.render(); // Pi draws the editor once it is mounted, and the line finds its place then.
	return { h, layout };
}

test("the divider owns the phase and timer while queued messages remain untouched", t => {
	const { h, layout } = laidOut(t);
	h.emit("agent_start");
	h.emit("turn_start");
	h.emit("before_provider_request", {}, 100);
	layout.queue.lines = QUEUED;
	const top = h.render(1600)[0];
	assert.match(top,/… sending request 00:01\.5 ↑ .*Time 00:01\.6 ─$/);
	assert.deepEqual(h.queue(1600),QUEUED);
});

test("the divider names the step, times it separately from the run, and preserves native tools", t => {
	const { h } = laidOut(t);
	h.emit("agent_start");
	h.emit("message_start", { message: { role: "assistant" } }, 100);
	assert.match(h.render(125_100)[0], /… waiting for first token/);
	h.update("thinking_delta", "hm", 125_200);
	assert.match(h.render(126_200)[0], /… thinking 00:01\.0 ↓ \d+ tokens?/);
	h.update("text_delta", "ok", 126_300);
	assert.doesNotMatch(h.render()[0], /thought for 1s/);
	h.emit("message_update", {
		assistantMessageEvent: { type: "toolcall_delta", delta: "{}" },
		message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
	}, 126_400);
	assert.match(h.render()[0], /writing bash call/);
	h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" }, 127_000);
	h.emit("tool_execution_start", { toolCallId: "b", toolName: "bash" }, 127_000);
	assert.match(h.render(129_900)[0], /… running 2 tools/);
});

test("changing Tool Display motion makes the spinner static immediately", t => {
	const events = eventBus(), layout = piLayout();
	const h = harness(t, events, { layout });
	h.render(); h.emit("agent_start");
	events.emit(DISPLAY_SETTINGS_EVENT, { motion: "reduced" });
	assert.ok(h.render(300)[0].startsWith("─ "+slotGlyph(MODE_SPINNERS.prep,0,{reduced:true}) + " "));
	assert.equal(h.render(300)[0].split("…")[0], h.render(800)[0].split("…")[0]);
 assert.match(h.render(800)[0],/00:00\.8/);
});

for (const continuation of ["retry", "overflow recovery", "queued follow-up"]) test(`${continuation} retains one verb and one settled end line per prompt`, t => {
	t.mock.method(Math, "random", () => 0);
	const { h } = laidOut(t);
	h.emit("agent_start");
	const word = h.render()[0].match(/^─ .{3} (.*?)…/)[1];
	h.update("text_delta", "answer", 500);
	h.emit("agent_end", {}, 1500);
	h.emit("agent_settled", {}, 1600);
	assert.equal(h.entries.length, 0, "not idle while continuation is pending");
	t.mock.method(Math, "random", () => .5);
	h.emit("agent_start", {}, 5000);
	assert.ok(h.render()[0].includes(word + "…"));
	h.emit("agent_end", {}, 7000);
	h.settle(); h.settle();
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.elapsedMs, 7000);
	assert.deepEqual(h.queue(7760), []);
	h.emit("agent_start", {}, 10000);
	h.emit("agent_end", {}, 12000);
	h.settle();
	assert.equal(h.entries[1].data.elapsedMs, 2000);
});

test("full motion sends faster than preparation and skips unchanged frames", t => {
	t.mock.timers.enable({apis:["setInterval"]});
	const events=eventBus();
	const color={kind:"rgb",r:80,g:100,b:180};
	const theme={fg:(_key,text)=>text,colors:{accent:color,text:{kind:"rgb",r:240,g:240,b:240}},style:(text,options)=>foregroundAnsi(options.fg,"truecolor")+text+"\x1b[0m"};
	const h=harness(t,events,{layout:piLayout(),theme});
	events.emit(DISPLAY_SETTINGS_EVENT,{motion:"full"});h.render();h.emit("agent_start");
	const prepared=h.renders;
	h.advance(40,40);assert.equal(h.renders,prepared,"preparation does not poll at sending cadence");
	h.advance(80,40);assert.equal(h.renders,prepared,"unchanged glyph and clocks do not redraw");
	h.advance(160,80);assert.ok(h.renders>prepared,"the preparation clock advances");
	h.emit("before_provider_request",{},200);const sending=h.renders;
	h.advance(250,50);assert.ok(h.renders>sending,"the sending shimmer uses fast frames");
	const unchanged=h.renders;h.advance(250,80);assert.equal(h.renders,unchanged);
});

test("reduced motion keeps tenths ticking at about ten redraws per second and none while idle", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const events = eventBus(), h = harness(t, events, { layout: piLayout(), verbs: null });
	h.render(); h.emit("agent_start");
	events.emit(DISPLAY_SETTINGS_EVENT, { motion: "reduced" });
	const before = h.renders, glyph = h.render()[0].slice(0, 5);
	h.advance(80, 80);
	assert.equal(h.renders, before, "neither visible clock changed within its first tenth");
	for (let at = 160; at <= 1040; at += 80) h.advance(at, 80);
	assert.equal(h.renders - before, 10);
	assert.ok(h.render()[0].startsWith(glyph), "the spinner holds still");
	assert.match(h.render()[0], /Preparing… 00:01\.0/);
	h.finish(1, 1040); h.emit("agent_end"); h.settle();
	const idle = h.renders;
	h.advance(2040, 1000);
	assert.equal(h.renders, idle);
});

test("a failed frame cannot strand a sign-off wave or the voice border",t=>{
 t.mock.timers.enable({apis:["setInterval"]});const events=eventBus(),voice=new TopBorderLink(events,"voice",()=>{});
 let fail=false;const theme={fg:(_key,text)=>{if(fail){fail=false;throw new Error("transient");}return text;}};
 const h=harness(t,events,{layout:piLayout(),theme});events.emit(DISPLAY_SETTINGS_EVENT,{motion:"full"});h.render();h.emit("agent_start");h.emit("agent_end",{},1000);h.settle();
 fail=true;h.advance(1040,40);h.advance(1760,720);assert.deepEqual(h.queue(),[]);assert.equal(voice.peerActive,false);voice.dispose();
});
test("a status cancels sign-off immediately and reduced preparation keeps its border clock moving",t=>{
 t.mock.timers.enable({apis:["setInterval"]});const events=eventBus(),h=harness(t,events,{layout:piLayout()});
 events.emit(DISPLAY_SETTINGS_EVENT,{motion:"full"});h.render();h.emit("agent_start");h.emit("agent_end",{},1000);h.settle();
 h.show(indicator("compaction","Compacting context..."),1100);assert.match(h.render()[0],/Compacting context/);
 h.show(undefined);h.emit("agent_start",{},2000);events.emit(DISPLAY_SETTINGS_EVENT,{motion:"reduced"});const before=h.renders;
 h.advance(3000,1000);assert.ok(h.renders>before);assert.match(h.render()[0],/Time 00:01\.0/);
});
test("idle input closes a delayed prior prompt, busy steering does not, and extension runs start fresh",t=>{
 const {h}=laidOut(t);t.mock.method(Math,"random",()=>0);h.emit("agent_start");const first=h.render()[0];
 h.emit("input",{},500);assert.equal(h.entries.length,0);h.finish(10,1000);h.emit("agent_end");h.setIdle(true);
 h.emit("input",{},1200);assert.equal(h.entries.length,1);t.mock.method(Math,"random",()=>.5);h.emit("agent_start",{},1300);assert.notEqual(h.render()[0],first);
 h.finish(5,2000);h.emit("agent_end");h.emit("agent_before_settle");h.setIdle(true);h.emit("before_agent_start");h.emit("agent_start",{},2100);assert.equal(h.entries.length,2,"an extension run without input closes the prior finished prompt");
});
test("known retry, overflow and queued continuations retain one prompt identity",t=>{
 for(const reason of ["retry","overflow","queued","boundary","length"]){

  const {h}=laidOut(t);h.emit("agent_start");const word=h.render()[0].match(/^─ .{3} (.*?)…/)[1];
  if(reason==="queued")h.setPending(true);
  h.emit("message_end",{message:{role:"assistant",stopReason:reason==="queued"||reason==="boundary"?"stop":reason==="length"?"length":"error",usage:{output:1}}},1000);h.emit("agent_end");
  if(reason==="boundary")h.emit("agent_before_settle");
  h.emit("agent_start",{},2000);assert.equal(h.entries.length,0);assert.ok(h.render()[0].includes(word+"…"));
  h.setPending(false);h.finish(1,3000);h.emit("agent_end");h.settle();assert.equal(h.entries.length,1);
 }
});
for (const reason of ["aborted", "stopped"]) test(`${reason} prompts finish without a divider wave`, t => {
	const { h } = laidOut(t);
	h.emit("agent_start");
	if (reason === "stopped") h.escape();
	h.emit("message_end", { message: { role: "assistant", stopReason: reason === "aborted" ? "aborted" : "stop", usage: { output: 0 } } }, 1200);
	h.emit("agent_end");
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.stopped, true);
	assertNoWave(h, 1400, /Last 00:01\.2/);
	h.settle();
	assert.equal(h.entries.length, 1);
	assertNoWave(h, 1500, /Last 00:01\.2/);
});
test("Escape during a retry countdown persists stopped metadata without a wave",t=>{
 const {h}=laidOut(t);h.emit("agent_start");
 h.emit("message_end",{message:{role:"assistant",stopReason:"error",usage:{output:0}}},1200);h.emit("agent_end");
 h.show(indicator("retry","Retrying (1/3) in 4s... (Esc to cancel)"),1500);
 h.escape();h.show(undefined);h.settle();
 assert.equal(h.entries.length,1);assert.equal(h.entries[0].data.stopped,true);
 assertNoWave(h, 1700, /Last 00:01\.5/);
});
test("overflow compaction before settlement protects the prompt identity",t=>{
 const {h}=laidOut(t);t.mock.method(Math,"random",()=>0);h.emit("agent_start");const word=h.render()[0].match(/^─ .{3} (.*?)…/)[1];
 h.finish(1,1000);h.emit("agent_end");h.emit("session_before_compact",{reason:"overflow"},1100);
 t.mock.method(Math,"random",()=>.5);h.emit("agent_start",{},2000);
 assert.equal(h.entries.length,0);assert.ok(h.render()[0].includes(word+"…"));
 h.finish(1,3000);h.emit("agent_end");h.settle();assert.equal(h.entries.length,1);assert.equal(h.entries[0].data.elapsedMs,3000);
});

test("a normal prompt plays PI_WAVE in the divider, then restores Last after 760ms", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { h } = laidOut(t);
	h.emit("agent_start");
	h.finish(1, 1000);
	h.emit("agent_end");
	h.settle();
	assert.ok(h.render(1200)[0].startsWith(`─ ${waveGlyph} `));
	assert.doesNotMatch(h.render()[0], /Last/);
	h.advance(1760, 760);
	assertNoWave(h, 1760, /Last 00:01\.0/);
});
for (const interrupt of ["input", "status", "agent_start", "reduced motion"]) test(`${interrupt} cancels PI_WAVE in the divider immediately`, t => {
	const events = eventBus();
	const h = harness(t, events, { layout: piLayout(), verbs: null });
	h.render();
	h.emit("agent_start");
	h.finish(1, 1000);
	h.emit("agent_end");
	h.settle();
	assert.ok(h.render(1200)[0].startsWith(`─ ${waveGlyph} `), "the wave exists before interruption");
	if (interrupt === "status") h.show(indicator("compaction", "Compacting context..."), 1200);
	else if (interrupt === "reduced motion") events.emit(DISPLAY_SETTINGS_EVENT, { motion: "reduced" });
	else h.emit(interrupt, {}, 1200);
	assertNoWave(h, 1200, interrupt === "status" ? /Compacting context/ : interrupt === "agent_start" ? /Preparing…/ : /Last 00:01\.0/);
});
test("reduced motion skips the divider wave when a prompt ends", t => {
	const events = eventBus();
	const h = harness(t, events, { layout: piLayout() });
	h.render();
	events.emit(DISPLAY_SETTINGS_EVENT, { motion: "reduced" });
	h.emit("agent_start");
	h.finish(1, 1000);
	h.emit("agent_end");
	h.settle();
	assertNoWave(h, 1200, /Last 00:01\.0/);
});

test("a stale retry yields both the divider and thinking tail to the live request", t => {
	const events = eventBus();
	const { h } = laidOut(t, events);
	events.emit(DISPLAY_SETTINGS_EVENT, { hidesLiveThinking: true });
	h.emit("agent_start");
	h.show(indicator("retry", "Retrying (1/3) in 4s..."), 1000);
	h.emit("before_provider_request", {}, 1500);
	h.update("thinking_delta", "live thought", 1600);
	assert.match(h.render(1800)[0], /thinking/);
	assert.ok(h.queue().some(line => line.includes("live thought")));
	h.show(indicator("compaction", "Compacting context..."), 1900);
	assert.match(h.render()[0], /Compacting context/);
	assert.deepEqual(h.queue(), [], "an active status still hides live thinking");
});

test("live thinking's newest three lines sit above the queue without a phase caption", t => {
	const events=eventBus();
	const { h, layout } = laidOut(t,events);
	events.emit(DISPLAY_SETTINGS_EVENT,{hidesLiveThinking:true});
	h.emit("agent_start");
	h.update("thinking_delta", "thought ".repeat(200) + "newest", 100);
	layout.queue.lines = QUEUED;
	const lines = h.queue(200);
	assert.match(h.render()[0],/thinking/);
	assert.equal(lines.length,4+QUEUED.length);
	assert.match(lines[1],/^  … /);assert.match(lines[3],/newest$/);
	assert.deepEqual(lines.slice(4),QUEUED);
	h.update("thinking_end",undefined,2100);assert.deepEqual(h.queue(),QUEUED);
});

test("the spinner tail requires a loaded, enabled thinking host and reuses an unchanged tail",t=>{
 const events=eventBus(),layout=piLayout();let paints=0;
 const theme={fg:(_key,text)=>text,italic:text=>{paints++;return text;}};
 const h=harness(t,events,{layout,theme});h.render();h.emit("agent_start");
 h.update("thinking_delta","thought ".repeat(200),100);
 assert.equal(h.queue().length,0,"Tool Display absent: native thinking remains in the transcript");
 events.emit(DISPLAY_SETTINGS_EVENT,{hidesLiveThinking:true});
 assert.equal(h.queue().length,4);
 const cached=paints;h.queue(500);h.queue(700);
 assert.equal(paints,cached,"timer frames reuse the thinking tail");
 events.emit(DISPLAY_SETTINGS_EVENT,{hidesLiveThinking:false});
 assert.equal(h.queue().length,0,"Tool Display off: no duplicate tail");
});

test("an idle agent has no transcript status, and the divider shows the last run", t => {
	const { h, layout } = laidOut(t);
	h.emit("agent_start");
	h.finish(10, 1000);
	h.settle();
	layout.queue.lines = QUEUED;
	assert.deepEqual(h.queue(1760), QUEUED);
	assert.match(h.render(1760)[0], /Last 00:01\.0 ─$/);
});

test("Pi's statuses take the divider, idle or during a run", async t => {
	const { h } = laidOut(t);
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 100);
	assert.match(h.render(1600)[0],/Compacting context 00:01\.5 Esc cancel/);
	assert.doesNotMatch(h.render()[0], /Time /);
	assert.deepEqual(h.queue(),[]);
	h.show(undefined, 1700);
	await Promise.resolve();
	assert.deepEqual(h.queue(), []);
	h.emit("agent_start", {}, 2000);
	h.show(indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)"), 2000);
	assert.match(h.render(3000)[0],/Retrying \(1\/3\) in 4s Esc cancel/);
	assert.match(h.render()[0], /Time 00:01\.0 ─$/);
});

test("ending the session removes the thinking tail and leaves Pi's queue", t => {
	const { h, layout } = laidOut(t);
	h.emit("agent_start");
	layout.queue.lines = QUEUED;
	assert.deepEqual(h.queue(),QUEUED);
	h.emit("session_shutdown");
	assert.deepEqual(h.queue(), QUEUED);
});

test("without Pi's layout the phase stays in the editor border", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("before_provider_request", {}, 100);
	assert.match(h.render(600)[0], /^─ .+… sending request 00:00\.5 ↑ ─+ Time 00:00\.6 ─$/);
});

test("an idle status shows only in the divider, replacing Pi's native status", async t => {
	const layout = piLayout();
	const h = harness(t, undefined, { layout, nativeStatus: true });
	h.render();
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 100);
	assert.match(h.render(1600)[0],/Compacting context/);
	assert.deepEqual(h.queue(),[],"idle statuses only draw in the divider");
	h.show(undefined, 1700);
 await Promise.resolve();
	h.emit("agent_start", {}, 2000);
	h.finish(10, 3000);
	h.settle();
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 4000);
	assert.match(h.render(4500)[0],/Compacting context 00:00\.5/);
	assert.doesNotMatch(h.render()[0], /Time /);
});

test("a status ends when Pi disposes it, even if Pi no longer tells this editor", async t => {
	const { h } = laidOut(t);
	const compaction = indicator("compaction", "Compacting context... (Esc to cancel)");
	let disposed = 0;
	compaction.dispose = () => { disposed++; };
	h.show(compaction, 100);
	assert.match(h.render(600)[0],/Compacting context/);
	// Another extension replaced the editor: Pi hands the status over, then disposes it when compaction ends.
	compaction.dispose();
	await Promise.resolve();
	assert.equal(disposed, 1, "Pi's own dispose still runs");
	assert.deepEqual(h.queue(), []);
});
