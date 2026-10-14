/**
 * Where Pi compacts a session, so a context figure can say how close it is.
 *
 * Pi compacts once the context passes the window less `compaction.reserveTokens`
 * (its `shouldCompact`). A share of the whole window hides that: a 200k model
 * with a 100k reserve compacts at 50 percent. A share of this point reaches 100
 * when Pi compacts. Pi takes the window from the model a request goes to and
 * the reserve from the selected model (its per-model overrides).
 */

/** The two fields of Pi's `getCompactionSettings(model)` this needs. */
export interface CompactionLimits {
	readonly enabled: boolean;
	readonly reserveTokens: number;
}

const positive = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The context size at which Pi compacts: the window less the reserve. The
 * window when compaction is off, when the settings could not be read, or when
 * the reserve leaves nothing (Pi would compact after every reply, so the
 * window is the only figure that still means something). None without a window.
 */
export function compactionPoint(window: number | undefined, limits: CompactionLimits | undefined): number | undefined {
	if (!positive(window)) return undefined;
	const reserve = limits?.reserveTokens;
	if (!limits?.enabled || typeof reserve !== "number" || !Number.isFinite(reserve) || reserve < 0) return window;
	const point = window - reserve;
	return point > 0 ? point : window;
}

/** Percent of the compaction point; past 100 while the context is over it. */
export const contextShare = (tokens: number, point: number | undefined): number | undefined => (positive(point) ? (100 * tokens) / point : undefined);
