/**
 * Errors that gov_search shows to the model. Every message is built here from
 * fixed text plus short, cleaned details, and passes through `redact`, so a
 * key that the API echoes back or that sits in a socket error never reaches
 * the transcript.
 */

export type GovErrorCode =
	| "input"
	| "key"
	| "keyFile"
	| "proxyConfig"
	| "proxy"
	| "proxyRefused"
	| "badRequest"
	| "auth"
	| "blocked"
	| "rate"
	| "upstream"
	| "http"
	| "response"
	| "network"
	| "timeout"
	| "cancelled"
	| "busy";

export class GovSearchError extends Error {
	readonly code: GovErrorCode;

	constructor(code: GovErrorCode, message: string) {
		super(message);
		this.name = "GovSearchError";
		this.code = code;
	}
}

const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_DETAIL_CHARS = 300;

/** One line of untrusted text, cut so an error never grows without bound. */
export function cleanDetail(value: string, maxChars = MAX_DETAIL_CHARS): string {
	const chars = Array.from(value.replace(CONTROL, " ").replace(/\s+/g, " ").trim());
	return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : chars.join("");
}

/** Removes the key, raw or percent-encoded, from any text. */
export function redact(text: string, key: string | undefined): string {
	if (!key) return text;
	let out = text;
	for (const form of new Set([key, encodeURIComponent(key)])) out = out.split(form).join("[redacted]");
	return out;
}

/** Node puts a short code like ECONNREFUSED on socket errors; the message can hold addresses, so only the code is shown. */
export function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : undefined;
}

const API = "The Firecrawl Government Index";
const NOT_SENT = "No request was sent.";

export const errors = {
	input: (reason: string) => new GovSearchError("input", `gov_search input is invalid: ${reason}.`),
	key: (source: string) => new GovSearchError("key", `The Firecrawl API key in ${source} is not valid: it must be 8 to 256 printable characters with no spaces. Correct or remove it. ${NOT_SENT}`),
	keyFile: (source: string, reason: string | undefined) =>
		new GovSearchError("keyFile", `The Firecrawl API key file (${source}) cannot be read${reason ? ` (${reason})` : ""}. Correct or remove it. ${NOT_SENT}`),
	proxyConfig: (source: string, reason: string) =>
		new GovSearchError("proxyConfig", `The gov_search proxy setting (${source}) is invalid: ${reason}. ${NOT_SENT} gov_search never sends a request directly when a proxy is set.`),
	proxy: (code: string | undefined) =>
		new GovSearchError("proxy", `The gov_search proxy did not answer${code ? ` (${code})` : ""}. Start the proxy or correct its address. The request was not sent directly.`),
	proxyRefused: (status: number | undefined) =>
		new GovSearchError("proxyRefused", `The gov_search proxy refused the tunnel to api.firecrawl.dev${status ? ` (HTTP ${status})` : ""}. Check that it is an HTTP CONNECT proxy. The request was not sent directly.`),
	badRequest: (reason: string) =>
		new GovSearchError("badRequest", `${API} rejected the request (HTTP 400)${reason ? `: ${reason}` : ""}. Check the filter values.`),
	auth: () => new GovSearchError("auth", `${API} rejected the API key (HTTP 401). Correct FIRECRAWL_API_KEY or the key file, or remove both to search without a key.`),
	// The API's own text for this case carries a signup link with a referral id, so it is not shown.
	blocked: () => new GovSearchError("blocked", `${API} refuses requests without a key from IP addresses that look like a VPN or proxy (HTTP 403). Set a free Firecrawl API key (FIRECRAWL_API_KEY or ~/.secrets/firecrawl_api_key), or remove the gov_search proxy setting.`),
	rate: (keyed: boolean) =>
		new GovSearchError("rate", keyed
			? `${API} rate limit for this API key is reached (HTTP 429). Wait, then try again.`
			: `${API} daily limit for searches without a key is reached for this IP address (HTTP 429). Try again tomorrow, or set a free Firecrawl API key (FIRECRAWL_API_KEY or ~/.secrets/firecrawl_api_key) for higher limits.`),
	upstream: (status: number) => new GovSearchError("upstream", `${API} failed upstream (HTTP ${status}). Try again later.`),
	http: (status: number) => new GovSearchError("http", `${API} returned an unexpected status (HTTP ${status}).`),
	response: (reason: string) => new GovSearchError("response", `${API} sent a response that gov_search cannot read (${reason}).`),
	network: (code: string | undefined, proxied: boolean) =>
		new GovSearchError("network", `gov_search could not complete the request to api.firecrawl.dev${proxied ? " through the proxy" : ""}${code ? ` (${code})` : ""}. Check the network, then try again.`),
	timeout: (seconds: number) => new GovSearchError("timeout", `${API} did not answer in ${seconds} seconds. Try again, or use a narrower query.`),
	cancelled: () => new GovSearchError("cancelled", "gov_search was cancelled."),
	busy: (max: number) => new GovSearchError("busy", `Too many gov_search calls run at the same time (the limit is ${max}). Try again when one is done.`),
};
