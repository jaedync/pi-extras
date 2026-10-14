/**
 * Reads links for pull_link and auto-pull through one cache. An entry is a
 * finished result or a read still in flight, so a pull_link call for a link
 * that auto-pull is still reading waits for that read instead of starting a
 * second one.
 */
import { loadConfig } from "./config.ts";
import { pull, type PullDeps } from "./pull.ts";
import { parseClock, parseRange } from "./text.ts";
import type { AdapterContext, LinkConfig, Pulled, PullOptions } from "./types.ts";
import { classify, parseUrl } from "./url.ts";

const CACHE_MS = 30 * 60_000;
const CACHE_ENTRIES = 16;
export const DEFAULT_COMMENTS = 20;
export const MAX_AT = 12;
/** A video read with captions only differs from a default call's result when it has no captions, so it is kept under its own key. */
const CAPTIONS_ONLY = "#captions-only";
/** Shared reads a call waits for before it reads the link itself. */
const SHARED_ROUNDS = 2;

export interface Params {
	url: string;
	transcript?: boolean;
	frames?: number;
	range?: string;
	at?: string[];
	comments?: number;
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

export function resolveOptions(params: Params, isVideo: boolean): PullOptions {
	const at = parseTimes(params.at);
	return {
		comments: params.comments ?? (isVideo || at ? 0 : DEFAULT_COMMENTS),
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
	const context = (url: URL, params: Params, signal: AbortSignal | undefined, progress: (text: string) => void, speech = true): AdapterContext => {
		const isVideo = classify(url).kind === "video";
		const resolved = resolveOptions(params, isVideo);
		return { signal, fetcher: options.fetcher, config: (options.config ?? loadConfig)(), options: isVideo && !speech ? { ...resolved, speech: false } : resolved, progress };
	};
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
				// A failed or captions-only shared read does not answer this call; it reads the link itself.
				const shared = await waitFor(pending, signal).catch(() => {
					signal?.throwIfAborted();
					return undefined;
				});
				if (shared && !shared.speechSkipped) return { pulled: shared, cached: true };
			}
			const url = parseUrl(params.url);
			const ctx = context(url, params, signal, progress);
			const wantsVideo = params.transcript === true || (params.frames ?? 0) > 0 || !!params.at?.length;
			// Parts that failed because of the abort read as "no transcript" or "frames failed"; never keep or return them.
			const pulled = await track(key, pull(url.href, ctx, options.deps, wantsVideo), () => (signal?.aborted ? undefined : key));
			signal?.throwIfAborted();
			return { pulled, cached: false };
		},
		async readPlain(raw, signal) {
			const key = cacheKey({ url: raw });
			const kept = recall(key) ?? recall(key + CAPTIONS_ONLY);
			if (kept) return { pulled: kept, cached: true };
			const pending = entries.get(key)?.pending;
			if (pending) return { pulled: await waitFor(pending, signal), cached: true };
			const url = parseUrl(raw);
			const ctx = context(url, { url: raw }, signal, () => {}, false);
			const pulled = await track(key, pull(url.href, ctx, options.deps), (result) => (signal.aborted ? undefined : result.speechSkipped ? key + CAPTIONS_ONLY : key));
			signal.throwIfAborted();
			return { pulled, cached: false };
		},
	};
}
