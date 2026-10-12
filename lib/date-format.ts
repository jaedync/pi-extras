/**
 * Building an Intl.DateTimeFormat costs far more than formatting with one, and
 * the footer formats reset times on every frame, so each style is built once
 * per time zone and reused.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

export function dateFormat(style: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${style}\u0000${timeZone}`;
	let format = cache.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
		cache.set(key, format);
	}
	return format;
}

/** `ms` when a Date can hold it: a time past the Date range (8.64e15 ms) makes every formatter throw. */
export function dateMs(ms: number | undefined): number | undefined {
	return ms !== undefined && Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
}

/** Longer than any quota window: an epoch reset past it is a misread unit, such as microseconds. */
const MAX_RESET_AHEAD_MS = 400 * 86_400_000;

/** A reset a quota could have: one a Date can hold, at most 400 days ahead. */
export function resetTimeMs(ms: number | undefined, now = Date.now()): number | undefined {
	const valid = dateMs(ms);
	return valid !== undefined && valid - now <= MAX_RESET_AHEAD_MS ? valid : undefined;
}
