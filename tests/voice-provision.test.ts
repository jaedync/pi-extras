import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireLock,
	downloadVerified,
	findHfSnapshot,
	parseUvVersion,
	pruneMissingTiers,
	provisioningComplete,
	readTiers,
	skipReason,
	uvIsRecentEnough,
	voiceHome,
	writeTiers,
} from "../lib/voice/provision.ts";

async function withTemp(fn: (dir: string) => unknown): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pv-prov-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function serve(body: Buffer) {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-length": body.length });
		res.end(body);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return { url: `http://127.0.0.1:${port}/file`, close: () => server.close() };
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("voice home honours PI_VOICE_HOME, then XDG_CACHE_HOME", () => {
	assert.equal(voiceHome({ PI_VOICE_HOME: "/x/v" }, "/home/u"), "/x/v");
	assert.equal(voiceHome({ XDG_CACHE_HOME: "/c" }, "/home/u"), "/c/pi-extras/voice");
	assert.equal(voiceHome({}, "/home/u"), "/home/u/.cache/pi-extras/voice");
});

test("verified download lands atomically and reports progress", async () => {
	await withTemp(async (dir) => {
		const body = Buffer.alloc(300_000, 7);
		const server = await serve(body);
		try {
			const seen: number[] = [];
			const dest = join(dir, "out.bin");
			await downloadVerified({ url: server.url, sha256: sha(body), bytes: body.length }, dest, (f) => seen.push(f));
			assert.deepEqual(readFileSync(dest), body);
			assert.equal(seen.at(-1), 1);
			assert.ok(seen.every((f, i) => i === 0 || f >= seen[i - 1]));
		} finally {
			server.close();
		}
	});
});

test("a digest mismatch leaves nothing behind", async () => {
	await withTemp(async (dir) => {
		const server = await serve(Buffer.from("tampered"));
		try {
			const dest = join(dir, "out.bin");
			await assert.rejects(downloadVerified({ url: server.url, sha256: "0".repeat(64), bytes: 8 }, dest, () => {}), /sha256 mismatch/);
			assert.equal(existsSync(dest), false);
			assert.equal(existsSync(`${dest}.part`), false);
		} finally {
			server.close();
		}
	});
});

test("provisioning lock is exclusive and recovers from a dead holder", async () => {
	await withTemp(async (dir) => {
		const first = acquireLock(dir);
		assert.ok(first);
		assert.equal(acquireLock(dir), undefined, "held by a live process");
		first.release();
		writeFileSync(join(dir, "provision.lock"), "999999");
		const recovered = acquireLock(dir);
		assert.ok(recovered, "stale lock from a dead pid is taken over");
		recovered.release();
	});
});

test("tiers file round-trips and tolerates garbage", async () => {
	await withTemp(async (dir) => {
		assert.deepEqual(readTiers(dir), {});
		writeFileSync(join(dir, "tiers.json"), "{nope");
		assert.deepEqual(readTiers(dir), {});
		writeTiers(dir, { python: "/p", "cpu-small": { ready: true, dir: "/m" } });
		assert.deepEqual(readTiers(dir), { python: "/p", "cpu-small": { ready: true, dir: "/m" } });
	});
});

test("an existing Hugging Face snapshot at the pinned revision is reused", async () => {
	await withTemp(async (dir) => {
		const snap = join(dir, "hub", "models--org--repo", "snapshots", "abc");
		assert.equal(findHfSnapshot({ HF_HOME: dir }, "/home/u", "org/repo", "abc", ["a.json"]), undefined);
		mkdirSync(snap, { recursive: true });
		writeFileSync(join(snap, "a.json"), "{}");
		assert.equal(findHfSnapshot({ HF_HOME: dir }, "/home/u", "org/repo", "abc", ["a.json"]), snap);
		assert.equal(findHfSnapshot({ HF_HOME: dir }, "/home/u", "org/repo", "abc", ["a.json", "b.bin"]), undefined);
		assert.equal(findHfSnapshot({ HF_HUB_CACHE: join(dir, "hub") }, "/home/u", "org/repo", "abc", ["a.json"]), snap);
	});
});

test("uv version gate", () => {
	assert.deepEqual(parseUvVersion("uv 0.10.6 (Homebrew 2026-02-01)"), [0, 10, 6]);
	assert.equal(parseUvVersion("garbage"), undefined);
	assert.equal(uvIsRecentEnough([0, 10, 6]), true);
	assert.equal(uvIsRecentEnough([0, 7, 9]), false);
	assert.equal(uvIsRecentEnough(undefined), false);
});

test("pruneMissingTiers drops deleted models and clears a stale preference", () => {
	const kept = { python: "/p", vad: "/v", preferred: "mlx", "cpu-small": { ready: true, dir: "/m" }, mlx: { ready: true, dir: "/gone" } } as const;
	const pruned = pruneMissingTiers({ ...kept }, (path) => path !== "/gone");
	assert.equal(pruned.mlx, undefined);
	assert.equal(pruned.preferred, "auto");
	assert.deepEqual(pruned["cpu-small"], { ready: true, dir: "/m" });
});

test("provisioning is complete only when every planned tier is ready on disk", async () => {
	await withTemp(async (dir) => {
		const python = join(dir, "python");
		writeFileSync(python, "");
		const small = { ready: true, dir };
		const mac = { platform: "darwin" as const, arch: "arm64", totalMemBytes: 32 * 1024 ** 3, cpus: 10 };
		assert.equal(provisioningComplete({ python, vad: python, "cpu-small": small }, mac), false, "CPU v3 still pending");
		assert.equal(provisioningComplete({ python, vad: python, "cpu-small": small, "cpu-large": small }, mac), true);
		assert.equal(provisioningComplete({ python, vad: python, "cpu-small": small, mlx: small }, mac), true, "MLX already has v3");
		assert.equal(
			provisioningComplete({ python, vad: python, "cpu-small": small, mlx: small }, mac, ["cpu-large"]),
			false,
			"a chosen extra tier is still pending",
		);
		assert.equal(
			provisioningComplete({ python, vad: python, "cpu-small": small, "cpu-large": small, preferred: "mlx" }, mac),
			false,
			"an opted-in MLX that never finished is still pending",
		);
		assert.equal(
			provisioningComplete({ python, vad: python, "cpu-small": small, mlx: { ready: true, dir: join(dir, "gone") } }, mac),
			false,
			"deleted MLX files do not count as v3",
		);
	});
});

test("an upgrade is skipped without twice its download free, and says why", () => {
	const MB = 1024 ** 2;
	assert.equal(skipReason("cpu-large", 2000 * MB, false), undefined);
	assert.equal(skipReason("cpu-large", 600 * MB, false), "CPU Parakeet v3 needs 929 MB free to install, 600 MB available");
	assert.match(skipReason("mlx", 3000 * MB, false) ?? "", /^MLX Parakeet v3 needs 5\.[0-9] GB free to install, 2\.9 GB available$/);
	assert.equal(skipReason("mlx", 1000 * MB, true), undefined, "a cached model only needs the packages");
});
