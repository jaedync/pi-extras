import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIncrement, spendText } from "../lib/status-plus-spend.ts";

test("increments retain small charges with two significant digits and bounded width", () => {
	for (const [amount, expected] of [[0.14, "+$0.14"], [0.043, "+$0.043"], [0.00093, "+$0.00093"], [0.000093, "+$0.000093"], [0.0000093, "+$9.3e-6"], [0.000000001, "+$1.0e-9"], [0.1, "+$0.10"]] as const) {
		assert.equal(formatIncrement(amount), expected);
	}
	for (const amount of [Number.MIN_VALUE, 1e-20, 0.0000093, 999999999, Number.MAX_VALUE]) {
		const text = formatIncrement(amount);
		assert.ok(text.length <= 10, text);
		assert.ok(Number(text.slice(2)) > 0, text);
	}
	for (const amount of [0, -1, NaN, Infinity]) assert.equal(formatIncrement(amount), undefined);
});

test("time and delta hug their content, with no dot during a charge", () => {
	for (const compact of [false, true]) {
		const idle = spendText(0.59, 0.59, 0, compact);
		for (const delta of [0.043, 0.00093, 0.000093, 1e-20, 12000]) {
			const active = spendText(0.59, 0.59, 0, compact, delta);
			assert.equal(active, `$0.59 ${formatIncrement(delta)}`);
			assert.ok(!active.includes("·"));
		}
		assert.equal(idle, compact ? "$0.59 0m" : "$0.59 · 0m");
	}
});
