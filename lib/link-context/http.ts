/**
 * Bounded HTTP for adapters: a size cap, a timeout joined to the caller's
 * abort signal, and a user-agent chain. Sites differ in which client they
 * serve: Reddit's JSON answers link-preview crawlers but sends a plain client
 * to a login page, so each adapter names the chain it needs and the first
 * answer that passes `accept` wins.
 */
import { parseUrl } from "./url.ts";

export const MAX_BODY_BYTES = 8_000_000;
export const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Identifies the tool honestly; services such as FxTwitter ask for a named client. */
export const PLAIN_UA = "Mozilla/5.0 (compatible; pi-extras-link/1.0; +https://github.com/jaedync/pi-extras)";
/** Link-preview crawlers: many sites serve these the server-rendered page that chat apps unfurl. */
export const PREVIEW_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export type Fetcher = typeof fetch;

export interface HttpResult {
	readonly status: number;
	readonly url: string;
	readonly contentType: string;
	readonly body: string;
}

export interface GetOptions {
	readonly signal?: AbortSignal;
	readonly agents?: readonly string[];
	readonly headers?: Readonly<Record<string, string>>;
	readonly accept?: (result: HttpResult) => boolean;
	readonly fetcher?: Fetcher;
	readonly maxBytes?: number;
}

export class HttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

/** The body as bytes, refused past `maxBytes` whether or not the server sent a length. */
export async function readBytes(response: Response, maxBytes: number): Promise<Buffer> {
	if (Number(response.headers.get("content-length")) > maxBytes) {
		void response.body?.cancel();
		throw new HttpError(`Response is larger than ${Math.round(maxBytes / 1e6)} MB`, response.status);
	}
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > maxBytes) throw new HttpError(`Response is larger than ${Math.round(maxBytes / 1e6)} MB`, response.status);
			chunks.push(part.value);
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks);
}

const CREDENTIAL_HEADERS = /^(?:authorization|cookie|proxy-authorization)$/i;

export interface Checked {
	readonly response: Response;
	readonly url: string;
}

/**
 * One GET that follows redirects by hand, so every hop passes the same
 * public-address check as the first, and credentials never go to another origin.
 */
export async function request(url: string, init: { agent: string; headers?: Readonly<Record<string, string>>; signal: AbortSignal; fetcher?: Fetcher }): Promise<Checked> {
	const fetcher = init.fetcher ?? fetch;
	const first = parseUrl(url);
	let current = first.href;
	let headers: Record<string, string> = { "User-Agent": init.agent, "Accept-Language": "en-US,en;q=0.8", ...init.headers };
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetcher(current, { redirect: "manual", signal: init.signal, headers });
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			void response.body?.cancel();
			const next = parseUrl(new URL(location, current).href);
			if (next.origin !== first.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !CREDENTIAL_HEADERS.test(key)));
			current = next.href;
			continue;
		}
		return { response, url: current };
	}
	throw new HttpError(`Too many redirects from ${url}`, 310);
}

async function once(url: string, agent: string, options: GetOptions, signal: AbortSignal): Promise<HttpResult> {
	const { response, url: final } = await request(url, { agent, headers: options.headers, signal, fetcher: options.fetcher });
	const body = (await readBytes(response, options.maxBytes ?? MAX_BODY_BYTES)).toString("utf8");
	return { status: response.status, url: final, contentType: response.headers.get("content-type") ?? "", body };
}

const okay = (result: HttpResult) => result.status >= 200 && result.status < 300;

/** The caller's signal joined to a timeout. */
export function deadline(signal: AbortSignal | undefined, ms = TIMEOUT_MS): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** GET with each user agent in turn; the last failure is thrown when none is accepted. */
export async function get(url: string, options: GetOptions = {}): Promise<HttpResult> {
	const agents = options.agents?.length ? options.agents : [PLAIN_UA];
	const accept = options.accept ?? okay;
	const signal = deadline(options.signal);
	let last: HttpResult | undefined;
	for (const agent of agents) {
		last = await once(url, agent, options, signal);
		if (accept(last)) return last;
	}
	const status = last?.status ?? 0;
	throw new HttpError(`${new URL(url).hostname} answered HTTP ${status}${status === 429 ? " (rate limited; try again later)" : ""}`, status);
}

export async function getJson<T = unknown>(url: string, options: GetOptions = {}): Promise<T> {
	const result = await get(url, { ...options, headers: { Accept: "application/json", ...options.headers }, accept: options.accept ?? ((r) => okay(r) && looksJson(r)) });
	try {
		return JSON.parse(result.body) as T;
	} catch {
		throw new HttpError(`${new URL(url).hostname} did not return JSON`, result.status);
	}
}

export function looksJson(result: HttpResult): boolean {
	return /json/i.test(result.contentType) || /^\s*[[{]/.test(result.body);
}
