/**
 * `wv setup --music` installs the optional music kit: sfizz_render, the VCSL
 * drum and mallet maps, and the Salamander piano. The unit tests inject the
 * fetch, build and smoke steps, so they run with no network and no compiler.
 * The one test that runs the real install is gated by WV_INTEGRATION=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	MUSIC_KIT_ATTRIBUTION,
	MUSIC_KIT_DOWNLOAD_BYTES,
	formatBytes,
	publishKit,
	MUSIC_KIT_NEED_BYTES,
	MUSIC_KIT_PINS,
	MUSIC_KIT_SAMPLE_RATE,
	checkMusicKit,
	verifyCheckout,
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
import { KIT_PY_PACKAGES, musicKitPath, paths } from "../skills/walkthrough-video/scripts/lib/paths.mjs";
import { scoreNeedsKit, scoreSteps } from "../skills/walkthrough-video/scripts/film/sound.mjs";
import { venvHasModules } from "../skills/walkthrough-video/scripts/lib/setup.mjs";

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
			return { head: source.commit, submodules: [] };
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
	assert.ok(MUSIC_KIT_ATTRIBUTION.startsWith("Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0"));
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

test("kitTools names each missing tool with the fix, and passes a full PATH", async () => {
	const empty = await kitTools({ PATH: join(tmpdir(), "no-such-bin-dir") });
	assert.equal(empty.ok, false);
	assert.deepEqual(empty.items.map((item) => item.name), ["git", "cmake", "c compiler", "c++ compiler", "make or ninja"]);
	for (const item of empty.items) {
		assert.equal(item.ok, false);
		assert.match(item.fix, /install/i, `${item.name} has a fix`);
	}
	const found = await kitTools({ PATH: process.env.PATH, CC: undefined, CXX: undefined });
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
		writeFileSync(join(kit, "kit.json"), `${JSON.stringify({ version: 1, sfizz: { commit: MUSIC_KIT_PINS.sfizz.commit }, vcsl: { commit: MUSIC_KIT_PINS.vcsl.commit }, salamander: { commit: MUSIC_KIT_PINS.salamander.commit } }, null, 1)}\n`);
		const full = await checkMusicKit({ kit, smoke: passingSmoke, log: () => {} });
		assert.equal(full.ok, true, full.missing.join(", "));
		assert.deepEqual(full.items.map((item) => item.name), ["sfizz_render", "VCSL maps", "VCSL samples", "Salamander piano", "pins", "smoke render"]);
		assert.match(full.items[0].detail, /f5c6e29/);
		assert.match(full.items.find((item) => item.name === "smoke render").detail, /4 of 4/);
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
				assert.match(error.message, new RegExp(`another wv setup --music is installing the kit \\(pid ${process.pid}, started `));
				assert.match(error.message, /Wait for it to finish/);
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

test("a lock file from an earlier install is refused and left exactly as it was", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const lock = `${kit}.lock`;
		for (const content of ["", `${JSON.stringify({ pid: 2147483647, token: "earlier", started: "2026-01-01T00:00:00.000Z" })}\n`]) {
			writeFileSync(lock, content);
			const before = readFileSync(lock, "utf8");
			await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps([]) }), (error) => {
				assert.match(error.message, /a lock from an earlier install remains at /);
				assert.ok(error.message.includes(lock), "the refusal names the lock");
				assert.ok(error.message.includes(`rm -- '${lock}'`), "the refusal gives the quoted command");
				return true;
			});
			assert.equal(readFileSync(lock, "utf8"), before, "the lock is not removed or rewritten");
		}
		assert.equal(existsSync(kit), false, "the install did not start");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an install refuses an existing root and keeps the owner's files, whatever kit.json says", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		for (const [name, manifest] of [["whole", '{ "version": 1 }\n'], ["empty", "{}\n"]]) {
			const kit = join(root, name);
			mkdirSync(kit, { recursive: true });
			writeFileSync(join(kit, "kit.json"), manifest);
			writeFileSync(join(kit, "user.txt"), "keep me");
			const calls = [];
			await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps(calls) }), (error) => {
				assert.match(error.message, /sfizz_render: /, "the refusal names the first failed check item");
				assert.match(error.message, /wv does not delete or replace a kit folder/);
				assert.ok(error.message.includes(`mv -- '${kit}' '${kit}.old'`), "the refusal says how to move it aside, quoted");
				assert.match(error.message, /WV_MUSIC_KIT/, "the refusal names the override");
				return true;
			});
			assert.deepEqual(calls, [], "the refusal comes before the download");
			assert.equal(readFileSync(join(kit, "user.txt"), "utf8"), "keep me");
			assert.equal(readFileSync(join(kit, "kit.json"), "utf8"), manifest, "the manifest is not rewritten");
			assert.deepEqual(readdirSync(root).filter((entry) => entry.startsWith(`.music-kit.staging-${name}-`)), []);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publication reserves the target and removes only the empty folder that it made", () => {
	const root = mkdtempSync(join(tmpdir(), "wv-publish-"));
	try {
		const staging = join(root, "staging");
		mkdirSync(staging, { recursive: true });
		writeFileSync(join(staging, "new.txt"), "the new kit");
		const kit = join(root, "music-kit");
		// A folder that is there first is refused and keeps its inode and its file.
		mkdirSync(kit);
		writeFileSync(join(kit, "user.txt"), "keep me");
		const inode = statSync(kit).ino;
		assert.throws(() => publishKit(staging, kit), /a kit folder appeared at /);
		assert.equal(statSync(kit).ino, inode, "the folder is the same inode");
		assert.equal(readFileSync(join(kit, "user.txt"), "utf8"), "keep me");
		assert.equal(existsSync(join(staging, "new.txt")), true, "the staging folder is kept");

		// A failed rename removes the empty folder that this run reserved.
		const fresh = join(root, "fresh-kit");
		assert.throws(() => publishKit(staging, fresh, { rename: () => { throw new Error("rename failed"); } }), /rename failed/);
		assert.equal(existsSync(fresh), false, "the reserved folder is gone");
		assert.equal(existsSync(join(staging, "new.txt")), true, "the staging folder is still there for the normal cleanup");

		// The reservation is atomic: an EEXIST from mkdir refuses before any rename.
		let renamed = false;
		assert.throws(() => publishKit(staging, join(root, "racing-kit"), { mkdir: () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); }, rename: () => { renamed = true; } }), /a kit folder appeared at /);
		assert.equal(renamed, false, "no rename runs after a failed reservation");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a managed kit that fails its check is refused and stays as it was", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		mkdirSync(kit, { recursive: true });
		const manifest = `${JSON.stringify({ version: 1, sfizz: { commit: MUSIC_KIT_PINS.sfizz.commit }, vcsl: { commit: MUSIC_KIT_PINS.vcsl.commit }, salamander: { commit: MUSIC_KIT_PINS.salamander.commit } })}\n`;
		writeFileSync(join(kit, "kit.json"), manifest);
		writeFileSync(join(kit, "user.txt"), "keep me");
		const calls = [];
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps(calls) }), /wv does not delete or replace a kit folder/);
		assert.deepEqual(calls, []);
		assert.equal(readFileSync(join(kit, "kit.json"), "utf8"), manifest);
		assert.equal(readFileSync(join(kit, "user.txt"), "utf8"), "keep me");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symlink root stays a symlink and its target keeps its files", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const target = join(root, "hand-kit");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "user.txt"), "keep me");
		const link = join(root, "link-kit");
		symlinkSync(target, link, "dir");
		await assert.rejects(installMusicKit({ kit: link, log: () => {}, deps: fakeDeps([]) }), /wv does not delete or replace a kit folder/);
		assert.equal(lstatSync(link).isSymbolicLink(), true, "the root is still a link");
		assert.equal(readFileSync(join(target, "user.txt"), "utf8"), "keep me", "the link's target is untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a kit folder that appears mid-install refuses publication and keeps its files", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const calls = [];
		const base = fakeDeps(calls);
		let inode = null;
		const deps = {
			...base,
			build: async (src, bin) => {
				await base.build(src, bin);
				mkdirSync(kit, { recursive: true });
				writeFileSync(join(kit, "appeared.txt"), "someone else's kit");
				inode = statSync(kit).ino;
			},
		};
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps }), /a kit folder appeared at /);
		assert.deepEqual(readdirSync(kit), ["appeared.txt"], "the root is not changed");
		assert.equal(statSync(kit).ino, inode, "the folder is the same inode");
		assert.equal(readFileSync(join(kit, "appeared.txt"), "utf8"), "someone else's kit");
		assert.deepEqual(readdirSync(root).filter((entry) => entry.startsWith(`.music-kit.staging-music-kit-${process.pid}-`)), [], "this run's staging folder is gone");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a checkout that is not the pin is refused, and a moved submodule too", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-pin-"));
	try {
		const repo = join(root, "repo");
		mkdirSync(repo);
		const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		assert.equal(git("init", "--quiet").status, 0);
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "test");
		writeFileSync(join(repo, "file.txt"), "x");
		git("add", "file.txt");
		assert.equal(git("commit", "--quiet", "-m", "one").status, 0);
		const head = git("rev-parse", "HEAD").stdout.trim();

		await assert.rejects(verifyCheckout(repo, { name: "test source", commit: "f".repeat(40) }), (error) => {
			assert.match(error.message, /not the pinned/);
			assert.ok(error.message.includes("f".repeat(40)), "the refusal names the pin");
			assert.ok(error.message.includes(head), "the refusal names the checkout");
			return true;
		});
		const ok = await verifyCheckout(repo, { name: "test source", commit: head });
		assert.equal(ok.head, head);
		assert.deepEqual(ok.submodules, []);

		const fakeGit = async (args) => ({
			stdout: args[0] === "rev-parse" ? `${head}\n` : "+1234567890123456789012345678901234567890 Vendored (heads/main)\n",
		});
		await assert.rejects(verifyCheckout(repo, { name: "with submodules", commit: head, submodules: true }, { runGit: fakeGit }), /submodule/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the check refuses a kit.json whose pin is not the pinned commit", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		fakePassingKit(kit);
		writeFileSync(join(kit, "kit.json"), `${JSON.stringify({
			version: 1,
			sfizz: { commit: "0".repeat(40) },
			vcsl: { commit: MUSIC_KIT_PINS.vcsl.commit },
			salamander: { commit: MUSIC_KIT_PINS.salamander.commit },
		})}\n`);
		const report = await checkMusicKit({ kit, smoke: passingSmoke, log: () => {} });
		assert.equal(report.ok, false);
		assert.ok(report.missing.includes("pins"));
		const item = report.items.find((one) => one.name === "pins");
		assert.match(item.detail, /sfizz/);
		assert.match(item.detail, /0000000/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the venv probe waits through the tracked runner, so the event loop keeps running", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-probe-"));
	try {
		const python = join(root, "python");
		writeFileSync(python, "#!/bin/sh\nsleep 0.3\nexit 0\n");
		chmodSync(python, 0o755);
		let ticks = 0;
		const timer = setInterval(() => (ticks += 1), 20);
		const ok = await venvHasModules(python, ["numpy"]);
		clearInterval(timer);
		assert.equal(ok, true);
		assert.ok(ticks > 2, `the event loop ran during the probe (${ticks} ticks)`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a venv probe that hangs times out and reports no", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-probe-"));
	try {
		const python = join(root, "python");
		writeFileSync(python, "#!/bin/sh\nsleep 30\n");
		chmodSync(python, 0o755);
		const started = Date.now();
		assert.equal(await venvHasModules(python, ["numpy"], { timeoutMs: 700 }), false);
		assert.ok(Date.now() - started < 15000, `the probe gave up (${Date.now() - started} ms)`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("kitTools runs each tool: a file that cannot run is not a tool", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-tools-"));
	try {
		const dir = join(root, "bin");
		mkdirSync(dir);
		// The reviewer's case: files that exist, but cannot run.
		writeFileSync(join(dir, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o644 });
		writeFileSync(join(dir, "cmake"), "#!/bin/sh\nexit 1\n", { mode: 0o644 });
		const tools = await kitTools({ PATH: dir, CC: join(root, "no-cc"), CXX: join(root, "no-cxx") });
		assert.equal(tools.ok, false);
		const byName = Object.fromEntries(tools.items.map((item) => [item.name, item]));
		for (const name of ["git", "cmake", "c compiler", "c++ compiler", "make or ninja"]) assert.equal(byName[name].ok, false, name);
		assert.match(byName.git.detail, /cannot run|not on PATH/);
		assert.match(byName.cmake.detail, /cannot run|not on PATH/);
		for (const item of tools.items) {
			assert.match(item.fix, /apt/, `${item.name} names apt`);
			assert.match(item.fix, /dnf/, `${item.name} names dnf`);
			assert.match(item.fix, /pacman/, `${item.name} names pacman`);
			assert.match(item.fix, /xcode-select|brew|cmake\.org/, `${item.name} names the macOS fix`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("kitTools refuses a cmake older than 3.16, and passes a host with every tool", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-tools-"));
	try {
		const dir = join(root, "bin");
		mkdirSync(dir);
		writeFileSync(join(dir, "cmake"), "#!/bin/sh\necho 'cmake version 3.10.2'\nexit 0\n", { mode: 0o755 });
		const old = await kitTools({ PATH: `${dir}:${process.env.PATH}`, CC: "/bin/true", CXX: "/bin/true" });
		const cmake = old.items.find((item) => item.name === "cmake");
		assert.equal(cmake.ok, false);
		assert.match(cmake.detail, /3\.10\.2/);
		assert.match(cmake.detail, /3\.16/);

		const real = await kitTools({ PATH: process.env.PATH, CC: undefined, CXX: undefined });
		assert.equal(real.ok, true, real.items.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`).join("; "));
		assert.ok(["Ninja", "Unix Makefiles"].includes(real.generator?.name), "the check names the build generator");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("wv removes only its own staging folder and names the leftovers without deleting them", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const lookalike = join(root, ".music-kit.staging-music-kit-2147483647-ABC123");
		mkdirSync(lookalike, { recursive: true });
		writeFileSync(join(lookalike, "user-data"), "keep me");
		const other = join(root, ".music-kit.staging-other-2147483647-ABC123");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "user-data"), "keep me too");
		// A folder where the lock file goes is not wv's to remove: it refuses.
		mkdirSync(`${kit}.lock`, { recursive: true });
		writeFileSync(join(`${kit}.lock`, "user-file"), "keep me");
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps([]) }), /a lock from an earlier install remains/);
		assert.equal(readFileSync(join(`${kit}.lock`, "user-file"), "utf8"), "keep me", "the lock path is not removed");
		rmSync(`${kit}.lock`, { recursive: true, force: true });

		const log = [];
		const report = await installMusicKit({ kit, log: (line) => log.push(line), deps: fakeDeps([]) });
		assert.equal(report.ok, true, report.missing.join(", "));
		assert.equal(readFileSync(join(lookalike, "user-data"), "utf8"), "keep me", "a lookalike folder is not deleted");
		assert.equal(readFileSync(join(other, "user-data"), "utf8"), "keep me too", "another kit's folder is not deleted");
		const note = log.find((line) => line.includes("leftover staging folders from earlier installs"));
		assert.ok(note, "the install names the leftovers in a note");
		assert.ok(note.includes(lookalike), "the note names the lookalike path");
		assert.ok(!note.includes(other), "the note does not name another kit's folder");
		assert.match(note, /rm -rf -- '/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed step removes this run's staging folder", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		const calls = [];
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps(calls, { failAt: "build" }) }), /build failed/);
		assert.equal(existsSync(kit), false, "a half kit never stays on disk");
		assert.deepEqual(readdirSync(root).filter((entry) => entry.startsWith(`.music-kit.staging-music-kit-${process.pid}-`)), []);
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
		assert.deepEqual(readdirSync(root).filter((entry) => entry.startsWith(`.music-kit.staging-music-kit-${process.pid}-`)), []);
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
		assert.equal(manifest.sfizz.checkout, MUSIC_KIT_PINS.sfizz.commit, "the manifest records the verified checkout");
		assert.equal(manifest.vcsl.checkout, MUSIC_KIT_PINS.vcsl.commit);
		assert.equal(manifest.salamander.attribution, MUSIC_KIT_ATTRIBUTION, "the manifest carries the whole credit");
		assert.ok(existsSync(join(kit, "licenses", "salamander-LICENSE")), "the piano licence ships with the samples");
		assert.ok(!existsSync(join(kit, "src")), "the cloned sources do not stay in the kit");
		assert.equal(existsSync(join(kit, "samples", "salamander", ".git")), false, "the piano's git history does not stay in the kit");
		assert.deepEqual(readdirSync(root).filter((entry) => entry.startsWith(`.music-kit.staging-music-kit-${process.pid}-`)), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a kit whose samples folder is a broken symlink is refused, not replaced", async () => {
	const root = mkdtempSync(join(tmpdir(), "wv-kit-"));
	try {
		const kit = join(root, "music-kit");
		mkdirSync(kit, { recursive: true });
		writeFileSync(join(kit, "kit.json"), '{ "version": 1 }\n');
		symlinkSync(join(root, "gone"), join(kit, "samples"), "dir");
		await assert.rejects(installMusicKit({ kit, log: () => {}, deps: fakeDeps([]) }), /wv does not delete or replace a kit folder/);
		assert.equal(lstatSync(join(kit, "samples")).isSymbolicLink(), true, "the root is unchanged");
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
		assert.deepEqual(readdirSync(dirname(kit)).filter((entry) => entry.startsWith(`.music-kit.staging-${basename(kit)}-`)), [], "no staging folder stays behind");
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

test("one resolver gives setup, its check and the score the same WV_MUSIC_KIT folder", () => {
	assert.equal(paths({ WV_MUSIC_KIT: "/var/tmp/elsewhere/kit" }, "/var/tmp/fake-home").musicKit, "/var/tmp/elsewhere/kit");
	assert.equal(paths({ XDG_CACHE_HOME: "/var/tmp/cache" }, "/var/tmp/fake-home").musicKit, join("/var/tmp/cache", "pi-walkthrough-video", "music-kit"));
	const root = mkdtempSync(join(tmpdir(), "wv-kit-env-"));
	try {
		const kit = join(root, "elsewhere", "music-kit");
		fakePassingKit(kit);
		const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache"), HOME: root, WV_MUSIC_KIT: kit };
		const status = spawnSync(process.execPath, [WV, "setup", "--check"], { encoding: "utf8", env, timeout: 60000 });
		const text = `${status.stdout}\n${status.stderr}`;
		assert.match(text, /music kit \(optional\).*installed at /);
		assert.ok(text.includes(kit), "the status line reads the override folder");
		assert.ok(!text.includes(join(root, "cache", "pi-walkthrough-video", "music-kit")), "the status line does not read the cache kit");

		const checked = spawnSync(process.execPath, [WV, "setup", "--music", "--check"], { encoding: "utf8", env, timeout: 60000 });
		const checkedText = `${checked.stdout}\n${checked.stderr}`;
		assert.equal(checked.status, 1, checkedText);
		assert.ok(checkedText.includes(join(kit, "samples")), "the check reads the override folder");
		assert.ok(!checkedText.includes(join(root, "cache", "pi-walkthrough-video", "music-kit")), "the check ignores the cache kit");

		// The score reads the same variable, so the repair command in its message repairs this folder.
		const missing = join(root, "no-kit");
		const score = join(root, "score.py");
		writeFileSync(score, "from sc import *\npiano = sfz_render(PIANO, [(0.5, 60, 100, 1.0)], 'piano.wav')\n");
		const refused = spawnSync(process.execPath, [WV, "sound", "score", score, "--duration", "2", "--out", join(root, "out")], { encoding: "utf8", env: { ...env, WV_MUSIC_KIT: missing }, timeout: 60000 });
		assert.equal(refused.status, 1);
		assert.ok(`${refused.stdout}\n${refused.stderr}`.includes(missing), "the score names the override folder");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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

test("the score hands Python the resolved kit path, not the raw override", () => {
	const kit = "/var/tmp/with space/kit";
	const steps = scoreSteps({ score: "/tmp/score.py", out: "/tmp/out", cues: "", duration: 3, python: "/py", kit, env: { WV_MUSIC_KIT: "  /var/tmp/with space/kit  " } });
	for (const step of steps) assert.equal(step.env.WV_MUSIC_KIT, kit, `${step.name} gets the resolved path`);
	// A relative override is the absolute path that the resolver gives, not the raw value.
	assert.equal(musicKitPath({ WV_MUSIC_KIT: "relative/kit" }, "/var/tmp/fake-home"), resolve("relative/kit"));
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
test("the piano credit names the source, the licence URI and the changes", () => {
	const credit = MUSIC_KIT_ATTRIBUTION;
	assert.ok(credit.includes("https://github.com/sfzinstruments/SalamanderGrandPiano"), "the credit gives the source");
	assert.ok(credit.includes("https://creativecommons.org/licenses/by/3.0/"), "the credit gives a link to the licence");
	assert.match(credit, /leading silence trimmed/i, "the credit says what changed");
	assert.match(credit, /composed score/i, "the credit says how the samples are used");
	const docs = [readFileSync(join(SKILL, "references", "score.md"), "utf8"), readFileSync(join(PACKAGE, "THIRD_PARTY.md"), "utf8")];
	for (const text of docs) {
		const flat = text.replace(/\s+/g, " ");
		assert.ok(flat.includes("https://github.com/sfzinstruments/SalamanderGrandPiano"), "the docs give the source");
		assert.ok(flat.includes("https://creativecommons.org/licenses/by/3.0/"), "the docs link the licence");
		assert.match(flat, /leading silence trimmed/i);
		assert.match(flat, /composed score/i);
	}
	assert.ok(usageText("setup").includes(credit), "the setup help prints the credit in full");
});

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
