/**
 * Host guard: refuse a pull_link or fetch_content call to a host that nothing
 * in the conversation named. Some models make up URLs and send them as tool
 * input: Qwen3.8 builds dial signed Alibaba OSS "file proxy" links from their
 * training data (routify-file-proxy-sg...aliyuncs.com), even when their own
 * reasoning names a different page. Each such request tells a third party the
 * host's IP, the time and the URL, which can carry context. A prompt rule does
 * not stop it; a check at the tool boundary does.
 *
 * A host counts as named when a user message, a tool result (nested codemode
 * results too), a custom message or the system prompt contains it, or a host
 * it is a subdomain of. The model's own text never counts: not its messages,
 * not a subagent's mail or report, and not a tool result that only repeats the
 * arguments of its own call (a validation error, `echo`, a fetched page's
 * header). `hostGuardAllow` adds hosts the operator trusts. The refusal writes
 * the host defanged, so the refusal itself does not name it for the retry.
 */
import { domainToASCII } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { TOOL_NAME } from "./format.ts";
import type { LinkConfig } from "./types.ts";

/** Tools whose `url` / `urls` / `proxy` inputs go to the network as given. */
export const GUARDED_TOOLS: ReadonlySet<string> = new Set([TOOL_NAME, "fetch_content"]);

/** Subagent mail and reports (lib/subagents/deliver.ts): another model's text, so it names nothing. */
export const MODEL_WRITTEN_TYPES: ReadonlySet<string> = new Set(["subagent-message", "subagent-report"]);

/**
 * Domains where anyone can put a bucket, page or app under a subdomain. A named
 * parent on these does not vouch for its subdomains: one search result naming
 * `oss-ap-southeast-1.aliyuncs.com` must not let every bucket there pass.
 */
const SHARED_SUFFIXES = [
	"aliyuncs.com", "amazonaws.com", "cloudfront.net", "googleapis.com", "appspot.com", "blob.core.windows.net",
	"azurewebsites.net", "github.io", "githubusercontent.com", "r2.dev", "r2.cloudflarestorage.com", "workers.dev",
	"pages.dev", "vercel.app", "netlify.app", "herokuapp.com", "digitaloceanspaces.com", "myqcloud.com",
	"backblazeb2.com", "firebaseapp.com", "web.app", "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app",
];

// The scheme is bounded and anchored on a non-scheme character: an unbounded `\b[a-z][a-z0-9+.-]*` is quadratic on long runs.
const URL_AUTHORITY = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/?#"'<>()[\]{}\\|^`]{1,512})/giu;
const DOMAIN = /(?<![\p{L}\p{N}_.-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.){1,126}\p{L}[\p{L}\p{N}-]{0,62})(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])/gu;
const IPV4 = /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})(?![\w.])/g;
/** Cap on the hosts kept from nested results, so a long session cannot grow it without end. */
const NESTED_LIMIT = 10_000;

/** Lower case, ASCII (punycode) and without trailing dots. `www.` stays: only an exact comparison ignores it. */
export function normalize(host: string): string {
	const lower = host.toLowerCase().replace(/\.+$/, "");
	// eslint-disable-next-line no-control-regex
	return /[^\x00-\x7f]/.test(lower) ? domainToASCII(lower) || lower : lower;
}

/** The host of an authority: no user info, no port, IPv6 without brackets. */
function authorityHost(authority: string): string {
	const bare = authority.slice(authority.lastIndexOf("@") + 1);
	if (bare.startsWith("[")) return bare.slice(1, bare.indexOf("]") > 0 ? bare.indexOf("]") : undefined);
	return bare.replace(/:\d*$/, "");
}

/** Every host a text names, as a URL, a bare domain or an IPv4 address. */
export function hostsIn(text: string): Set<string> {
	const hosts = new Set<string>();
	for (const match of text.matchAll(URL_AUTHORITY)) hosts.add(normalize(authorityHost(match[1]!)));
	for (const match of text.matchAll(DOMAIN)) hosts.add(normalize(match[1]!));
	for (const match of text.matchAll(IPV4)) hosts.add(match[1]!);
	hosts.delete("");
	return hosts;
}

/** The host written so that hostsIn does not find it: `a[.]b[.]com`. */
export function defang(host: string): string {
	return host.replaceAll(".", "[.]");
}

const withoutWww = (host: string) => host.replace(/^www\./, "");
const isShared = (host: string) => SHARED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));

/**
 * True when the host was named, ignoring a leading `www.`, or a domain it is a
 * subdomain of was named. On shared hosting domains only the exact host
 * counts. IP addresses match only exactly.
 */
export function isNamed(host: string, named: ReadonlySet<string>): boolean {
	const target = normalize(host);
	const bare = withoutWww(target);
	if (named.has(target) || named.has(bare) || named.has(`www.${bare}`)) return true;
	if (/^[\d.]+$/.test(target) || target.includes(":")) return false;
	const labels = bare.split(".");
	for (let i = 1; i < labels.length - 1; i++) {
		const parent = labels.slice(i).join(".");
		if (isShared(parent)) return false;
		if (named.has(parent)) return true;
	}
	return false;
}

/** True when the host is an allowed host or a subdomain of one. The operator chose these, so shared domains count too. */
export function isAllowed(host: string, allow: readonly string[]): boolean {
	const target = withoutWww(normalize(host));
	return allow.some((entry) => {
		const allowed = withoutWww(normalize(entry));
		return target === allowed || target.endsWith(`.${allowed}`);
	});
}

type Target = { host: string } | { invalid: true };

/** The host the tool would contact, read the way pull_link reads a URL: `<...>` stripped, `https://` when no scheme. */
function targetOf(url: unknown): Target | undefined {
	if (typeof url !== "string" || !url.trim()) return undefined;
	const text = url.trim().replace(/^<|>$/g, "");
	try {
		const host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`).hostname;
		return host ? { host: normalize(host.replace(/^\[|\]$/g, "")) } : { invalid: true };
	} catch {
		return { invalid: true };
	}
}

/** The hosts a guarded tool call would contact, and whether a URL in it does not parse. */
export function requestedTargets(toolName: string, input: unknown): { hosts: string[]; invalid: boolean } {
	if (!GUARDED_TOOLS.has(toolName) || typeof input !== "object" || input === null) return { hosts: [], invalid: false };
	const args = input as { url?: unknown; urls?: unknown; proxy?: unknown };
	const values = [args.url, args.proxy, ...(Array.isArray(args.urls) ? args.urls : [args.urls])];
	const targets = values.map(targetOf).filter((target): target is Target => target !== undefined);
	const hosts = targets.flatMap((target) => ("host" in target ? [target.host] : []));
	return { hosts: [...new Set(hosts)], invalid: targets.some((target) => "invalid" in target) };
}

/** The hosts a guarded tool call would contact. */
export function requestedHosts(toolName: string, input: unknown): string[] {
	return requestedTargets(toolName, input).hosts;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n");
}

/** Search tools list hosts from an index, not from their query, so a host in the query does not make the results an echo. */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set(["web_search", "kagi_search", "gov_search"]);

/** Every string in a call's arguments, at any depth. */
function argumentStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) argumentStrings(item, out);
	else if (value && typeof value === "object") for (const item of Object.values(value)) argumentStrings(item, out);
	return out;
}

/**
 * Hosts in a tool result, minus its echo of the model's input. Each argument
 * string, raw and JSON-quoted, is cut from the text first: that drops a search
 * tool's `## Query: "<host>"` header and keeps the hosts of its real results.
 * Other tools also lose every host their arguments hold (a validation error,
 * `echo`, a fetched page's header).
 */
export function resultHosts(text: string, args: unknown, toolName = ""): Set<string> {
	let rest = text;
	for (const value of argumentStrings(args)) {
		if (value.trim().length < 3) continue;
		rest = rest.replaceAll(JSON.stringify(value).slice(1, -1), " ").replaceAll(value, " ");
	}
	const hosts = hostsIn(rest);
	if (args !== undefined && !SEARCH_TOOLS.has(toolName)) for (const host of hostsIn(JSON.stringify(args) ?? "")) hosts.delete(host);
	return hosts;
}

type Entry = { id?: string; type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown; output?: unknown; toolCallId?: string; toolName?: string } };

/** The arguments of each tool call in an assistant message, by call id. */
function callArguments(entry: Entry, calls: Map<string, unknown>): void {
	const message = entry.type === "message" ? entry.message : undefined;
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const part of message.content as { type?: string; id?: string; arguments?: unknown }[]) {
		if (part?.type === "toolCall" && typeof part.id === "string") calls.set(part.id, part.arguments);
	}
}

/** The hosts one session entry names, or none when the model wrote it. */
function entryHosts(entry: Entry, calls: ReadonlyMap<string, unknown>): Set<string> {
	if (entry.type === "custom_message") return MODEL_WRITTEN_TYPES.has(entry.customType ?? "") ? new Set() : hostsIn(textOf(entry.content));
	const message = entry.type === "message" ? entry.message : undefined;
	switch (message?.role) {
		case "user":
		case "custom":
			return hostsIn(textOf(message.content));
		case "bashExecution":
			return hostsIn(typeof message.output === "string" ? message.output : "");
		case "toolResult":
			return resultHosts(textOf(message.content), calls.get(message.toolCallId ?? ""), message.toolName);
		default:
			return new Set();
	}
}

/** Per-entry results, by session; entries do not change once written, so each is scanned once. */
export class NamedHostCache {
	private session = "";
	private byEntry = new Map<string, Set<string>>();

	namedHosts(ctx: Pick<ExtensionContext, "sessionManager" | "getSystemPrompt">): Set<string> {
		const session = ctx.sessionManager.getSessionId();
		if (session !== this.session) {
			this.session = session;
			this.byEntry = new Map();
		}
		const named = hostsIn(ctx.getSystemPrompt?.() ?? "");
		const calls = new Map<string, unknown>();
		for (const entry of ctx.sessionManager.getBranch() as Entry[]) {
			callArguments(entry, calls);
			let hosts = entry.id ? this.byEntry.get(entry.id) : undefined;
			if (!hosts) {
				hosts = entryHosts(entry, calls);
				if (entry.id) this.byEntry.set(entry.id, hosts);
			}
			for (const host of hosts) named.add(host);
		}
		return named;
	}
}

/** The hosts the current branch and the system prompt name (no cache). */
export function namedHosts(ctx: Pick<ExtensionContext, "sessionManager" | "getSystemPrompt">): Set<string> {
	return new NamedHostCache().namedHosts(ctx);
}

export function refusal(hosts: readonly string[], invalid: boolean): string {
	if (hosts.length === 0 && invalid) return "refused: a URL in this call is not a valid URL. Use a full http(s) URL from the task or from a tool result.";
	const list = hosts.map(defang).join(", ");
	return `refused: ${list} appears nowhere in this conversation (no user message, tool result or system prompt names it). `
		+ "Is this a URL you made up? Use a URL from the task or from a tool result, or search first. Do not try this host again.";
}

export function registerHostGuard(pi: ExtensionAPI, config: () => LinkConfig = loadConfig): void {
	const cache = new NamedHostCache();
	// Nested results (a codemode script's search, then its fetch) reach the branch only with the outer result.
	let nested: { session: string; hosts: Set<string> } | undefined;

	pi.on("tool_result", (event, ctx) => {
		if (!event.parentToolCallId) return;
		const session = ctx.sessionManager.getSessionId();
		if (nested?.session !== session || nested.hosts.size > NESTED_LIMIT) nested = { session, hosts: new Set() };
		for (const host of resultHosts(textOf(event.content), event.input, event.toolName)) nested.hosts.add(host);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		const settings = config();
		if (!settings.hostGuard || settings.hostGuardExempt.includes(ctx.model?.provider ?? "")) return undefined;
		const { hosts, invalid } = requestedTargets(event.toolName, event.input);
		if (hosts.length === 0 && !invalid) return undefined;
		const named = cache.namedHosts(ctx);
		if (nested?.session === ctx.sessionManager.getSessionId()) for (const host of nested.hosts) named.add(host);
		const unnamed = hosts.filter((host) => !isAllowed(host, settings.hostGuardAllow) && !isNamed(host, named));
		// A URL that does not parse is refused too: the tool's own error would repeat it, and that echo is a tool result.
		return unnamed.length || invalid ? { block: true, reason: refusal(unnamed, invalid) } : undefined;
	});
}
