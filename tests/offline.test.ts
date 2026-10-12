import { test } from "node:test";
import assert from "node:assert/strict";
import { isOffline } from "../lib/offline.ts";

// Pi turns offline mode on only for 1, true or yes (pi-coding-agent isOfflineModeEnabled).
test("PI_OFFLINE means offline only for the values Pi itself accepts", () => {
	for (const value of ["1", "true", "TRUE", "yes", "Yes"]) assert.equal(isOffline({ PI_OFFLINE: value }), true, value);
	for (const value of [undefined, "", "0", "false", "no", "off"]) assert.equal(isOffline({ PI_OFFLINE: value }), false, String(value));
});
