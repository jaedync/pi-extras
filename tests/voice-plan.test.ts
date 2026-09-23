import { test } from "node:test";
import assert from "node:assert/strict";
import { activeTier, backendOptions, backendSummary, chooseThreads, describeOption, plannedTiers, wantedTiers, type HardwareFacts } from "../lib/voice/plan.ts";

const GB = 1024 ** 3;
const mac: HardwareFacts = { platform: "darwin", arch: "arm64", totalMemBytes: 32 * GB, cpus: 10 };
const wsl: HardwareFacts = { platform: "linux", arch: "x64", totalMemBytes: 15 * GB, cpus: 24 };
const tiny: HardwareFacts = { platform: "linux", arch: "x64", totalMemBytes: 4 * GB, cpus: 2 };

test("small CPU tier is always provisioned first as the universal floor", () => {
	for (const facts of [mac, wsl, tiny]) assert.equal(plannedTiers(facts)[0], "cpu-small");
});

test("Macs upgrade to CPU Parakeet v3 like everyone else; MLX is opt-in", () => {
	// Same model: MLX measured 35-46x realtime against 26-33x on CPU, for a 2.5 GB download instead of 487 MB.
	assert.deepEqual(plannedTiers(mac), ["cpu-small", "cpu-large"]);
	assert.deepEqual(plannedTiers({ ...mac, arch: "x64" }), ["cpu-small", "cpu-large"]);
});

test("wanted tiers add the user's pick and skip CPU v3 when MLX v3 is already installed", () => {
	assert.deepEqual(wantedTiers(mac, {}), ["cpu-small", "cpu-large"]);
	assert.deepEqual(wantedTiers(mac, { mlx: { ready: true, dir: "/m" } }), ["cpu-small"]);
	assert.deepEqual(wantedTiers(mac, { preferred: "mlx" }), ["cpu-small", "cpu-large", "mlx"], "an interrupted opt-in resumes");
	assert.deepEqual(wantedTiers(mac, { mlx: { ready: true, dir: "/m" }, preferred: "cpu-large" }), ["cpu-small", "cpu-large"]);
	assert.deepEqual(wantedTiers(mac, {}, ["mlx"]), ["cpu-small", "cpu-large", "mlx"]);
	assert.deepEqual(wantedTiers(tiny, { preferred: "mlx" }), ["cpu-small"], "never a tier the hardware cannot run");
});

test("large CPU model requires at least 8 GB of RAM", () => {
	assert.deepEqual(plannedTiers(wsl), ["cpu-small", "cpu-large"]);
	assert.deepEqual(plannedTiers(tiny), ["cpu-small"]);
});

test("threads cap at four and never drop below one", () => {
	assert.equal(chooseThreads(24), 4);
	assert.equal(chooseThreads(10), 4);
	assert.equal(chooseThreads(2), 2);
	assert.equal(chooseThreads(0), 1);
});

test("backends report hardware support and install state", () => {
	const macOptions = backendOptions(mac, { mlx: { ready: true, dir: "/m" } });
	assert.deepEqual(
		macOptions.map((option) => [option.tier, option.available, option.ready]),
		[["mlx", true, true], ["cpu-large", true, false], ["cpu-small", true, false]],
	);
	const tinyOptions = backendOptions(tiny, {});
	const note = (tier: string) => tinyOptions.find((option) => option.tier === tier)!.note;
	assert.equal(tinyOptions.find((option) => option.tier === "mlx")!.available, false);
	assert.match(note("mlx")!, /Apple Silicon/);
	assert.equal(tinyOptions.find((option) => option.tier === "cpu-large")!.available, false);
	assert.match(note("cpu-large")!, /8 GB/);
	assert.equal(tinyOptions.find((option) => option.tier === "cpu-small")!.available, true);
});

test("the model picker offers only runnable backends", () => {
	assert.deepEqual(backendOptions(mac, {}).filter((option) => option.available).map((option) => option.tier), ["mlx", "cpu-large", "cpu-small"]);
	assert.deepEqual(backendOptions(tiny, {}).filter((option) => option.available).map((option) => option.tier), ["cpu-small"]);
});

test("a chosen backend wins while installed, otherwise the best ready one does", () => {
	const ready = ["cpu-small", "mlx"] as const;
	assert.equal(activeTier(undefined, ready), "mlx");
	assert.equal(activeTier("auto", ready), "mlx");
	assert.equal(activeTier("cpu-small", ready), "cpu-small");
	assert.equal(activeTier("cpu-large", ready), "mlx", "not installed, so fall back");
	assert.equal(activeTier("auto", []), undefined);
});

test("the summary names the backend selected and what is missing", () => {
	const text = backendSummary(mac, { "cpu-small": { ready: true, dir: "/m" } }).join("\n");
	assert.match(text, /· MLX Parakeet v3 on the Apple GPU \(download 2\.5 GB\)/);
	assert.match(text, /✓ CPU Parakeet 110M, English only \(selected\)/);
	assert.match(text, /· CPU Parakeet v3, 25 languages \(download 487 MB\)/);
	assert.ok(!/—/.test(text), "no em dashes");
	assert.equal(
		describeOption({ tier: "mlx", label: "MLX", size: "2.5 GB", available: false, ready: false, note: "needs an Apple Silicon Mac" }),
		"MLX (needs an Apple Silicon Mac)",
	);
});
