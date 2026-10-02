/**
 * Past a minute every row writes a duration the same way: its two coarsest
 * units run together, `24m23s` then `1h50m`. Seconds stop mattering once
 * hours start, and a run-together pair never reads as a fraction beside
 * another time.
 */
export function minutesAndUp(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds < 3_600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`;
	return `${Math.floor(seconds / 3_600)}h${pad(Math.floor((seconds % 3_600) / 60))}m`;
}

const pad = (value: number): string => String(value).padStart(2, "0");
