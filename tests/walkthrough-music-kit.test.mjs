/**
 * `wv setup --music` installs the optional music kit: sfizz_render, the VCSL
 * drum and mallet maps, and the Salamander piano. The unit tests inject the
 * fetch, build and smoke steps, so they run with no network and no compiler.
 * The one test that runs the real install is gated by WV_INTEGRATION=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	MUSIC_KIT_ATTRIBUTION,
	MUSIC_KIT_DOWNLOAD_BYTES,
	formatBytes,
	MUSIC_KIT_NEED_BYTES,
	MUSIC_KIT_PINS,
	MUSIC_KIT_SAMPLE_RATE,
	checkMusicKit,
	replaceKit,
	installMusicKit,
	kitDeps,
	kitPaths,
	kitTools,
	musicKitCheckLine,
	musicKitStatus,
	smokeKit,
	smokeMidi,
	wavPeak,
} from "../skills/walkthrough-video/scripts/lib/music-kit.mjs";
import { parseCommandLine, usageText } from "../skills/walkthrough-video/scripts/lib/args.mjs";
import { KIT_PY_PACKAGES, paths } from "../skills/walkthrough-video/scripts/lib/paths.mjs";
import { scoreNeedsKit } from "../skills/walkthrough-video/scripts/film/sound.mjs";

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
				mkdirSync(join(dir, ".git", "objects"), { recursive: true });
				writeFileSync(join(dir, ".git", "objects", "pack"), "the piano's history");
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


/** Runs a real command once, for the tool probe tests. */
function waitUntil(predicate, ms) {
	const deadline = Date.now() + ms;
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) return resolve(undefined);
			if (Date.now() > deadline) return reject(new Error("the condition did not come true in time"));
			setTimeout(tick, 25);
		};
		tick();
	});
}

/** fakeDeps that holds its first fetch until `open()`, so a second install overlaps it. */
function gatedInstall() {
	const base = fakeDeps([]);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	return { deps: { ...base, fetch: async (source, dir) => { await gate; return base.fetch(source, dir); } }, open: () => release() };
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
	// The kit's map tools and the score they serve share one venv.
	for (const name of ["numpy", "soundfile", "scipy", "mido", "pedalboard"]) assert.ok(KIT_PY_PACKAGES.some((spec) => spec.startsWith(`${name}==`)), `the kit installs ${name}`);
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

test("the free-space check reads the filesystem above a cache root that does not exist", () => {
	const bytes = kitDeps({}).freeBytes(join(tmpdir(), "wv-no-such-cache-dir", "pi-walkthrough-video"));
	assert.ok(bytes > 1024 ** 3, `a real filesystem reports its free space, got ${bytes}`);
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

test("two installs that overlap take one lock, and the second refuses", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const gate = gatedInstall();
		const first = installMusicKit({ kit, log: () => {}, deps: gate.deps });
		await waitUntil(() => existsSync(`${kit}.lock`), 10000);
		await assert.rejects(
			installMusicKit({ kit, log: () => {}, deps: fakeDeps([]) }),
			(error) => {
				assert.match(error.message, /another wv setup --music is installing the kit/);
				assert.match(error.message, new RegExp(`${kit}\\.lock`));
				return true;
			},
		);
		gate.open();
		const report = await first;
		assert.equal(report.ok, true, report.missing.join(", "));
		assert.equal(existsSync(`${kit}.lock`), false, "the lock is released after the install");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an old shared staging folder survives, and a stale lock is taken over", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const old = join(root, ".music-kit.staging");
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, "mine.txt"), "not wv's");
		mkdirSync(`${kit}.lock`, { recursive: true });
		writeFileSync(join(`${kit}.lock`, "owner"), "2147483647\n");
		const log = [];
		const report = await installMusicKit({ kit, log: (line) => log.push(line), deps: fakeDeps([]) });
		assert.equal(report.ok, true, report.missing.join(", "));
		assert.equal(readFileSync(join(old, "mine.txt"), "utf8"), "not wv's", "an install never deletes a folder it did not make");
		assert.match(log.join("\n"), /taking over the lock of pid 2147483647/, "a stale lock is reported");
		assert.equal(existsSync(`${kit}.lock`), false, "the lock is released");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an install refuses to replace a kit that wv did not make, and keeps the user's files", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		mkdirSync(join(kit, "my-scores"), { recursive: true });
		writeFileSync(join(kit, "my-scores", "theme.py"), "the owner's score");
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps([]) }), (error) => {
			assert.match(error.message, /was not installed by wv/);
			assert.match(error.message, /mv /, "the refusal says how to move it aside");
			assert.match(error.message, /WV_MUSIC_KIT=/, "the refusal names the override");
			return true;
		});
		assert.equal(readFileSync(join(kit, "my-scores", "theme.py"), "utf8"), "the owner's score");
		assert.equal(existsSync(join(root, ".music-kit.staging")), false, "this run's staging is gone");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed publication puts a managed kit back, and a symlink puts the link back", () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const staging = join(root, "staging");
		mkdirSync(staging, { recursive: true });
		writeFileSync(join(staging, "new.txt"), "the new kit");

		const kit = join(root, "music-kit");
		mkdirSync(kit, { recursive: true });
		writeFileSync(join(kit, "kit.json"), '{ "version": 1 }\n');
		writeFileSync(join(kit, "old.txt"), "the old kit");
		let moved = 0;
		assert.throws(() => replaceKit(staging, kit, { rename: (from, to) => { moved += 1; if (moved === 2) throw new Error("rename failed"); renameSync(from, to); } }), /rename failed/);
		assert.equal(readFileSync(join(kit, "old.txt"), "utf8"), "the old kit", "the managed kit is back in place");

		// A symlink root is moved aside as a link, not as its target.
		const target = join(root, "hand-kit");
		fakePassingKit(target);
		writeFileSync(join(target, "kit.json"), '{ "version": 1 }\n');
		const link = join(root, "link-kit");
		symlinkSync(target, link, "dir");
		const fresh = join(root, "staging-link");
		mkdirSync(fresh, { recursive: true });
		writeFileSync(join(fresh, "new.txt"), "the new kit");
		moved = 0;
		assert.throws(() => replaceKit(fresh, link, { rename: (from, to) => { moved += 1; if (moved === 2) throw new Error("rename failed"); renameSync(from, to); } }), /rename failed/);
		assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is restored as a link");
		assert.equal(readFileSync(join(target, "kit.json"), "utf8"), '{ "version": 1 }\n', "the link's target was never moved");
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
		assert.equal(existsSync(join(kit, "samples", "salamander", ".git")), false, "the piano's git history does not stay in the kit");
		assert.equal(existsSync(join(root, ".music-kit.staging")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an install replaces a managed kit whose samples folder is a broken symlink", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		mkdirSync(kit, { recursive: true });
		writeFileSync(join(kit, "kit.json"), '{ "version": 1 }\n');
		symlinkSync(join(root, "gone"), join(kit, "samples"), "dir");
		const report = await installMusicKit({ kit, log: () => {}, deps: fakeDeps([]) });
		assert.equal(report.ok, true, report.missing.join(", "));
		assert.equal(lstatSync(join(kit, "samples")).isSymbolicLink(), false, "the broken link is replaced by real samples");
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
test("the real install builds a kit that passes --check, and a second run skips the download", { skip: e2e ? false : "set WV_INTEGRATION=1 to download about 1 GB and build sfizz", timeout: 60 * 60_000 }, async () => {
	const root = "/var/tmp/wv-music-e2e/it";
	const previous = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, TMPDIR: process.env.TMPDIR };
	const restore = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
	process.env.XDG_CACHE_HOME = join(root, "cache");
	process.env.TMPDIR = join(root, "tmp");
	mkdirSync(process.env.TMPDIR, { recursive: true });
	try {
		const kit = paths().musicKit;
		const log = [];
		const report = await installMusicKit({ kit, log: (line) => log.push(line) });
		assert.equal(report.ok, true, report.missing.join(", "));
		assert.ok(log.some((line) => /smoke render: one MIDI pass/.test(line)), "the first run builds the kit");
		const again = [];
		const second = await installMusicKit({ kit, log: (line) => again.push(line) });
		assert.equal(second.ok, true);
		assert.ok(again.some((line) => /already installed/.test(line)), "the second run reads the kit and skips the download");
		assert.ok(existsSync(join(kit, "kit.json")));
		assert.ok(!existsSync(join(dirname(kit), ".music-kit.staging")), "no staging folder stays behind");
	} finally {
		restore("XDG_CACHE_HOME", previous.XDG_CACHE_HOME);
		restore("TMPDIR", previous.TMPDIR);
	}
});

test("setup parses --music, and the setup help names each source, commit and licence", () => {
	assert.deepEqual(parseCommandLine(["setup", "--music"]), { command: "setup", check: false, json: false, music: true });
	assert.equal(parseCommandLine(["setup", "--music", "--check"]).check, true);
	const text = usageText("setup");
	assert.match(text, /--music/);
	for (const pin of Object.values(MUSIC_KIT_PINS)) assert.ok(text.includes(pin.commit.slice(0, 7)), `the setup help names ${pin.name} at ${pin.commit.slice(0, 7)}`);
	assert.match(text, /Salamander Grand Piano V3/);
	assert.match(text, /CC BY 3\.0/);
	assert.match(text, /BSD-2-Clause/);
	assert.match(text, /CC0/);
	assert.ok(text.includes(formatBytes(MUSIC_KIT_DOWNLOAD_BYTES)), "the help names the measured download size");
	assert.match(text, /smoke render/);
});

test("wv setup without --music leaves the music kit alone, and its check names the option", () => {
	const root = mkdtempSync(join(tmpdir(), "wv-setup-"));
	try {
		const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache"), HOME: root };
		const result = spawnSync(process.execPath, [WV, "setup", "--check"], { encoding: "utf8", env, timeout: 60000 });
		const text = `${result.stdout}\n${result.stderr}`;
		assert.match(text, /music kit \(optional\)/);
		assert.match(text, /wv setup --music/);
		assert.match(text, /not installed/);
		assert.equal(existsSync(join(root, "cache", "pi-walkthrough-video", "music-kit")), false, "the default setup never creates the kit");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("wv setup --music --check reports each missing part and exits 1", () => {
	const root = mkdtempSync(join(tmpdir(), "wv-setup-"));
	try {
		const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache"), HOME: root };
		const result = spawnSync(process.execPath, [WV, "setup", "--music", "--check"], { encoding: "utf8", env, timeout: 60000 });
		assert.equal(result.status, 1);
		const text = `${result.stdout}\n${result.stderr}`;
		for (const part of ["sfizz_render", "VCSL maps", "VCSL samples", "Salamander piano"]) assert.match(text, new RegExp(part));
		assert.doesNotMatch(text, /smoke render/, "no smoke run without a binary");
		assert.equal(existsSync(join(root, "cache", "pi-walkthrough-video", "music-kit")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a score that plays a sampled part needs the kit; the synth template does not", () => {
	const template = readFileSync(join(SKILL, "templates", "score", "score.py"), "utf8");
	assert.equal(scoreNeedsKit(template), false, "the template uses synth voices only");
	assert.equal(scoreNeedsKit("kick = sfz_render(KIT + 'kit.sfz', notes, out)"), true);
	assert.equal(scoreNeedsKit("piano = sfz_render(PIANO, notes, out)"), true);
	assert.equal(scoreNeedsKit("x = load_sample('bd__BDrumNew_hit_v7_rr1_Sum.wav')"), true);
});

test("wv sound score refuses a sampled score without the kit, before it renders anything", () => {
	const root = mkdtempSync(join(tmpdir(), "wv-score-kit-"));
	try {
		const score = join(root, "score.py");
		writeFileSync(score, "from sc import *\npiano = sfz_render(PIANO, [(0.5, 60, 100, 1.0)], 'piano.wav')\n");
		const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache"), HOME: root, WV_MUSIC_KIT: "" };
		const out = join(root, "out");
		const result = spawnSync(process.execPath, [WV, "sound", "score", score, "--duration", "2", "--out", out], { encoding: "utf8", env, timeout: 60000 });
		assert.equal(result.status, 1);
		const text = `${result.stdout}\n${result.stderr}`;
		assert.match(text, /music kit/);
		assert.match(text, /wv setup --music/);
		assert.equal(existsSync(out), false, "nothing is rendered before the refusal");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const venv = paths().python;
test("sc.py refuses a sampled part with the fix when the kit is missing", { skip: existsSync(venv) ? false : "the runtime venv is not installed (run wv setup)" }, () => {
	const script = `import sys; sys.path.insert(0, ${JSON.stringify(join(SKILL, "scripts", "py", "score"))}); import sc; sc.sfz_render(sc.PIANO, [(0.5, 60, 100, 0.2)], ${JSON.stringify(join(tmpdir(), "wv-sc-kit.wav"))})`;
	// -B: this import must not write __pycache__ into the shipped skill.
	const result = spawnSync(venv, ["-B", "-c", script], { encoding: "utf8", env: { ...process.env, WV_MUSIC_KIT: join(tmpdir(), "no-such-music-kit") }, timeout: 60000 });
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /wv setup --music/);
	assert.match(result.stderr, /sampled part/);
});

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
test("the docs say how to add the kit, what it downloads, and how to credit the piano", () => {
	const score = readFileSync(join(SKILL, "references", "score.md"), "utf8");
	assert.match(score, /wv setup --music/);
	assert.doesNotMatch(score, /does not install these yet/, "the old note is gone");
	assert.match(score, /Salamander Grand Piano V3 by Alexander Holm, CC BY 3\.0/);
	assert.match(score, /714 MB|714MB|748/);
	assert.match(score, /BSD-2-Clause/);
	assert.match(score, /CC0 1\.0/);
	assert.match(score, /published film/i);
	const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
	assert.match(skill, /wv setup --music/, "the network list names the optional music download");
	const third = readFileSync(join(PACKAGE, "THIRD_PARTY.md"), "utf8");
	for (const name of ["sfizz", "BSD-2-Clause", "Salamander Grand Piano V3", "Alexander Holm", "CC BY 3.0", "VCSL", "CC0 1.0"]) assert.ok(third.includes(name), `THIRD_PARTY.md names ${name}`);
});
