import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import deferTools, {
	RECOMMENDED_DEFER_TOOLS,
	DEFAULT_MERIDIAN_BASE_URLS,
	deferPayload,
	freezeDeferConfig,
	isMeridianModel,
	parseDeferConfig,
	requestGoesToMeridian,
	FROZEN_ENTRY,
} from "../extensions/defer-tools.ts";

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} tool`, input_schema: { type: "object", properties: {}, required: [] }, ...extra });
const payload = (...tools: unknown[]) => ({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true, tools, system: [{ type: "text", text: "sys" }] });
const meridian = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "http://127.0.0.1:3456" };
const deferredNames = (out: unknown) => ((out as { tools: Array<{ name: string; defer_loading?: unknown }> }).tools).filter((t) => t.defer_loading === true).map((t) => t.name);

test("config: off when names is missing or not a list, [] is off, invalid names dropped", () => {
	assert.deepEqual(parseDeferConfig({}).names, []);
	assert.deepEqual(parseDeferConfig({ names: "gov_search" }).names, []);
	assert.deepEqual(parseDeferConfig({ names: [] }).names, []);
	assert.deepEqual(parseDeferConfig({ names: [...RECOMMENDED_DEFER_TOOLS] }).names, RECOMMENDED_DEFER_TOOLS);
	assert.equal(RECOMMENDED_DEFER_TOOLS.length, 13);
	assert.deepEqual(parseDeferConfig({ names: ["gov_search", 3, "", " list_peers ", "gov_search", "bad name!"] }).names, ["gov_search", "list_peers"]);
	assert.deepEqual(parseDeferConfig({}).meridianBaseUrls, DEFAULT_MERIDIAN_BASE_URLS);
	assert.deepEqual(parseDeferConfig({ meridianBaseUrls: ["http://10.0.0.1:3456/", 5] }).meridianBaseUrls, ["http://10.0.0.1:3456"]);
});

test("config: the never-defer tools leave the list, whatever their case", () => {
	assert.deepEqual(parseDeferConfig({ names: ["read", "Bash", "edit", "write", "codemode", "powershell", "gov_search"] }).names, ["gov_search"]);
});

test("the kill switch PI_EXTRAS_DEFER_TOOLS=0 turns deferral off", () => {
	const section = { names: [...RECOMMENDED_DEFER_TOOLS] };
	assert.deepEqual(freezeDeferConfig(section, { PI_EXTRAS_DEFER_TOOLS: "0" }).names, []);
	assert.deepEqual(freezeDeferConfig(section, { PI_EXTRAS_DEFER_TOOLS: "1" }).names, RECOMMENDED_DEFER_TOOLS);
	assert.deepEqual(freezeDeferConfig(section, {}).names, RECOMMENDED_DEFER_TOOLS);
});

test("a frozen config does not change when its source object changes", () => {
	const section = { names: ["gov_search"] };
	const frozen = freezeDeferConfig(section, {});
	section.names.push("list_peers");
	assert.deepEqual(frozen.names, ["gov_search"]);
	assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.names));
});

test("defers only the listed tools that are in the payload", () => {
	const out = deferPayload(payload(tool("read"), tool("gov_search"), tool("bash")), ["gov_search", "not_present"]);
	assert.deepEqual(deferredNames(out), ["gov_search"]);
});

test("never defers read, bash, edit, write, codemode or powershell, even when listed", () => {
	const input = payload(tool("read"), tool("bash"), tool("edit"), tool("write"), tool("codemode"), tool("powershell"), tool("Read"), tool("gov_search"));
	const out = deferPayload(input, ["read", "bash", "edit", "write", "codemode", "powershell", "Read", "gov_search"]);
	assert.deepEqual(deferredNames(out), ["gov_search"]);
});

test("never defers every tool: then the payload is unchanged", () => {
	assert.equal(deferPayload(payload(tool("gov_search"), tool("list_peers")), ["gov_search", "list_peers"]), undefined);
	// Pi's own deferred placeholder does not count as a non-deferred tool.
	const placeholder = tool("__pi_deferred_placeholder__", { defer_loading: true });
	assert.equal(deferPayload(payload(tool("gov_search"), placeholder), ["gov_search"]), undefined);
});

test("a tool that already has defer_loading keeps its value", () => {
	const out = deferPayload(payload(tool("read"), tool("gov_search", { defer_loading: false }), tool("list_peers")), ["gov_search", "list_peers"]);
	const tools = (out as { tools: Array<Record<string, unknown>> }).tools;
	assert.equal(tools[1].defer_loading, false);
	assert.equal(tools[2].defer_loading, true);
});

test("a tool with cache_control is not deferred and keeps its cache_control in place", () => {
	const input = payload(tool("read"), tool("list_peers"), tool("gov_search", { cache_control: { type: "ephemeral" } }));
	const out = deferPayload(input, ["gov_search", "list_peers"]) as { tools: Array<Record<string, unknown>> };
	assert.deepEqual(deferredNames(out), ["list_peers"]);
	assert.deepEqual(out.tools[2], input.tools[2]);
	assert.deepEqual(Object.keys(out.tools[2]), ["name", "description", "input_schema", "cache_control"]);
});

test("no match, no tools or a non-object payload: undefined (Pi keeps its payload)", () => {
	assert.equal(deferPayload(payload(tool("read"), tool("bash")), ["gov_search"]), undefined);
	assert.equal(deferPayload({ model: "x", messages: [] }, ["gov_search"]), undefined);
	assert.equal(deferPayload("text", ["gov_search"]), undefined);
	assert.equal(deferPayload(null, ["gov_search"]), undefined);
	assert.equal(deferPayload(payload(tool("read"), tool("gov_search")), []), undefined);
});

test("output is byte-identical on every call, keeps tool and key order, and adds only defer_loading", () => {
	const input = payload(tool("read"), tool("gov_search"), tool("bash"), tool("list_peers"));
	const first = JSON.stringify(deferPayload(input, ["list_peers", "gov_search"]));
	for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(deferPayload(structuredClone(input), ["gov_search", "list_peers"])), first);
	const out = JSON.parse(first) as Record<string, unknown> & { tools: Array<Record<string, unknown>> };
	assert.deepEqual(Object.keys(out), Object.keys(input));
	assert.deepEqual(out.tools.map((t) => t.name), ["read", "gov_search", "bash", "list_peers"]);
	assert.deepEqual(Object.keys(out.tools[1]), ["name", "description", "input_schema", "defer_loading"]);
	const stripped = { ...out, tools: out.tools.map(({ defer_loading: _d, ...rest }) => rest) };
	assert.equal(JSON.stringify(stripped), JSON.stringify(input));
});

test("the input payload is not mutated", () => {
	const input = payload(tool("read"), tool("gov_search"));
	const before = JSON.stringify(input);
	const out = deferPayload(input, ["gov_search"]) as typeof input;
	assert.equal(JSON.stringify(input), before);
	assert.notEqual(out, input);
	assert.notEqual(out.tools, input.tools);
	assert.equal(out.tools[0], input.tools[0], "an unchanged tool object is shared, not copied");
});

test("Meridian detection: anthropic-messages and a Meridian base URL or header", () => {
	const urls = DEFAULT_MERIDIAN_BASE_URLS;
	assert.equal(isMeridianModel(meridian, urls), true);
	assert.equal(isMeridianModel({ ...meridian, baseUrl: "http://localhost:3456/" }, urls), true);
	assert.equal(isMeridianModel({ ...meridian, baseUrl: "https://api.anthropic.com" }, urls), false);
	assert.equal(isMeridianModel({ ...meridian, baseUrl: "https://gw.example", headers: { "x-meridian-agent": "pi" } }, urls), true);
	assert.equal(isMeridianModel({ ...meridian, baseUrl: "https://gw.example", headers: { "X-Meridian-Agent": "pi" } }, urls), true);
	assert.equal(isMeridianModel({ ...meridian, api: "openai-completions" }, urls), false);
	assert.equal(isMeridianModel({ ...meridian, baseUrl: "http://127.0.0.1:34567" }, urls), false);
	assert.equal(isMeridianModel(undefined, urls), false);
	assert.equal(isMeridianModel({ ...meridian, baseUrl: "https://gw.example", headers: { "x-meridian-agent": null } as never }, urls), false);
});

test("a request goes to Meridian only when its model id matches the selected Meridian model", () => {
	const urls = DEFAULT_MERIDIAN_BASE_URLS;
	assert.equal(requestGoesToMeridian({ model: meridian }, { model: "claude-opus-5-5" }, urls), true);
	assert.equal(requestGoesToMeridian({ model: meridian }, { model: "claude-haiku-5-5" }, urls), false);
	assert.equal(requestGoesToMeridian({ model: { ...meridian, baseUrl: "https://api.anthropic.com" } }, { model: "claude-opus-5-5" }, urls), false);
	assert.equal(requestGoesToMeridian({ model: undefined }, { model: "claude-opus-5-5" }, urls), false);
});

test("a virtual selection defers only when every registry model with the payload's id is Meridian", () => {
	const urls = DEFAULT_MERIDIAN_BASE_URLS;
	const virtual = { provider: "auto", id: "auto", api: "pi-virtual", baseUrl: "" };
	const registry = (...models: typeof meridian[]) => ({ getAll: () => models });
	assert.equal(requestGoesToMeridian({ model: virtual, modelRegistry: registry(meridian) }, { model: "claude-opus-5-5" }, urls), true);
	assert.equal(requestGoesToMeridian({ model: virtual, modelRegistry: registry(meridian, { ...meridian, provider: "direct", baseUrl: "https://api.anthropic.com" }) }, { model: "claude-opus-5-5" }, urls), false);
	assert.equal(requestGoesToMeridian({ model: virtual, modelRegistry: registry() }, { model: "claude-opus-5-5" }, urls), false);
});

type Handler = (event: { type: string; payload: unknown }, ctx: unknown) => unknown;
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	return {
		handlers,
		appended,
		appendEntry(customType: string, data: unknown) { appended.push({ customType, data: structuredClone(data) }); },
		start(ctx: unknown) {
			for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" } as never, ctx);
		},
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		headers(headers: Record<string, string>, ctx: unknown) {
			for (const handler of handlers.get("before_provider_headers") ?? []) handler({ type: "before_provider_headers", headers } as never, ctx);
		},
		emit(payloadValue: unknown, ctx: unknown) {
			const list = handlers.get("before_provider_request") ?? [];
			return list.map((handler) => handler({ type: "before_provider_request", payload: payloadValue }, ctx));
		},
	};
}
const ctxFor = (model: unknown, sessionId = "s1", branch: unknown[] = []) => ({ model, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } });
const userEntry = { type: "message", id: "u1", message: { role: "user", content: "hi" } };
const assistantEntry = { type: "message", id: "a1", message: { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5" } };
const frozenEntry = (names: string[]) => ({ type: "custom", id: "f1", customType: FROZEN_ENTRY, data: { names, meridianBaseUrls: [...DEFAULT_MERIDIAN_BASE_URLS] } });

test("the registered handler defers the configured tools for Meridian and leaves other providers alone", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: ["gov_search"] }, env: {}, store: new Map() });
	const input = payload(tool("read"), tool("gov_search"));
	const [out] = pi.emit(input, ctxFor(meridian));
	assert.deepEqual(deferredNames(out), ["gov_search"]);
	const [other] = pi.emit(input, ctxFor({ ...meridian, provider: "direct", baseUrl: "https://api.anthropic.com" }));
	assert.equal(other, undefined);
	const [openai] = pi.emit({ model: "claude-opus-5-5", messages: [], tools: [{ type: "function", function: { name: "gov_search" } }] }, ctxFor({ ...meridian, api: "openai-completions" }));
	assert.equal(openai, undefined);
});

test("the list is frozen for a session: a config change after load or a /reload does not reach it", () => {
	const store = new Map();
	const config: Record<string, unknown> = { names: ["gov_search"] };
	const first = fakePi();
	deferTools(first as never, { config, env: {}, store });
	const input = payload(tool("read"), tool("gov_search"), tool("list_peers"));
	assert.deepEqual(deferredNames(first.emit(input, ctxFor(meridian))[0]), ["gov_search"]);
	config.names = ["list_peers"];
	assert.deepEqual(deferredNames(first.emit(input, ctxFor(meridian))[0]), ["gov_search"]);
	// /reload: a new copy reads the new config, but the session keeps its first list.
	const reloaded = fakePi();
	deferTools(reloaded as never, { config: { names: ["list_peers"] }, env: {}, store });
	assert.deepEqual(deferredNames(reloaded.emit(input, ctxFor(meridian))[0]), ["gov_search"]);
	// A new session takes the config of its own start.
	assert.deepEqual(deferredNames(reloaded.emit(input, ctxFor(meridian, "s2"))[0]), ["list_peers"]);
});

test("the kill switch, an empty list and a missing list never change a payload", () => {
	const off = fakePi();
	deferTools(off as never, { config: { names: ["gov_search"] }, env: { PI_EXTRAS_DEFER_TOOLS: "0" }, store: new Map() });
	const empty = fakePi();
	deferTools(empty as never, { config: { names: [] }, env: {}, store: new Map() });
	const input = payload(tool("read"), tool("gov_search"));
	assert.deepEqual(off.emit(input, ctxFor(meridian)).filter((value) => value !== undefined), []);
	assert.deepEqual(empty.emit(input, ctxFor(meridian)).filter((value) => value !== undefined), []);
	const unset = fakePi();
	deferTools(unset as never, { config: {}, env: {}, store: new Map() });
	assert.deepEqual(unset.emit(input, ctxFor(meridian)).filter((value) => value !== undefined), []);
});

test("package.json loads Defer Tools before Cache Compaction and Status Plus, so their captures see the deferral", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { pi: { extensions: string[] } };
	const at = (path: string) => pkg.pi.extensions.indexOf(path);
	assert.ok(at("extensions/defer-tools.ts") >= 0);
	assert.ok(at("extensions/defer-tools.ts") < at("extensions/cache-compaction.ts"));
	assert.ok(at("extensions/defer-tools.ts") < at("extensions/status-plus.ts"));
	assert.ok(at("extensions/defer-tools.ts") < at("extensions/phase-spinner.ts"));
});

test("the x-meridian-agent request header marks a model as Meridian from its first request on", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: ["gov_search"] }, env: {}, store: new Map() });
	const gateway = { ...meridian, provider: "gateway", baseUrl: "https://gw.example" };
	const input = payload(tool("read"), tool("gov_search"));
	pi.headers({ "x-meridian-agent": "pi" }, ctxFor(gateway));
	assert.deepEqual(deferredNames(pi.emit(input, ctxFor(gateway))[0]), ["gov_search"]);
	// Another model of no Meridian provider stays as it is.
	const direct = { ...meridian, provider: "direct", baseUrl: "https://api.anthropic.com" };
	pi.headers({ authorization: "x" }, ctxFor(direct));
	assert.equal(pi.emit(input, ctxFor(direct))[0], undefined);
	assert.equal(requestGoesToMeridian({ model: gateway }, { model: "claude-opus-5-5" }, DEFAULT_MERIDIAN_BASE_URLS, new Set(["gateway/claude-opus-5-5"])), true);
	assert.equal(requestGoesToMeridian({ model: { ...gateway, api: "openai-completions" } }, { model: "claude-opus-5-5" }, DEFAULT_MERIDIAN_BASE_URLS, new Set(["gateway/claude-opus-5-5"])), false);
});

test("a new session reads pi-extras.json and writes its list into the session once", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: ["gov_search"] }, env: {}, store: new Map() });
	const ctx = ctxFor(meridian, "new1");
	pi.start(ctx);
	const input = payload(tool("read"), tool("gov_search"));
	assert.deepEqual(deferredNames(pi.emit(input, ctx)[0]), ["gov_search"]);
	pi.emit(input, ctx);
	pi.start(ctx);
	assert.deepEqual(pi.appended, [{ customType: FROZEN_ENTRY, data: { names: ["gov_search"], meridianBaseUrls: [...DEFAULT_MERIDIAN_BASE_URLS] } }]);
});

test("a session with deferral off writes no entry", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: {}, env: {}, store: new Map() });
	const ctx = ctxFor(meridian, "off1");
	pi.start(ctx);
	assert.equal(pi.emit(payload(tool("read"), tool("gov_search")), ctx)[0], undefined);
	assert.deepEqual(pi.appended, []);
});

test("a resumed session with an entry keeps its list, whatever pi-extras.json says now", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: ["list_peers"] }, env: {}, store: new Map() });
	const ctx = ctxFor(meridian, "old1", [frozenEntry(["gov_search"]), userEntry, assistantEntry]);
	pi.start(ctx);
	const input = payload(tool("read"), tool("gov_search"), tool("list_peers"));
	assert.deepEqual(deferredNames(pi.emit(input, ctx)[0]), ["gov_search"]);
	assert.deepEqual(pi.appended, []);
});

test("a resumed session with an empty entry stays off when pi-extras.json now lists tools", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: ["gov_search"] }, env: {}, store: new Map() });
	const ctx = ctxFor(meridian, "old2", [frozenEntry([]), userEntry, assistantEntry]);
	pi.start(ctx);
	assert.equal(pi.emit(payload(tool("read"), tool("gov_search")), ctx)[0], undefined);
});

test("a session with earlier assistant turns and no entry never starts to defer", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: ["gov_search"] }, env: {}, store: new Map() });
	const ctx = ctxFor(meridian, "old3", [userEntry, assistantEntry]);
	pi.start(ctx);
	assert.equal(pi.emit(payload(tool("read"), tool("gov_search")), ctx)[0], undefined);
	assert.deepEqual(pi.appended, []);
});

test("a fork keeps the entry of its source: the entry is on the branch it copies", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: [] }, env: {}, store: new Map() });
	const ctx = ctxFor(meridian, "fork1", [frozenEntry(["gov_search"]), userEntry, assistantEntry, userEntry]);
	pi.start(ctx);
	assert.deepEqual(deferredNames(pi.emit(payload(tool("read"), tool("gov_search")), ctx)[0]), ["gov_search"]);
	assert.deepEqual(pi.appended, []);
});

test("a /reload copy finds the session's entry, with no process record", () => {
	const first = fakePi();
	deferTools(first as never, { config: { names: ["gov_search"] }, env: {}, store: new Map() });
	const branch: unknown[] = [];
	const ctx = ctxFor(meridian, "rel1", branch);
	first.start(ctx);
	branch.push({ type: "custom", id: "f1", customType: first.appended[0].customType, data: first.appended[0].data }, userEntry, assistantEntry);
	const reloaded = fakePi();
	deferTools(reloaded as never, { config: { names: ["list_peers"] }, env: {}, store: new Map() });
	reloaded.start(ctx);
	assert.deepEqual(deferredNames(reloaded.emit(payload(tool("read"), tool("gov_search"), tool("list_peers")), ctx)[0]), ["gov_search"]);
	assert.deepEqual(reloaded.appended, []);
});

test("an entry with bad data freezes to what parses, never to pi-extras.json", () => {
	const pi = fakePi();
	deferTools(pi as never, { config: { names: ["list_peers"] }, env: {}, store: new Map() });
	const bad = { type: "custom", id: "f1", customType: FROZEN_ENTRY, data: { names: "gov_search" } };
	const ctx = ctxFor(meridian, "bad1", [bad, userEntry, assistantEntry]);
	pi.start(ctx);
	assert.equal(pi.emit(payload(tool("read"), tool("list_peers")), ctx)[0], undefined);
});
