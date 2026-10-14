import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionPoint, contextShare } from "../lib/compaction-point.ts";

const ON = { enabled: true, reserveTokens: 100_000 };

test("the point is the window less the reserve while compaction is on", () => {
	assert.equal(compactionPoint(200_000, ON), 100_000);
	assert.equal(compactionPoint(500_000, { enabled: true, reserveTokens: 24_576 }), 475_424);
	assert.equal(compactionPoint(200_000, { enabled: true, reserveTokens: 0 }), 200_000);
});

test("the point is the window when compaction is off or the reserve leaves nothing", () => {
	assert.equal(compactionPoint(200_000, { enabled: false, reserveTokens: 100_000 }), 200_000);
	assert.equal(compactionPoint(200_000, { enabled: true, reserveTokens: 200_000 }), 200_000, "Pi would compact at every reply; the window still means something");
	assert.equal(compactionPoint(200_000, { enabled: true, reserveTokens: 300_000 }), 200_000);
	assert.equal(compactionPoint(200_000, undefined), 200_000, "settings that could not be read");
	assert.equal(compactionPoint(200_000, { enabled: true, reserveTokens: Number.NaN }), 200_000);
	assert.equal(compactionPoint(200_000, { enabled: true, reserveTokens: -5 }), 200_000);
});

test("there is no point without a window", () => {
	assert.equal(compactionPoint(undefined, ON), undefined);
	assert.equal(compactionPoint(0, ON), undefined);
	assert.equal(compactionPoint(Number.NaN, ON), undefined);
});

test("the share is of the point and passes 100 when the context is past it", () => {
	assert.equal(contextShare(98_000, 100_000), 98);
	assert.equal(contextShare(100_000, 100_000), 100);
	assert.equal(contextShare(105_000, 100_000), 105);
	assert.equal(contextShare(0, 100_000), 0);
	assert.equal(contextShare(5_000, undefined), undefined);
	assert.equal(contextShare(5_000, 0), undefined);
});
