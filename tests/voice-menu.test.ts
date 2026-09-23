import { test } from "node:test";
import assert from "node:assert/strict";
import { alignRows, menuItems, modelChoices, modelSummary, SUBCOMMANDS } from "../lib/voice/menu.ts";
import type { HardwareFacts } from "../lib/voice/plan.ts";

const GB = 1024 ** 3;
const mac: HardwareFacts = { platform: "darwin", arch: "arm64", totalMemBytes: 32 * GB, cpus: 10 };
const both = { "cpu-small": { ready: true, dir: "/s" }, mlx: { ready: true, dir: "/m" } } as const;

test("automatic names the model it resolves to", () => {
	assert.equal(modelSummary(both), "Automatic, using MLX Parakeet v3");
	assert.equal(modelSummary({ ...both, preferred: "auto" }), "Automatic, using MLX Parakeet v3");
	assert.equal(modelSummary({ "cpu-small": both["cpu-small"] }), "Automatic, using CPU Parakeet 110M");
	assert.equal(modelSummary({}), "Automatic (nothing installed yet)");
});

test("a pinned model is named, and says what runs meanwhile when it is not installed", () => {
	assert.equal(modelSummary({ ...both, preferred: "cpu-small" }), "CPU Parakeet 110M");
	assert.equal(
		modelSummary({ "cpu-small": both["cpu-small"], preferred: "mlx" }),
		"MLX Parakeet v3, not installed yet (using CPU Parakeet 110M)",
	);
});

test("model choices lead with automatic, show what it resolves to, and tick the current one", () => {
	const choices = modelChoices(mac, both);
	assert.deepEqual(choices.map((c) => c.value), ["auto", "mlx", "cpu-large", "cpu-small"]);
	assert.equal(choices[0]!.label, "✓ Automatic (now MLX Parakeet v3)");
	assert.equal(choices[1]!.label, "  MLX Parakeet v3 on the Apple GPU (installed)");
	assert.equal(choices[2]!.label, "  CPU Parakeet v3, 25 languages (download 487 MB)");
	const pinned = modelChoices(mac, { ...both, preferred: "cpu-small" });
	assert.ok(pinned[0]!.label.startsWith("  Automatic"));
	assert.ok(pinned[3]!.label.startsWith("✓ CPU Parakeet 110M"));
});

test("backends the hardware cannot run are not offered", () => {
	const intel = { ...mac, arch: "x64" };
	assert.ok(!modelChoices(intel, both).some((c) => c.value === "mlx"));
});

test("the menu shows current values and offers unload only while running", () => {
	const items = menuItems({ key: "ctrl+space", mic: "MacBook Pro Microphone (system default)", model: "Automatic, using MLX Parakeet v3", running: false });
	assert.deepEqual(items.map((i) => i.label), [
		"Dictate (ctrl+space)",
		"Microphone: MacBook Pro Microphone (system default)",
		"Model: Automatic, using MLX Parakeet v3",
		"Status",
		"Repair setup",
	]);
	assert.deepEqual(items.map((i) => i.action), ["dictate", "mic", "model", "status", "setup"]);
	const running = menuItems({ key: "ctrl+space", mic: "m", model: "x", running: true });
	assert.equal(running.at(-1)!.action, "unload");
});

test("every menu action except dictate is also a described subcommand", () => {
	assert.deepEqual(SUBCOMMANDS.map((c) => c.value), ["mic", "model", "status", "setup", "unload"]);
	for (const command of SUBCOMMANDS) assert.ok(command.description, command.value);
});

test("status rows are aligned into columns", () => {
	assert.deepEqual(alignRows([["key", "ctrl+space"], ["model", "mlx"]]), ["key    ctrl+space", "model  mlx"]);
});
