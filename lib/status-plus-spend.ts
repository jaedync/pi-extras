/** Compact airtime/charge text, anchored at the money cell's left edge. */
import { padStartVisible, visibleWidth } from "./ansi.ts";
import { formatDuration, formatMoney, formatMoneyLike } from "./status-plus-logic.ts";

const INCREMENT_WIDTH = 10;
const SMALL_CHARGE = 0.1;
const SIGNIFICANT_DIGITS = 2;
const MAX_FIXED_DECIMALS = 6;

/** Cents normally, two significant digits for cheap calls, scientific notation for extremes. */
export function formatIncrement(delta: number): string | undefined {
	if (!Number.isFinite(delta) || delta <= 0) return undefined;
	const decimals = delta >= SMALL_CHARGE ? 2 : SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(delta));
	const fixed = delta.toFixed(Math.min(MAX_FIXED_DECIMALS, decimals));
	const text = `+$${fixed}`;
	return decimals <= MAX_FIXED_DECIMALS && Number(fixed) > 0 && text.length <= INCREMENT_WIDTH
		? text
		: `+$${delta.toExponential(SIGNIFICANT_DIGITS - 1)}`;
}

export function spendText(cost: number, settledCost: number, airtimeMs: number, compact: boolean, delta?: number): string {
	const money = padStartVisible(`$${formatMoneyLike(cost, settledCost)}`, visibleWidth(`$${formatMoney(settledCost)}`));
	const time = `${compact ? " " : " · "}${formatDuration(airtimeMs, false)}`;
	const increment = delta === undefined ? undefined : formatIncrement(delta);
	// The renderer overpaints this text without letting its width participate in layout.
	return money + (increment ? ` ${increment}` : time);
}
