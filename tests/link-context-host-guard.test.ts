import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../lib/link-context/config.ts";
import { MESSAGE_TYPE, REPORT_TYPE } from "../lib/subagents/deliver.ts";
import { MODEL_WRITTEN_TYPES, NamedHostCache, defang, resultHosts, hostsIn, isNamed, namedHosts, registerHostGuard, requestedHosts, requestedTargets } from "../lib/link-context/host-guard.ts";

const FABRICATED = "https://routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com/proxy_temp_file/production/2026-10-22/trace_2101815e17926167089461936e0c00/x?Expires=1813720712&Signature=placeholder";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function message(role: string, text: string, extra: Record<string, unknown> = {}) {
	return { type: "message", id: `${role}-${text.length}`, message: { role, content: [{ type: "text", text }], ...extra } };
}

function install(section: Record<string, unknown> = {}) {
	const handlers = new Map<string, Handler>();
	registerHostGuard({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never, () => parseConfig(section));
	return handlers;
}

function context(provider: string, branch: unknown[], systemPrompt = "", sessionId = "s1") {
	return {
		model: { provider, id: "m" },
		getSystemPrompt: () => systemPrompt,
		sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
	};
}

test("hosts are found in URLs, bare domains and IPv4 addresses, lower case and without www", () => {
	const hosts = hostsIn("See https://User:pw@WWW.Example.COM:8443/a?b, docs.rs/serde and 10.1.2.3:8080. Also file.ts");
	for (const host of ["www.example.com", "docs.rs", "10.1.2.3"]) assert.ok(hosts.has(host), host);
	assert.ok(isNamed("example.com", hosts), "www. is ignored for an exact match");
	assert.ok(!isNamed("api.example.com", hosts), "a named www. host does not vouch for other subdomains");
});

test("a defanged host is not found again", () => {
	const text = defang("routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com");
	assert.equal(text, "routify-file-proxy-sg[.]oss-ap-southeast-1[.]aliyuncs[.]com");
	assert.equal(hostsIn(`refused: ${text}`).size, 0);
});

test("a subdomain of a named host counts as named; a parent or a sibling does not", () => {
	const named = new Set(["github.com", "kmcamera.com"]);
	assert.ok(isNamed("api.github.com", named));
	assert.ok(isNamed("kmcamera.com", named));
	assert.ok(!isNamed("aliyuncs.com", named));
	assert.ok(!isNamed("routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com", named));
	assert.ok(!isNamed("169.254.169.254", new Set(["169.254.169.25"])));
});

test("requested hosts come from pull_link url and fetch_content url and urls", () => {
	assert.deepEqual(requestedHosts("pull_link", { url: FABRICATED }), ["routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com"]);
	assert.deepEqual(requestedHosts("fetch_content", { urls: ["https://a.example.org/x", "not a url"], url: "http://b.example.net" }).sort(), ["a.example.org", "b.example.net"]);
	assert.deepEqual(requestedHosts("read", { url: FABRICATED }), []);
});

test("only user text, tool results, custom messages and the system prompt name hosts", () => {
	const branch = [
		message("user", "Find prices on kmcamera.com"),
		message("assistant", `I will fetch ${FABRICATED}`),
		message("toolResult", "1. https://www.keh.com/shop/canon"),
		{ type: "custom_message", id: "c", content: "Pull Link read https://news.ycombinator.com/item?id=1" },
		message("bashExecution", "", { output: "curl ok from docs.example.dev" }),
	];
	const named = namedHosts(context("fw01", branch, "Reports go to srv.example.me") as never);
	for (const host of ["kmcamera.com", "keh.com", "news.ycombinator.com", "docs.example.dev", "srv.example.me"]) assert.ok(isNamed(host, named), host);
	assert.ok(!named.has("routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com"));
});

test("a non-Anthropic model is refused a host nobody named, with the host defanged", async () => {
	const handlers = install();
	const ctx = context("fw01", [message("user", "Find prices on kmcamera.com")]);
	const result = await handlers.get("tool_call")!({ toolName: "pull_link", input: { url: FABRICATED } }, ctx) as { block?: boolean; reason?: string };
	assert.equal(result?.block, true);
	assert.match(result.reason!, /routify-file-proxy-sg\[\.\]oss-ap-southeast-1\[\.\]aliyuncs\[\.\]com/);
	assert.equal(hostsIn(result.reason!).size, 0, "the refusal must not name the host, or a retry would pass");
	assert.equal(await handlers.get("tool_call")!({ toolName: "pull_link", input: { url: "https://kmcamera.com/products/x" } }, ctx), undefined);
});

test("an exempt provider, an off guard and other tools pass", async () => {
	const ctx = (provider: string) => context(provider, [message("user", "hello")]);
	const call = { toolName: "fetch_content", input: { url: FABRICATED } };
	assert.equal(await install().get("tool_call")!(call, ctx("anthropic")), undefined);
	assert.equal(await install().get("tool_call")!(call, ctx("claude-code")), undefined, "the exempt family's other providers pass");
	assert.equal(await install({ hostGuard: false }).get("tool_call")!(call, ctx("fw01")), undefined);
	assert.equal(await install().get("tool_call")!({ toolName: "bash", input: { command: `curl ${FABRICATED}` } }, ctx("fw01")), undefined);
	const all = await install({ hostGuardExempt: [] }).get("tool_call")!(call, ctx("anthropic")) as { block?: boolean };
	assert.equal(all?.block, true, "an empty exempt list guards every provider");
});

test("hosts from nested tool results (codemode) count for the same session only", async () => {
	const handlers = install();
	handlers.get("tool_result")!({ toolName: "web_search", parentToolCallId: "p", content: [{ type: "text", text: "1. https://picclick.com/?q=lens" }] }, context("fw01", [], "", "s1"));
	const call = { toolName: "pull_link", input: { url: "https://picclick.com/?q=lens" } };
	assert.equal(await handlers.get("tool_call")!(call, context("fw01", [], "", "s1")), undefined);
	const other = await handlers.get("tool_call")!(call, context("fw01", [], "", "s2")) as { block?: boolean };
	assert.equal(other?.block, true);
});

test("allowed hosts and their subdomains pass; others are still refused", async () => {
	const handlers = install({ hostGuardAllow: ["Web.Archive.org", "githubusercontent.com"] });
	const ctx = context("fw01", [message("user", "hello")]);
	const call = (url: string) => handlers.get("tool_call")!({ toolName: "pull_link", input: { url } }, ctx) as Promise<{ block?: boolean } | undefined>;
	assert.equal(await call("https://web.archive.org/web/2020/x"), undefined);
	assert.equal(await call("https://raw.githubusercontent.com/a/b/main/README.md"), undefined);
	assert.equal((await call(FABRICATED))?.block, true);
});

test("config defaults and validation", () => {
	assert.equal(parseConfig({}).hostGuard, true);
	assert.deepEqual(parseConfig({}).hostGuardExempt, ["anthropic"]);
	assert.equal(parseConfig({ hostGuard: "no" }).hostGuard, true);
	assert.deepEqual(parseConfig({ hostGuardExempt: ["openai", 3, ""] }).hostGuardExempt, ["openai"]);
	assert.deepEqual(parseConfig({ hostGuardExempt: "openai" }).hostGuardExempt, ["anthropic"]);
	assert.deepEqual(parseConfig({}).hostGuardAllow, []);
	assert.deepEqual(parseConfig({ hostGuardAllow: [" Web.Archive.org ", null] }).hostGuardAllow, ["web.archive.org"]);
});

test("a URL without a scheme or in angle brackets is checked; a URL that does not parse is refused", async () => {
	assert.deepEqual(requestedHosts("pull_link", { url: "evil.example.com/x" }), ["evil.example.com"]);
	assert.deepEqual(requestedHosts("pull_link", { url: "<https://evil.example.com/x>" }), ["evil.example.com"]);
	assert.deepEqual(requestedHosts("fetch_content", { urls: "https://evil.example.com/x" }), ["evil.example.com"], "urls given as a string");
	assert.deepEqual(requestedHosts("fetch_content", { url: "https://a.example.org", proxy: "http://proxy.example.net:8080" }).sort(), ["a.example.org", "proxy.example.net"]);
	assert.equal(requestedTargets("pull_link", { url: "https://evil.example.com:99999/x" }).invalid, true);
	const handlers = install();
	const result = await handlers.get("tool_call")!({ toolName: "pull_link", input: { url: "https://evil.example.com:99999/x" } }, context("fw01", [message("user", "hi")])) as { block?: boolean; reason?: string };
	assert.equal(result?.block, true);
	assert.equal(hostsIn(result.reason!).size, 0);
});

test("a tool result that repeats its own call's arguments names nothing; a search result does", () => {
	const call = (id: string, name: string, args: unknown) => ({ type: "message", id: `a-${id}`, message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
	const result = (id: string, toolName: string, text: string) => ({ type: "message", id: `r-${id}`, message: { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError: true } });
	const branch = [
		message("user", "hi"),
		call("1", "fetch_content", { urls: FABRICATED }),
		result("1", "fetch_content", `Validation failed. Received arguments:\n${JSON.stringify({ urls: FABRICATED })}`),
		call("2", "bash", { command: "echo https://echo.example.com" }),
		result("2", "bash", "https://echo.example.com"),
		call("3", "web_search", { query: "site:law.cornell.edu 47 CFR 79" }),
		result("3", "web_search", "1. https://www.law.cornell.edu/cfr/text/47/79.1"),
	];
	const named = namedHosts(context("fw01", branch) as never);
	assert.ok(!isNamed("routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com", named));
	assert.ok(!isNamed("echo.example.com", named));
	assert.ok(isNamed("law.cornell.edu", named));
});

test("a search that repeats a made-up host in its query header does not name it", () => {
	const host = "routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com";
	const header = `## Query: "${host}"\n\n## Results for: "${host}"\nNo results.`;
	assert.equal(resultHosts(header, { query: host }, "web_search").size, 0);
	assert.equal(resultHosts(`Received query=${host}`, { query: host }, "get_search_content").size, 0);
	const real = resultHosts(`## Query: "canon serenar 50mm"\n1. https://www.keh.com/shop/x`, { query: "canon serenar 50mm" }, "web_search");
	assert.ok(isNamed("keh.com", real));
});

test("a named parent on a shared hosting domain does not vouch for its buckets", () => {
	const named = new Set(["oss-ap-southeast-1.aliyuncs.com", "s3.amazonaws.com", "github.com"]);
	assert.ok(!isNamed("routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com", named));
	assert.ok(!isNamed("evil.s3.amazonaws.com", named));
	assert.ok(isNamed("oss-ap-southeast-1.aliyuncs.com", named), "the exact host still counts");
	assert.ok(isNamed("api.github.com", named));
});

test("subagent mail and reports are another model's text and name nothing", () => {
	assert.ok(MODEL_WRITTEN_TYPES.has(MESSAGE_TYPE) && MODEL_WRITTEN_TYPES.has(REPORT_TYPE), "kept in step with lib/subagents/deliver.ts");
	const branch = [
		message("user", "hi"),
		{ type: "custom_message", id: "m", customType: REPORT_TYPE, content: `Found ${FABRICATED}` },
		{ type: "custom_message", id: "n", customType: MESSAGE_TYPE, content: "see https://mail.example.com" },
	];
	const named = namedHosts(context("fw01", branch) as never);
	assert.ok(!named.has("mail.example.com"));
	assert.ok(!isNamed("routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com", named));
});

test("internationalized names match their punycode form and are found whole", () => {
	const named = hostsIn("Prices at bücher.de today");
	assert.ok(named.has("xn--bcher-kva.de"));
	assert.ok(!named.has("cher.de"));
	assert.deepEqual(requestedHosts("pull_link", { url: "https://bücher.de/x" }), ["xn--bcher-kva.de"]);
	assert.ok(isNamed("xn--bcher-kva.de", named));
	assert.ok(hostsIn("example.com..").has("example.com"));
});

test("long runs of scheme-like text scan in linear time", () => {
	const started = performance.now();
	hostsIn("a-".repeat(500_000));
	hostsIn(`${"x".repeat(1_000_000)}://`);
	assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
});

test("the cache scans each entry once and starts over for a new session", () => {
	let reads = 0;
	const entry = { type: "message", id: "u1", message: { role: "user", get content() { reads++; return "see kmcamera.com"; } } };
	const cache = new NamedHostCache();
	const ctx = (session: string) => ({ getSystemPrompt: () => "", sessionManager: { getBranch: () => [entry], getSessionId: () => session } });
	assert.ok(cache.namedHosts(ctx("s1") as never).has("kmcamera.com"));
	cache.namedHosts(ctx("s1") as never);
	assert.equal(reads, 1);
	cache.namedHosts(ctx("s2") as never);
	assert.equal(reads, 2);
});
