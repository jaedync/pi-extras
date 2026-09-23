import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { micChoices, micSummary, readMicSetting, resolveMic, writeMicSetting, type MicList } from "../lib/voice/mics.ts";

const list: MicList = {
	devices: ["Jaedyn’s iPhone Microphone", "MacBook Pro Microphone", "Jump Desktop Microphone"],
	systemDefault: "MacBook Pro Microphone",
};

test("no saved mic uses the system default", () => {
	assert.deepEqual(resolveMic(undefined, list), { name: "MacBook Pro Microphone" });
});

test("a saved mic that is connected is used by name", () => {
	assert.deepEqual(resolveMic("Jaedyn’s iPhone Microphone", list), { device: "Jaedyn’s iPhone Microphone", name: "Jaedyn’s iPhone Microphone" });
});

test("a saved mic that is unplugged falls back to the default and says so", () => {
	assert.deepEqual(resolveMic("USB Mic", list), { name: "MacBook Pro Microphone", missing: "USB Mic" });
});

test("without a device list the saved mic cannot be checked, so the default is used", () => {
	assert.deepEqual(resolveMic("USB Mic", { devices: [] }), { missing: "USB Mic" });
});

test("the summary names the device in use", () => {
	assert.equal(micSummary(undefined, list), "MacBook Pro Microphone (system default)");
	assert.equal(micSummary("Jump Desktop Microphone", list), "Jump Desktop Microphone");
	assert.equal(micSummary("USB Mic", list), "USB Mic, not connected (using the system default, MacBook Pro Microphone)");
	assert.equal(micSummary(undefined, { devices: [] }), "system default");
});

test("choices list the default first and tick the current one", () => {
	const choices = micChoices(undefined, list);
	assert.deepEqual(choices.map((c) => c.label), [
		"✓ System default (MacBook Pro Microphone)",
		"  Jaedyn’s iPhone Microphone",
		"  MacBook Pro Microphone",
		"  Jump Desktop Microphone",
	]);
	assert.equal(choices[0]!.value, undefined);
	assert.equal(choices[1]!.value, "Jaedyn’s iPhone Microphone");
	const pinned = micChoices("Jump Desktop Microphone", list).map((c) => c.label);
	assert.equal(pinned[0], "  System default (MacBook Pro Microphone)");
	assert.equal(pinned[3], "✓ Jump Desktop Microphone");
});

test("an unplugged saved mic stays in the list so it can be seen and replaced", () => {
	const labels = micChoices("USB Mic", list).map((c) => c.label);
	assert.equal(labels.at(-1), "✓ USB Mic (not connected)");
});

test("the mic setting round-trips and tolerates a missing or broken file", () => {
	const home = mkdtempSync(join(tmpdir(), "pv-mic-"));
	try {
		assert.equal(readMicSetting(home), undefined);
		writeMicSetting(home, "Jaedyn’s iPhone Microphone");
		assert.equal(readMicSetting(home), "Jaedyn’s iPhone Microphone");
		writeMicSetting(home, undefined);
		assert.equal(readMicSetting(home), undefined);
		assert.doesNotMatch(readFileSync(join(home, "settings.json"), "utf8"), /mic/);
		writeFileSync(join(home, "settings.json"), "{not json");
		assert.equal(readMicSetting(home), undefined);
		writeFileSync(join(home, "settings.json"), JSON.stringify({ mic: 5, other: true }));
		assert.equal(readMicSetting(home), undefined);
		writeMicSetting(home, "X");
		assert.deepEqual(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")), { mic: "X", other: true }, "other settings survive");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
