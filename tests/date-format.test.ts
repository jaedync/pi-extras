import { test } from "node:test";
import assert from "node:assert/strict";
import { resetLabel } from "../lib/status-plus-render.ts";
import { hhmm } from "../lib/status-plus-logic.ts";
import { localTime } from "../lib/usage-guard-core.ts";

/** Counts Intl.DateTimeFormat constructions while `fn` runs. */
function constructions(fn: () => void): number {
	const Real = Intl.DateTimeFormat;
	let count = 0;
	Intl.DateTimeFormat = new Proxy(Real, {
		construct(target, args) {
			count += 1;
			return Reflect.construct(target, args);
		},
	});
	try {
		fn();
	} finally {
		Intl.DateTimeFormat = Real;
	}
	return count;
}

const NOON = Date.parse("2026-07-01T17:00:00Z");
const everyFormatter = (step: number) => {
	resetLabel(NOON + step * 60_000, NOON);
	hhmm(NOON + step);
	localTime(NOON + step);
	resetLabel(NOON + step, NOON, false, "Pacific/Kiritimati");
};

// The footer formats reset times on every frame; building a formatter costs about 50x formatting.
test("date formatters are built once per time zone, not on every frame", () => {
	everyFormatter(0);
	assert.equal(constructions(() => {
		for (let step = 1; step <= 100; step++) everyFormatter(step);
	}), 0);
});

test("reset labels still change exactly on the minute", () => {
	const reset = NOON + 3 * 3_600_000;
	assert.equal(resetLabel(reset - 1, NOON), "2:59pm");
	assert.equal(resetLabel(reset, NOON), "3pm");
	assert.equal(resetLabel(reset + 59_999, NOON), "3pm");
	assert.equal(resetLabel(reset + 60_000, NOON), "3:01pm");
});
