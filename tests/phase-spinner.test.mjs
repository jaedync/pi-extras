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
		"@earendil-works/pi-coding-agent": fileURLToPath(new URL("./fixtures/phase-editor-api.mjs", import.meta.url)),
		"@earendil-works/pi-tui": createRequire(join(agentRoot, "package.json")).resolve("@earendil-works/pi-tui"),
	},
});
const phaseSpinner = await jiti.import("../extensions/phase-spinner.ts", { default: true });
const { TopBorderLink } = await jiti.import("../lib/top-border.ts");
const { MODE_SPINNERS, REDUCED_FRAME, SPINNER_FRAMES, slotGlyph } = await jiti.import("../lib/band/glyph.ts");
const { DISPLAY_SETTINGS_EVENT } = await jiti.import("../lib/extras-config.ts");
const { foregroundAnsi } = await jiti.import("@earendil-works/pi-tui");

/** Pi's interactive layout: transcript, queued messages, status, widgets, editor, widgets, footer. */
function piLayout() {
	const box = () => ({ children: [], lines: [], render() { return [...this.lines]; } });
	const children = Array.from({ length: 7 }, box);
	return { children, queue: children[1], editorBox: children[4] };
}

function harness(t, events, { layout, nativeStatus = false, theme } = {}) {
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
		queue: (at = now) => { now = at; return layout.queue.render(120); },
		settle: () => { idle = true; emit("agent_settled"); },
	};
}

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
	assert.match(line, / 00:07\.3 Auto-compacting Esc cancel /);
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
	assert.match(line, / 00:02\.0 Retrying \(1\/3\) in 2s Esc cancel /);
	assert.match(line.slice(0, 3), RETRY_FRAMES);
	h.emit("before_provider_request", {}, 5000);
	assert.match(h.render(5500)[0], /… sending request, 5s, ↑ /);
	h.show(indicator("retry", "Retrying (2/3) in 8s... (Esc to cancel)"), 8000);
	await Promise.resolve();
	assert.match(h.render(9000)[0], / 00:08\.0 Retrying \(2\/3\) in 8s /);
	h.show(undefined, 9500);
	await Promise.resolve();
	h.show(indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)"), 20000);
	assert.match(h.render(20000)[0], / 00:00\.0 Retrying \(1\/3\)/);
});

test("manual compaction shows while idle and the working indicator stays hidden", t => {
	const h = harness(t);
	const working = indicator("working", "Working...");
	h.show(working, 0);
	assert.doesNotMatch(h.render()[0], /Working/);
	const compaction = indicator("compaction", "Compacting context... (Esc to cancel)");
	h.show(compaction, 100);
	assert.match(h.render(1600)[0], / 00:01\.5 Compacting context Esc cancel /);
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

test("the phase line sits right under the transcript, above queued messages, and the border keeps the totals", t => {
	const { h, layout } = laidOut(t);
	h.emit("agent_start");
	h.emit("turn_start");
	h.emit("before_provider_request", {}, 100);
	layout.queue.lines = QUEUED;
	const top = h.render(1600)[0];
	assert.match(top, /^─{60,} Time 00:01\.6 ─$/);
	assert.doesNotMatch(top, /Sending request/);
	const [blank, line, ...rest] = h.queue(1600);
	assert.equal(blank, "");
	assert.ok(SPINNER_FRAMES.some(frame=>line.startsWith(frame+" ")));
	assert.match(line, /… \(sending request, 1s, ↑\)$/);
	assert.deepEqual(rest, QUEUED);
});

test("the phase line names what runs and what the model writes, and says how to abort a stall", t => {
	const { h } = laidOut(t);
	h.emit("agent_start");
	h.emit("message_start", { message: { role: "assistant" } }, 100);
	assert.match(h.queue(125_100)[1], /… \(waiting for first token, 125s\)$/);
	h.update("thinking_delta", "hm", 125_200);
	assert.match(h.queue(126_200)[1], /… \(126s, ↓ \d+ tokens, thinking\)$/);
	h.update("text_delta", "ok", 126_300);
	assert.match(h.queue()[1], /thought for 1s/);
	h.emit("message_update", {
		assistantMessageEvent: { type: "toolcall_delta", delta: "{}" },
		message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
	}, 126_400);
	assert.match(h.queue()[1], /writing bash call/);
	h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" }, 127_000);
	h.emit("tool_execution_start", { toolCallId: "b", toolName: "bash" }, 127_000);
	assert.match(h.queue(129_900)[1], /… \(running 2 tools, 129s\)$/);
});

test("changing Tool Display motion makes the spinner static immediately", t => {
	const events = eventBus(), layout = piLayout();
	const h = harness(t, events, { layout });
	h.render(); h.emit("agent_start");
	events.emit(DISPLAY_SETTINGS_EVENT, { motion: "reduced" });
	assert.ok(h.queue(300)[1].startsWith(slotGlyph(MODE_SPINNERS.prep,0,{reduced:true}) + " "));
	assert.equal(h.queue(300)[1], h.queue(800)[1]);
});

for (const continuation of ["retry", "overflow recovery", "queued follow-up"]) test(`${continuation} retains one verb and one settled end line per prompt`, t => {
	t.mock.method(Math, "random", () => 0);
	const { h } = laidOut(t);
	h.emit("agent_start");
	const word = h.queue()[1].match(/^\S+ (.*?)…/)[1];
	h.update("text_delta", "answer", 500);
	h.emit("agent_end", {}, 1500);
	h.emit("agent_settled", {}, 1600);
	assert.equal(h.entries.length, 0, "not idle while continuation is pending");
	t.mock.method(Math, "random", () => .5);
	h.emit("agent_start", {}, 5000);
	assert.ok(h.queue()[1].includes(word + "…"));
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

test("render requests are skipped for unchanged frames and cadence is fast only while sending", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const events=eventBus(),layout=piLayout();
	const color={kind:"rgb",r:80,g:100,b:180};
	const theme={fg:(_key,text)=>text,colors:{accent:color,text:{kind:"rgb",r:240,g:240,b:240}},style:(text,options)=>foregroundAnsi(options.fg,"truecolor")+text+"\x1b[0m"};
	const h=harness(t,events,{layout,theme});
	events.emit(DISPLAY_SETTINGS_EVENT,{motion:"full"});
	h.render();h.emit("agent_start");
	const before=h.renders;
	h.advance(100,100);assert.equal(h.renders,before,"preparation is capped by Sonar's 130ms frame, not 50ms");
	h.emit("before_provider_request",{},200);
	const sending=h.renders;
	h.advance(250,50);assert.ok(h.renders>sending,"sending uses 50ms");
	events.emit(DISPLAY_SETTINGS_EVENT,{motion:"reduced"});
	h.queue(300);const reduced=h.renders;
	h.advance(250,1000);assert.equal(h.renders,reduced,"an unchanged static row needs no redraw");
 h.advance(600,1000);assert.ok(h.renders>reduced,"the visible border clock still advances");
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
 h.show(indicator("compaction","Compacting context..."),1100);assert.match(h.queue()[1],/Compacting context/);
 h.show(undefined);h.emit("agent_start",{},2000);events.emit(DISPLAY_SETTINGS_EVENT,{motion:"reduced"});const before=h.renders;
 h.advance(3000,1000);assert.ok(h.renders>before);assert.match(h.render()[0],/Time 00:01\.0/);
});
test("idle input closes a delayed prior prompt, busy steering does not, and extension runs start fresh",t=>{
 const {h}=laidOut(t);t.mock.method(Math,"random",()=>0);h.emit("agent_start");const first=h.queue()[1];
 h.emit("input",{},500);assert.equal(h.entries.length,0);h.finish(10,1000);h.emit("agent_end");h.setIdle(true);
 h.emit("input",{},1200);assert.equal(h.entries.length,1);t.mock.method(Math,"random",()=>.5);h.emit("agent_start",{},1300);assert.notEqual(h.queue()[1],first);
 h.finish(5,2000);h.emit("agent_end");h.emit("agent_before_settle");h.setIdle(true);h.emit("before_agent_start");h.emit("agent_start",{},2100);assert.equal(h.entries.length,2,"an extension run without input closes the prior finished prompt");
});
test("known retry, overflow and queued continuations retain one prompt identity",t=>{
 for(const reason of ["retry","overflow","queued","boundary","length"]){

  const {h}=laidOut(t);h.emit("agent_start");const word=h.queue()[1].match(/^\S+ (.*?)…/)[1];
  if(reason==="queued")h.setPending(true);
  h.emit("message_end",{message:{role:"assistant",stopReason:reason==="queued"||reason==="boundary"?"stop":reason==="length"?"length":"error",usage:{output:1}}},1000);h.emit("agent_end");
  if(reason==="boundary")h.emit("agent_before_settle");
  h.emit("agent_start",{},2000);assert.equal(h.entries.length,0);assert.ok(h.queue()[1].includes(word+"…"));
  h.setPending(false);h.finish(1,3000);h.emit("agent_end");h.settle();assert.equal(h.entries.length,1);
 }
});
test("aborted prompts finish at agent_end with one stopped entry even without agent_settled",t=>{
 const {h}=laidOut(t);h.emit("agent_start");h.emit("message_end",{message:{role:"assistant",stopReason:"aborted",usage:{output:0}}},1200);h.emit("agent_end");
 assert.equal(h.entries.length,1);assert.equal(h.entries[0].data.stopped,true);
 assert.deepEqual(h.queue(1250),[],"an aborted prompt never starts a wave");
 h.settle();assert.equal(h.entries.length,1);assert.deepEqual(h.queue(1300),[]);
});
test("Escape during a retry countdown persists stopped metadata without a wave",t=>{
 const {h}=laidOut(t);h.emit("agent_start");
 h.emit("message_end",{message:{role:"assistant",stopReason:"error",usage:{output:0}}},1200);h.emit("agent_end");
 h.show(indicator("retry","Retrying (1/3) in 4s... (Esc to cancel)"),1500);
 h.escape();h.show(undefined);h.settle();
 assert.equal(h.entries.length,1);assert.equal(h.entries[0].data.stopped,true);
 assert.deepEqual(h.queue(1600),[],"retry cancellation never starts a wave");
});
test("overflow compaction before settlement protects the prompt identity",t=>{
 const {h}=laidOut(t);t.mock.method(Math,"random",()=>0);h.emit("agent_start");const word=h.queue()[1].match(/\S+ (.*?)…/)[1];
 h.finish(1,1000);h.emit("agent_end");h.emit("session_before_compact",{reason:"overflow"},1100);
 t.mock.method(Math,"random",()=>.5);h.emit("agent_start",{},2000);
 assert.equal(h.entries.length,0);assert.ok(h.queue()[1].includes(word+"…"));
 h.finish(1,3000);h.emit("agent_end");h.settle();assert.equal(h.entries.length,1);assert.equal(h.entries[0].data.elapsedMs,3000);
});

test("a sign-off wave ends after 760ms, reduced motion skips it, and a new prompt cancels it",t=>{
 t.mock.timers.enable({apis:["setInterval"]});
 const events=eventBus(),layout=piLayout(),h=harness(t,events,{layout});
 events.emit(DISPLAY_SETTINGS_EVENT,{motion:"full"});h.render();h.emit("agent_start");h.emit("agent_end",{},1000);h.settle();
 assert.equal(h.entries.length,1);assert.equal(h.queue(1200).length,2);
 h.advance(1760,760);assert.deepEqual(h.queue(),[]);
 h.emit("agent_start",{},2000);h.emit("agent_end",{},3000);h.settle();
 h.emit("input",{},3100);assert.deepEqual(h.queue(),[]);
 events.emit(DISPLAY_SETTINGS_EVENT,{motion:"reduced"});h.emit("agent_start",{},4000);h.emit("agent_end",{},5000);h.settle();
 assert.deepEqual(h.queue(),[]);assert.equal(h.entries.length,3);
});

test("live thinking's newest three lines sit below the spinner and above the queue", t => {
	const events=eventBus();
	const { h, layout } = laidOut(t,events);
	events.emit(DISPLAY_SETTINGS_EVENT,{hidesLiveThinking:true});
	h.emit("agent_start");
	h.update("thinking_delta", "thought ".repeat(200) + "newest", 100);
	layout.queue.lines = QUEUED;
	const lines = h.queue(200);
	assert.match(lines[1], /thinking/);
	assert.equal(lines.length, 5 + QUEUED.length);
	assert.match(lines[2], /^  … /);
	assert.match(lines[4], /newest$/);
	assert.deepEqual(lines.slice(5), QUEUED);
	h.update("thinking_end", undefined, 2100);
	assert.match(h.queue()[1], /thought for 2s/);
	assert.deepEqual(h.queue().slice(2), QUEUED);
});

test("the spinner tail requires a loaded, enabled thinking host and reuses an unchanged tail",t=>{
 const events=eventBus(),layout=piLayout();let paints=0;
 const theme={fg:(_key,text)=>text,italic:text=>{paints++;return text;}};
 const h=harness(t,events,{layout,theme});h.render();h.emit("agent_start");
 h.update("thinking_delta","thought ".repeat(200),100);
 assert.equal(h.queue().length,2,"Tool Display absent: native thinking remains in the transcript");
 events.emit(DISPLAY_SETTINGS_EVENT,{hidesLiveThinking:true});
 assert.equal(h.queue().length,5);
 const cached=paints;h.queue(500);h.queue(700);
 assert.equal(paints,cached,"timer frames reuse the thinking tail");
 events.emit(DISPLAY_SETTINGS_EVENT,{hidesLiveThinking:false});
 assert.equal(h.queue().length,2,"Tool Display off: no duplicate tail");
});

test("an idle agent has no phase line, and the border shows the last run", t => {
	const { h, layout } = laidOut(t);
	h.emit("agent_start");
	h.finish(10, 1000);
	h.settle();
	layout.queue.lines = QUEUED;
	assert.deepEqual(h.queue(1760), QUEUED);
	assert.match(h.render(1760)[0], /Last 00:01\.0 ─$/);
});

test("Pi's statuses take the phase line, idle or during a run", async t => {
	const { h } = laidOut(t);
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 100);
	assert.match(h.queue(1600)[1], /^ \S+ Compacting context {2}00:01\.5 {2}Esc cancel$/);
	assert.doesNotMatch(h.render()[0], /Compacting/);
	h.show(undefined, 1700);
	await Promise.resolve();
	assert.deepEqual(h.queue(), []);
	h.emit("agent_start", {}, 2000);
	h.show(indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)"), 2000);
	assert.match(h.queue(3000)[1], / Retrying \(1\/3\) in 4s {2}00:01\.0 {2}Esc cancel$/);
	assert.match(h.render()[0], /Time 00:01\.0 ─$/);
});

test("ending the session takes the phase line away and leaves Pi's queue", t => {
	const { h, layout } = laidOut(t);
	h.emit("agent_start");
	layout.queue.lines = QUEUED;
	assert.equal(h.queue().length, QUEUED.length + 2);
	h.emit("session_shutdown");
	assert.deepEqual(h.queue(), QUEUED);
});

test("without Pi's layout the phase stays in the editor border", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("before_provider_request", {}, 100);
	assert.match(h.render(600)[0], /^─ \S+ 00:00\.5 .+… sending request, 0s, ↑ ─+ Time 00:00\.6 ─$/);
});

test("an idle status shows on the phase line only, never in the border as well", t => {
	const layout = piLayout();
	const h = harness(t, undefined, { layout, nativeStatus: true });
	h.render();
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 100);
	assert.match(h.queue(1600)[1], /Compacting context/);
	assert.equal(h.render()[0], "─".repeat(120), "no run yet: a plain border, not Pi's status");
	h.show(undefined, 1700);
	h.emit("agent_start", {}, 2000);
	h.finish(10, 3000);
	h.settle();
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 4000);
	assert.match(h.render(4500)[0], /^─+ Last 00:01\.0 ─$/, "after a run: the last run's summary");
});

test("a status ends when Pi disposes it, even if Pi no longer tells this editor", async t => {
	const { h } = laidOut(t);
	const compaction = indicator("compaction", "Compacting context... (Esc to cancel)");
	let disposed = 0;
	compaction.dispose = () => { disposed++; };
	h.show(compaction, 100);
	assert.match(h.queue(600)[1], /Compacting context/);
	// Another extension replaced the editor: Pi hands the status over, then disposes it when compaction ends.
	compaction.dispose();
	await Promise.resolve();
	assert.equal(disposed, 1, "Pi's own dispose still runs");
	assert.deepEqual(h.queue(), []);
});
