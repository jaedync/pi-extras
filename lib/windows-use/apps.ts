/**
 * Which Start menu app win.app launches. Windows-MCP matches the name loosely
 * and reports the name it was given, so a live run asked for "System
 * Management Console" and got Print Management, reported as launched. The name
 * is settled here first, against the guest's own list of Start menu apps.
 */

/** The guest's Start menu apps, one name per line. */
export const START_APPS = "(Get-StartApps).Name";
const MAX_LISTED = 8;

const words = (name: string) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The listed app `name` means: the one it names exactly, whatever the case, or
 * the only one holding all its words. Anything else fails with the names the
 * agent likely meant, since launching a near miss starts a program nobody asked for.
 */
export function pickApp(name: string, listed: readonly string[]): string {
	const exact = listed.find((app) => app.toLowerCase() === name.trim().toLowerCase());
	if (exact) return exact;
	const wanted = words(name);
	const score = (app: string) => { const have = words(app); return wanted.filter((word) => have.some((part) => part.startsWith(word))).length; };
	const holding = listed.filter((app) => score(app) === wanted.length);
	if (holding.length === 1) return holding[0]!;
	if (holding.length > 1) {
		throw new Error(`"${name}" matches several Start menu apps: ${[...holding].sort().slice(0, MAX_LISTED).join(", ")}. Launch one by its full name.`);
	}
	const near = listed
		.map((app) => ({ app, hits: score(app) }))
		.filter((entry) => entry.hits > 0)
		.sort((a, b) => b.hits - a.hits || a.app.length - b.app.length)
		.slice(0, MAX_LISTED)
		.map((entry) => entry.app);
	const hint = near.length ? `Nearest: ${near.join(", ")}.` : "win.powershell with Get-StartApps lists them.";
	throw new Error(`No Start menu app is named like "${name}". ${hint}`);
}
