/**
 * Local providers: the owner's own hardware, with no bill and no other tenant to be fair to. When
 * one stops answering it is usually restarting or off for the night and will come back, so a
 * connection failure there waits with no time limit instead of giving up after the transient budget.
 *
 * Each resend that fails again adds a reply to the chat, so the wait does not resend on a timer:
 * it checks the server with a cheap GET <baseUrl>/models and sends the request again only when
 * the server answers, or after FALLBACK_RESEND_MS in case the check itself is what fails.
 */
import { isIP } from "node:net";

export interface LocalTarget { readonly baseUrl: string }
/** Read per failure, so a config change applies at the next one. */
export interface LocalPolicy { readonly enabled: boolean; readonly providers: readonly string[] }
export type Probe = (baseUrl: string, signal: AbortSignal) => Promise<boolean>;
type ModelLike = { readonly provider?: string; readonly baseUrl?: string; readonly cost?: unknown };

export const LOCAL_MAX_DELAY_MS = 30_000;
export const PROBE_INTERVAL_MS = 10_000;
export const FALLBACK_RESEND_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
// Names that only resolve inside a private network: mDNS, home routers, RFC 8375, Tailscale MagicDNS.
const PRIVATE_SUFFIX = /\.(?:local|lan|internal|localhost|home\.arpa|ts\.net)$/i;

function ipv4Private(host: string): boolean {
	const [a = -1, b = -1] = host.split(".").map(Number);
	return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
		|| (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function ipv6Private(host: string): boolean {
	const h = host.toLowerCase();
	return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** Loopback, RFC 1918, link-local, the CGNAT range Tailscale uses, IPv6 ULA, and private DNS names. */
export function isPrivateHost(raw: string): boolean {
	const host = raw.replace(/^\[|\]$/g, "").trim();
	if (!host) return false;
	const family = isIP(host);
	if (family === 4) return ipv4Private(host);
	if (family === 6) return ipv6Private(host);
	if (host.toLowerCase() === "localhost" || PRIVATE_SUFFIX.test(host)) return true;
	// A single-label name (fw01, redarch) resolves only through a local hosts file or search domain.
	return !host.includes(".");
}

function free(cost: unknown): boolean {
	if (!cost || typeof cost !== "object") return false;
	const record = cost as Record<string, unknown>;
	return COST_KEYS.every((key) => record[key] === 0);
}

/**
 * The model's server when it is local: free and not on a public host. Meridian listens on loopback
 * but bills a cloud model, so the address alone is not enough. `named` lists extra providers.
 */
export function localTarget(model: ModelLike | undefined, named: readonly string[]): LocalTarget | undefined {
	if (!model || typeof model.baseUrl !== "string" || !model.baseUrl) return undefined;
	let host: string;
	try { host = new URL(model.baseUrl).hostname; } catch { return undefined; }
	if (typeof model.provider === "string" && named.includes(model.provider)) return { baseUrl: model.baseUrl };
	return free(model.cost) && isPrivateHost(host) ? { baseUrl: model.baseUrl } : undefined;
}

// Only these mean that no backend is there; a 500 or 501 for an unknown path is a server that answers.
const DOWN_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);

/** `<baseUrl>/models`, without userinfo (fetch refuses it), query or fragment. */
export function modelsUrl(baseUrl: string): string | undefined {
	try {
		const url = new URL(baseUrl);
		url.username = ""; url.password = ""; url.search = ""; url.hash = "";
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
		return url.href;
	} catch { return undefined; }
}

// A model list larger than this is not read: it is a long list, so not an empty one.
const MAX_LIST_BYTES = 256 * 1024;

/**
 * True for an OpenAI-style model list with no model in it. A gateway whose engine is stopped
 * (Kiln) answers /models with 200 and `"data": []` but fails every request with 503, so that
 * reply means "not ready". Any other body, also one that does not parse, keeps the old answer.
 */
async function listsNoModel(response: Response): Promise<boolean> {
	const ok = response.status >= 200 && response.status < 300 && /json/i.test(response.headers.get("content-type") ?? "");
	if (!ok || Number(response.headers.get("content-length") ?? 0) > MAX_LIST_BYTES) {
		await response.body?.cancel().catch(() => {});
		return false;
	}
	try {
		const text = await readAtMost(response, MAX_LIST_BYTES);
		if (text === undefined) return false;
		const data = (JSON.parse(text) as { data?: unknown }).data;
		return Array.isArray(data) && data.length === 0;
	} catch {
		return false;
	}
}

/** The body as text, or undefined (and the rest not read) when it is longer than `limit` bytes. */
async function readAtMost(response: Response, limit: number): Promise<string | undefined> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) { await reader.cancel().catch(() => {}); return undefined; }
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * True when the server answers: any HTTP reply except 502, 503 and 504, and except a model list
 * with no model in it. No custom header and no credential is sent.
 */
export async function probeServer(baseUrl: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	const url = modelsUrl(baseUrl);
	if (!url) return false;
	try {
		// A redirect is an answer; following it would send the check to another host.
		const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) });
		if (DOWN_STATUS.has(response.status)) {
			await response.body?.cancel().catch(() => {});
			return false;
		}
		return !(await listsNoModel(response));
	} catch {
		return false;
	}
}

export interface UntilAnswering {
	readonly delayMs: number;
	readonly signal: AbortSignal;
	readonly tick: () => void;
	readonly now: () => number;
	readonly wait: (ms: number, signal: AbortSignal, tick: () => void) => Promise<boolean>;
	/** Undefined when the model has no address to check: then only the fallback resends. */
	readonly probe?: (signal: AbortSignal) => Promise<boolean>;
}

/** How a local wait ended: the server answered, the fallback timer ran out, or it was cancelled. */
export type LocalWaitEnd = "answered" | "timer" | "cancelled";

/** Waits the backoff delay, then until the server answers or FALLBACK_RESEND_MS passes. */
export async function waitUntilAnswering(o: UntilAnswering): Promise<LocalWaitEnd> {
	if (!(await o.wait(o.delayMs, o.signal, o.tick))) return "cancelled";
	const start = o.now();
	for (;;) {
		if (o.signal.aborted) return "cancelled";
		if (o.probe && (await probeWithTicks(o))) return o.signal.aborted ? "cancelled" : "answered";
		if (o.signal.aborted) return "cancelled";
		if (o.now() - start >= FALLBACK_RESEND_MS) return "timer";
		if (!(await o.wait(PROBE_INTERVAL_MS, o.signal, o.tick))) return "cancelled";
	}
}

// The live line keeps counting while a check waits for its 5 s timeout.
async function probeWithTicks(o: UntilAnswering): Promise<boolean> {
	const interval = setInterval(() => { try { o.tick(); } catch { /* the wait's own tick reports UI faults */ } }, 1000);
	try { return await o.probe!(o.signal); }
	finally { clearInterval(interval); }
}
