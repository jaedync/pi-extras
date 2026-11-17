/** Code-point order: the same on every runner, unlike localeCompare, which depends on the locale. */
export function byCodePoint(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Nearest-rank percentile: the smallest value with at least p percent of the values at or below it.
 * Nearest rank returns a real observed duration, which a reader can find in the run list.
 * @param {number[]} values @param {number} p
 * @returns {number | undefined}
 */
export function percentile(values, p) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
	return sorted[rank - 1];
}

/** @param {number[]} values */
export function p50p95(values) {
	return { p50: percentile(values, 50), p95: percentile(values, 95) };
}

/** Lower median, or the fallback for no values. @param {number[]} values @param {number} fallback */
export function lowerMedian(values, fallback) {
	if (values.length === 0) return fallback;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}
