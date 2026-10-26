/**
 * Reads links for pull_link and auto-pull through one cache. An entry is a
 * finished result or a read still in flight, so a pull_link call for a link
 * that auto-pull is still reading waits for that read instead of starting a
 * second one.
 */
import { loadConfig } from "./config.ts";
import { SAVE_CHARS, saveFullText } from "./full-text.ts";
import { pull, type PullDeps } from "./pull.ts";
import { parseClock, parseRange } from "./text.ts";
import type { AdapterContext, LinkConfig, Pulled, PullOptions } from "./types.ts";
import { classify, parseUrl } from "./url.ts";

const CACHE_MS = 30 * 60_000;
const CACHE_ENTRIES = 16;
export const DEFAULT_COMMENTS = 20;
/** X and Bluesky read the whole conversation by default; these caps only keep one pull finite. */
export const ALL_REPLIES = 2000;
export const ALL_QUOTES = 1000;
/** Link kinds whose adapters read replies and quote posts in full. */
const WHOLE_CONVERSATIONS = new Set(["x", "bluesky"]);
export const MAX_AT = 12;
/** A video read with captions only differs from a default call's result when it has no captions, so it is kept under its own key. */
const CAPTIONS_ONLY = "#captions-only";
/** A conversation that auto-pull's time limit cut short is kept under its own key, as a captions-only video is. */
const TIME_LIMITED = "#time-limited";
/** Auto-pull's time for the optional requests of an X or Bluesky conversation: under its wait for all links (auto.ts WAIT_MS, 15 s). */
export const AUTO_READ_MS = 10_000;
/** Shared reads a call waits for before it reads the link itself. */
const SHARED_ROUNDS = 2;

export interface Params {
	url: string;
	transcript?: boolean;
	frames?: number;
	range?: string;
	at?: string[];
	comments?: number;
	quotes?: number;
	images?: boolean;
	offset?: number;
}

export function parseTimes(at: readonly string[] | undefined): number[] | undefined {
	if (!at?.length) return undefined;
	return at.slice(0, MAX_AT).map((text) => {
		const seconds = parseClock(text);
		if (seconds === undefined || seconds < 0) throw new Error(`at: "${text}" is not a time; use forms like 4:05, 1:02:30 or 95.`);
		return seconds;
	});
}

export function resolveOptions(params: Params, isVideo: boolean, whole = false): PullOptions {
	const at = parseTimes(params.at);
	return {
		comments: params.comments ?? (isVideo || at ? 0 : whole ? ALL_REPLIES : DEFAULT_COMMENTS),
		quotes: params.quotes ?? (whole && !isVideo && !at ? ALL_QUOTES : 0),
		transcript: params.transcript ?? (isVideo && !at),
		frames: params.frames ?? 0,
		range: parseRange(params.range),
		...(at ? { at } : {}),
		images: params.images ?? true,
	};
}

export function cacheKey(params: Params): string {
	const { offset: _offset, ...rest } = params;
	return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
}

/** `promise`, or the abort of `signal` first; the promise itself goes on for its other waiters. */
export function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
	});
}

interface Entry { readonly at: number; readonly pulled?: Pulled; readonly pending?: Promise<Pulled> }

export interface Read {
	readonly pulled: Pulled;
	/** From a kept result or a read that was already running. */
	readonly cached: boolean;
}

export interface ReaderOptions {
	readonly deps?: PullDeps;
	readonly config?: () => LinkConfig;
	readonly fetcher?: typeof fetch;
	readonly now?: () => number;
	/** Folder for the whole text of long results; the default is in the link-context cache. */
	readonly saveDir?: string;
	/** Auto-pull's time for a conversation's optional requests (default AUTO_READ_MS); tests shorten it. */
	readonly autoReadMs?: number;
}

export interface LinkReader {
	/** A pull_link call: a kept result, a shared read in flight, or a new read. */
	read(params: Params, signal: AbortSignal | undefined, progress: (text: string) => void): Promise<Read>;
	/** Auto-pull: a link as a plain `pull_link({ url })` reads it, but video transcripts from captions only. */
	readPlain(url: string, signal: AbortSignal): Promise<Read>;
}

export function createReader(options: ReaderOptions = {}): LinkReader {
	const now = () => options.now?.() ?? Date.now();
	const entries = new Map<string, Entry>();
	const recall = (key: string): Pulled | undefined => {
		const entry = entries.get(key);
		if (!entry?.pulled) return undefined;
		if (now() - entry.at <= CACHE_MS) return entry.pulled;
		entries.delete(key);
		return undefined;
	};
	const remember = (key: string, pulled: Pulled) => {
		const at = now();
		entries.delete(key);
		// Reads in flight have waiters, so only finished results make room.
		const done = [...entries].filter(([, entry]) => entry.pulled);
		for (const [k, entry] of done) if (at - entry.at > CACHE_MS) entries.delete(k);
		const kept = done.filter(([k]) => entries.has(k));
		for (const [k] of kept.slice(0, Math.max(0, kept.length - CACHE_ENTRIES + 1))) entries.delete(k);
		entries.set(key, { at, pulled });
	};
	/** Puts a read in flight under `key`; when it ends, `keep` names the key for its result, or none. */
	const track = (key: string, read: Promise<Pulled>, keep: (pulled: Pulled) => string | undefined): Promise<Pulled> => {
		let pending: Promise<Pulled> | undefined;
		const settle = () => {
			if (entries.get(key)?.pending === pending) entries.delete(key);
		};
		pending = read.then((pulled) => {
			settle();
			const target = keep(pulled);
			if (target) remember(target, pulled);
			return pulled;
		}, (error: unknown) => {
			settle();
			throw error;
		});
		entries.set(key, { at: now(), pending });
		return pending;
	};
	/** A long result gets a file with its whole text; a write that fails leaves the result as it was. */
	const keepFull = (pulled: Pulled): Pulled => {
		if (pulled.markdown.length <= SAVE_CHARS) return pulled;
		try {
			return { ...pulled, saved: saveFullText(pulled, options.saveDir, now()) };
		} catch {
			return pulled;
		}
	};
	/** `plain` is auto-pull's read: captions only for a video, the shorter time limit for a conversation. */
	const context = (url: URL, params: Params, signal: AbortSignal | undefined, progress: (text: string) => void, plain = false): AdapterContext => {
		const kind = classify(url).kind;
		const isVideo = kind === "video";
		const whole = WHOLE_CONVERSATIONS.has(kind);
		const resolved = resolveOptions(params, isVideo, whole);
		const limited = plain ? { ...resolved, ...(isVideo ? { speech: false } : {}), ...(whole ? { readMs: options.autoReadMs ?? AUTO_READ_MS } : {}) } : resolved;
		return { signal, fetcher: options.fetcher, config: (options.config ?? loadConfig)(), options: limited, progress };
	};
	/** A plain read that a default call would give more of is kept under its own key, so the next pull_link call reads the link in full. */
	const plainKey = (key: string, pulled: Pulled) => (pulled.speechSkipped ? key + CAPTIONS_ONLY : pulled.timeLimited ? key + TIME_LIMITED : key);
	return {
		async read(params, signal, progress) {
			const key = cacheKey(params);
			// After a failed or captions-only shared read, another waiter may have started the full read already.
			for (let round = 0; round < SHARED_ROUNDS; round++) {
				const kept = recall(key);
				if (kept) return { pulled: kept, cached: true };
				const pending = entries.get(key)?.pending;
				if (!pending) break;
				progress("waiting for the read of this link that is already running");
				// A failed, captions-only or time-limited shared read does not answer this call; it reads the link itself.
				const shared = await waitFor(pending, signal).catch(() => {
					signal?.throwIfAborted();
					return undefined;
				});
				if (shared && !shared.speechSkipped && !shared.timeLimited) return { pulled: shared, cached: true };
			}
			const url = parseUrl(params.url);
			const ctx = context(url, params, signal, progress);
			const wantsVideo = params.transcript === true || (params.frames ?? 0) > 0 || !!params.at?.length;
			// Parts that failed because of the abort read as "no transcript" or "frames failed"; never keep or return them.
			const pulled = await track(key, pull(url.href, ctx, options.deps, wantsVideo).then(keepFull), () => (signal?.aborted ? undefined : key));
			signal?.throwIfAborted();
			return { pulled, cached: false };
		},
		async readPlain(raw, signal) {
			const key = cacheKey({ url: raw });
			const kept = recall(key) ?? recall(key + CAPTIONS_ONLY) ?? recall(key + TIME_LIMITED);
			if (kept) return { pulled: kept, cached: true };
			const pending = entries.get(key)?.pending;
			if (pending) return { pulled: await waitFor(pending, signal), cached: true };
			const url = parseUrl(raw);
			const ctx = context(url, { url: raw }, signal, () => {}, true);
			const pulled = await track(key, pull(url.href, ctx, options.deps).then(keepFull), (result) => (signal.aborted ? undefined : plainKey(key, result)));
			signal.throwIfAborted();
			return { pulled, cached: false };
		},
	};
}
