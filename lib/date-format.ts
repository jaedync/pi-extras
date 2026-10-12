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
