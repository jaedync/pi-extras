/**
 * `wv setup --music` installs the optional music kit: sfizz_render, the VCSL
 * drum and mallet maps, and the Salamander piano. The unit tests inject the
 * fetch, build and smoke steps, so they run with no network and no compiler.
 * The one test that runs the real install is gated by WV_INTEGRATION=1.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	MUSIC_KIT_ATTRIBUTION,
	MUSIC_KIT_NEED_BYTES,
	MUSIC_KIT_PINS,
	MUSIC_KIT_SAMPLE_RATE,
	checkMusicKit,
	installMusicKit,
	kitPaths,
	kitTools,
	musicKitCheckLine,
	musicKitStatus,
	smokeKit,
	smokeMidi,
	wavPeak,
} from "../skills/walkthrough-video/scripts/lib/music-kit.mjs";

const SKILL = fileURLToPath(new URL("../skills/walkthrough-video/", import.meta.url));
const WV = join(SKILL, "scripts/wv.mjs");

/** A WAV file of 16-bit samples, for the parser test. */
function wav16(samples, rate = 48000, channels = 2) {
	const data = Buffer.alloc(samples.length * 2);
	samples.forEach((value, index) => data.writeInt16LE(value, index * 2));
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "latin1");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8, "latin1");
	header.write("fmt ", 12, "latin1");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * channels * 2, 28);
	header.writeUInt16LE(channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "latin1");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

/** The files a passing kit has, without the sample bytes. */
function fakePassingKit(root) {
	const paths = kitPaths(root);
	mkdirSync(dirname(paths.sfizz), { recursive: true });
	writeFileSync(paths.sfizz, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	mkdirSync(dirname(paths.vcslKitSfz), { recursive: true });
	for (const file of [paths.vcslKitSfz, paths.vcslMarimbaSfz, paths.vcslGlockSfz]) writeFileSync(file, "<control>\n");
	mkdirSync(paths.vcslSamples, { recursive: true });
	for (let i = 0; i < 3; i += 1) writeFileSync(join(paths.vcslSamples, `kit__${i}.wav`), "wav");
	mkdirSync(dirname(paths.pianoSfz), { recursive: true });
	writeFileSync(paths.pianoSfz, "<control>\n");
	mkdirSync(paths.pianoSamples, { recursive: true });
	for (let i = 0; i < 3; i += 1) writeFileSync(join(paths.pianoSamples, `A0v${i}.flac`), "flac");
	return paths;
}

const passingSmoke = async () => [
	{ name: "kit", ok: true, detail: "48 kHz peak 0.51" },
	{ name: "piano", ok: true, detail: "48 kHz peak 0.44" },
	{ name: "marimba", ok: true, detail: "48 kHz peak 0.62" },
	{ name: "glock", ok: true, detail: "48 kHz peak 0.35" },
];

/** The steps that installMusicKit calls, faked: each writes the file the next step reads. */
function fakeDeps(calls, { failAt = null, smoke = passingSmoke, free = 8 * 1024 ** 3, tools = { ok: true, items: [] }, python = "/py" } = {}) {
	const step = (name) => {
		calls.push(name);
		if (failAt === name) throw new Error(`${name} failed`);
	};
	return {
		tools: () => tools,
		freeBytes: () => free,
		python: async () => python,
		fetch: async (source, dir) => {
			step(`fetch:${source.name}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "LICENSE"), `${source.name} licence`);
			if (source.name === "salamander") {
				mkdirSync(join(dir, "Samples"), { recursive: true });
				writeFileSync(join(dir, "Samples", "A0v1.flac"), "flac");
				writeFileSync(join(dir, "Salamander Grand Piano V3.sfz"), "<control>\n");
			}
		},
		build: async (src, bin) => {
			step("build");
			mkdirSync(dirname(bin), { recursive: true });
			writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		},
		generate: async (vcsl, out) => {
			step("generate");
			mkdirSync(join(out, "kit"), { recursive: true });
			for (const file of ["kit.sfz", "marimba.sfz", "glock.sfz"]) writeFileSync(join(out, file), "<control>\n");
			writeFileSync(join(out, "kit", "bd__x.wav"), "wav");
		},
		trim: async () => {
			step("trim");
		},
		smoke: async (dir) => {
			step("smoke");
			return smoke(dir);
		},
	};
}

test("the pins are the commits the hand-built kit measured", () => {
	assert.equal(MUSIC_KIT_PINS.sfizz.url, "https://github.com/sfztools/sfizz.git");
	assert.equal(MUSIC_KIT_PINS.sfizz.commit, "f5c6e29f23b8057867c08e88f5f6ac6738baa30b");
	assert.equal(MUSIC_KIT_PINS.vcsl.url, "https://github.com/sgossner/VCSL.git");
	assert.equal(MUSIC_KIT_PINS.vcsl.commit, "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e");
	assert.equal(MUSIC_KIT_PINS.salamander.url, "https://github.com/sfzinstruments/SalamanderGrandPiano.git");
	assert.match(MUSIC_KIT_PINS.salamander.commit, /^[0-9a-f]{40}$/);
	// 668 files, 713.8 MB: the tree size at that commit, from the GitHub tree API.
	assert.equal(MUSIC_KIT_PINS.salamander.bytes, 748451483);
	assert.equal(MUSIC_KIT_PINS.salamander.licence, "CC BY 3.0");
	assert.equal(MUSIC_KIT_SAMPLE_RATE, 48000);
	assert.equal(MUSIC_KIT_ATTRIBUTION, "Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0");
});

test("the VCSL fetch names every folder the maps read, and no folder the maps do not", () => {
	const folders = MUSIC_KIT_PINS.vcsl.folders;
	for (const name of ["Bass Drum 1", "Snare Drum, Modern 1", "Tom 1", "Hi-Hat Cymbal", "Suspended Cymbal 1", "Claps", "Marimba", "Glockenspiel", "Shaker, Large", "Tambourine 1"]) {
		assert.ok(folders.some((folder) => folder.includes(name)), `the VCSL sparse checkout needs ${name}`);
	}
	// make_sfz.py writes maps for the drum kit, the marimba and the glock only.
	assert.ok(!folders.some((folder) => folder.includes("Vibraphone")), "a folder no map reads must not be downloaded");
});

test("kitTools names each missing tool with the fix, and passes a full PATH", () => {
	const empty = kitTools({ PATH: join(tmpdir(), "no-such-bin-dir") });
	assert.equal(empty.ok, false);
	assert.deepEqual(empty.items.map((item) => item.name), ["git", "cmake", "c++ compiler"]);
	for (const item of empty.items) {
		assert.equal(item.ok, false);
		assert.match(item.fix, /install/i, `${item.name} has a fix`);
	}
	const found = kitTools({ PATH: process.env.PATH, CXX: undefined });
	assert.equal(found.ok, true, found.items.filter((item) => !item.ok).map((item) => item.name).join(", "));
});

test("a missing tool or too little disk refuses before anything is downloaded", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const noTools = fakeDeps([], { tools: { ok: false, items: [{ name: "cmake", ok: false, fix: "install cmake with your package manager" }] } });
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: noTools }), (error) => {
			assert.match(error.message, /cmake/);
			assert.match(error.message, /package manager/);
			assert.match(error.message, /wv setup --music/);
			return true;
		});
		const calls = [];
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps(calls, { free: 1024 ** 3 }) }), (error) => {
			assert.match(error.message, /3\.0 GB/);
			assert.match(error.message, /1\.0 GB/);
			return true;
		});
		assert.deepEqual(calls, [], "the refusal comes before the first download");
		assert.equal(existsSync(kit), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the check reports each part, and the commits from kit.json", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		mkdirSync(kit, { recursive: true });
		const empty = await checkMusicKit({ kit, smoke: passingSmoke, log: () => {} });
		assert.equal(empty.ok, false);
		assert.ok(empty.missing.includes("sfizz_render"));
		assert.ok(empty.missing.includes("VCSL samples"));
		assert.ok(empty.missing.includes("Salamander piano"));
		assert.ok(!empty.missing.includes("smoke render"), "no smoke run without a binary to run");

		fakePassingKit(kit);
		writeFileSync(join(kit, "kit.json"), `${JSON.stringify({ version: 1, sfizz: { commit: "f5c6e29" }, vcsl: { commit: "c1ea7bc" }, salamander: { commit: "3382bf9" } }, null, 1)}\n`);
		const full = await checkMusicKit({ kit, smoke: passingSmoke, log: () => {} });
		assert.equal(full.ok, true, full.missing.join(", "));
		assert.deepEqual(full.items.map((item) => item.name), ["sfizz_render", "VCSL maps", "VCSL samples", "Salamander piano", "smoke render"]);
		assert.match(full.items[0].detail, /f5c6e29/);
		assert.match(full.items[4].detail, /4 of 4/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the check accepts a kit whose samples folder is a symlink, like the first hand-built one", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const hand = fakePassingKit(join(root, "hand-kit"));
		const kit = join(root, "music-kit");
		fakePassingKit(kit);
		rmSync(join(kit, "samples"), { recursive: true, force: true });
		symlinkSync(hand.samples, join(kit, "samples"), "dir");
		const report = await checkMusicKit({ kit, smoke: passingSmoke, log: () => {} });
		assert.equal(report.ok, true, report.missing.join(", "));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed step leaves the old kit in place and removes the staging folder", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		mkdirSync(kit, { recursive: true });
		writeFileSync(join(kit, "old.txt"), "the kit before this run");
		const calls = [];
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps(calls, { failAt: "build" }) }), /build failed/);
		assert.equal(readFileSync(join(kit, "old.txt"), "utf8"), "the kit before this run");
		assert.equal(existsSync(join(root, ".music-kit.staging")), false, "a half kit never stays on disk");
		assert.ok(calls.includes("fetch:sfizz") && calls.includes("build"));
		assert.ok(!calls.includes("generate"), "the steps after the failure do not run");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed smoke render refuses the kit and keeps the old one", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const failing = async () => [{ name: "piano", ok: false, detail: "silent" }];
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps([], { smoke: failing }) }), /silent/);
		assert.equal(existsSync(kit), false);
		assert.equal(existsSync(join(root, ".music-kit.staging")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a passing install moves the staging folder into place and records the pins", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const calls = [];
		const report = await installMusicKit({ kit, log: () => {}, deps: fakeDeps(calls) });
		assert.equal(report.ok, true, report.missing.join(", "));
		// The last smoke is the check after the move into place.
		assert.deepEqual(calls.slice(0, 7), ["fetch:sfizz", "build", "fetch:VCSL", "fetch:salamander", "generate", "trim", "smoke"]);
		const manifest = JSON.parse(readFileSync(join(kit, "kit.json"), "utf8"));
		assert.equal(manifest.version, 1);
		assert.equal(manifest.sfizz.commit, MUSIC_KIT_PINS.sfizz.commit);
		assert.equal(manifest.salamander.commit, MUSIC_KIT_PINS.salamander.commit);
		assert.ok(existsSync(join(kit, "licenses", "salamander-LICENSE")), "the piano licence ships with the samples");
		assert.ok(!existsSync(join(kit, "src")), "the cloned sources do not stay in the kit");
		assert.equal(existsSync(join(root, ".music-kit.staging")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a kit that passes the check is not downloaded again", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		fakePassingKit(kit);
		const calls = [];
		const log = [];
		const report = await installMusicKit({ kit, log: (line) => log.push(line), deps: fakeDeps(calls) });
		assert.equal(report.ok, true);
		assert.equal(calls.filter((name) => name !== "smoke").length, 0, "the idempotent path calls no install step");
		assert.match(log.join("\n"), /already installed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the smoke MIDI is a type 0 file, and wavPeak reads rate and peak", () => {
	const midi = smokeMidi([{ t: 0.5, key: 60, vel: 100, dur: 0.4 }, { t: 1, key: 64, vel: 90, dur: 0.4 }]);
	assert.equal(midi.subarray(0, 4).toString("latin1"), "MThd");
	assert.equal(midi.readUInt32BE(4), 6);
	assert.equal(midi.readUInt16BE(8), 0, "format 0");
	assert.equal(midi.readUInt16BE(10), 1, "one track");
	assert.equal(midi.readUInt16BE(12), 960, "ticks per beat");
	assert.equal(midi.subarray(14, 18).toString("latin1"), "MTrk");
	assert.equal(midi.subarray(-4).toString("hex"), "00ff2f00", "the track ends with end-of-track");

	const wav = wavPeak(wav16([0, 1000, -2000, 500]));
	assert.equal(wav.rate, 48000);
	assert.equal(wav.channels, 2);
	assert.equal(wav.frames, 2);
	assert.equal(wav.peak, 2000 / 32768);
	assert.equal(wavPeak(Buffer.from("not a wav")).rate, null);
});

test("the setup check line says in one line whether the optional kit is there, and how to add it", () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		assert.match(musicKitCheckLine(kit), /not installed/);
		assert.match(musicKitCheckLine(kit), /wv setup --music/);
		assert.match(musicKitCheckLine(kit), /download/);
		assert.doesNotMatch(musicKitCheckLine(kit), /\n/);
		fakePassingKit(kit);
		assert.match(musicKitCheckLine(kit), /installed/);
		assert.doesNotMatch(musicKitCheckLine(kit), /\n/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the quick status reads a legacy kit without kit.json as installed", () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		fakePassingKit(kit);
		const status = musicKitStatus(kit);
		assert.equal(status.present, true);
		assert.match(status.detail, /no kit\.json/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the real smoke render runs only with WV_INTEGRATION=1 and a kit path", { skip: process.env.WV_INTEGRATION === "1" && process.env.WV_MUSIC_KIT ? false : "set WV_INTEGRATION=1 and WV_MUSIC_KIT to a kit that --check passes", timeout: 180000 }, async () => {
	const kit = process.env.WV_MUSIC_KIT;
	const report = await checkMusicKit({ kit, log: () => {} });
	assert.equal(report.ok, true, report.missing.join(", "));
	const smoke = await smokeKit(kit);
	assert.equal(smoke.length, 4);
	for (const item of smoke) assert.equal(item.ok, true, `${item.name}: ${item.detail}`);
});

const e2e = process.env.WV_INTEGRATION === "1";
test("the real install builds a kit that passes --check", { skip: e2e ? false : "set WV_INTEGRATION=1 to download about 1 GB and build sfizz", timeout: 60 * 60_000 }, async () => {
	const root = "/var/tmp/wv-music-e2e";
	const kit = join(root, "cache", "pi-walkthrough-video", "music-kit");
	const log = [];
	const report = await installMusicKit({ kit, log: (line) => log.push(line) });
	assert.equal(report.ok, true, report.missing.join(", "));
	assert.ok(log.some((line) => /already installed/.test(line)) === false);
	const again = await installMusicKit({ kit, log: (line) => log.push(line) });
	assert.equal(again.ok, true);
	assert.ok(log.some((line) => /already installed/.test(line)), "the second run reads the kit and skips the download");
});
