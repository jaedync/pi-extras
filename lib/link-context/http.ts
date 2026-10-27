/**
 * Bounded HTTP for adapters: a size cap, a timeout joined to the caller's
 * abort signal, and a user-agent chain. Sites differ in which client they
 * serve: Reddit's JSON answers link-preview crawlers but sends a plain client
 * to a login page, so each adapter names the chain it needs and the first
 * answer that passes `accept` wins.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseUrl } from "./url.ts";

export const MAX_BODY_BYTES = 8_000_000;
export const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
/** A 429 gets one retry only when the server asks for a wait this short; a longer wait is a block, not a pause. */
const MAX_RETRY_AFTER_MS = 10_000;

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
	/** The body as read, kept only for a body that may be an image: image/* (not SVG), application/octet-stream or no content-type. */
	readonly bytes?: Buffer;
	/** The server's Retry-After, in milliseconds, when it gave one. */
	readonly retryAfter?: number;
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
	const bytes = await readBytes(response, options.maxBytes ?? MAX_BODY_BYTES);
	const retryAfter = retryDelay(response.headers.get("retry-after"));
	const contentType = response.headers.get("content-type") ?? "";
	const image = IMAGE_TYPE.test(contentType);
	const kept = image || MAYBE_IMAGE.test(contentType) ? { bytes } : {};
	return { status: response.status, url: final, contentType, body: image ? "" : bytes.toString("utf8"), ...kept, ...(retryAfter === undefined ? {} : { retryAfter }) };
}

/** Retry-After as milliseconds from now: delay seconds or an HTTP date. */
export function retryDelay(header: string | null, now = Date.now()): number | undefined {
	if (!header?.trim()) return undefined;
	if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
	const at = Date.parse(header);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** An image content-type; SVG is XML text, so it is not one. */
export const IMAGE_TYPE = /^\s*image\/(?!svg)/i;
/** A server that does not know the type of a file sends one of these. */
const MAYBE_IMAGE = /^\s*(?:application\/octet-stream\s*(?:;|$)|$)/i;

const okay = (result: HttpResult) => result.status >= 200 && result.status < 300;

/** The caller's signal joined to a timeout. */
export function deadline(signal: AbortSignal | undefined, ms = TIMEOUT_MS): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

const STATUS_NOTES: Readonly<Record<number, string>> = { 404: " (page not found)", 410: " (page not found)", 429: " (rate limited; try again later)" };

/**
 * GET with each user agent in turn; the last failure is thrown when none is
 * accepted. A connection that one agent drops can still answer the next, so
 * only the caller's abort or the time limit ends the chain early.
 */
export async function get(url: string, options: GetOptions = {}): Promise<HttpResult> {
	const agents = options.agents?.length ? options.agents : [PLAIN_UA];
	const accept = options.accept ?? okay;
	const signal = deadline(options.signal);
	let last: HttpResult | undefined;
	let failure: unknown;
	let retried = false;
	for (const agent of agents) {
		try {
			last = await once(url, agent, options, signal);
		} catch (error) {
			if (signal.aborted || error instanceof HttpError) throw error;
			failure = error;
			continue;
		}
		if (accept(last)) return last;
		if (!retried && last.status === 429 && last.retryAfter !== undefined && last.retryAfter <= MAX_RETRY_AFTER_MS) {
			retried = true;
			await sleep(last.retryAfter, undefined, { signal });
			last = await once(url, agent, options, signal);
			if (accept(last)) return last;
		}
	}
	if (!last) throw failure;
	const status = last.status;
	throw new HttpError(`${new URL(url).hostname} answered HTTP ${status}${STATUS_NOTES[status] ?? ""}`, status);
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
