import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { CONTROL_SERVICE, DATA_SERVICE, RELAY_SCRIPT, RELAY_VERSION, controlRequest, readControlReply } from "../lib/windows-use/relay.ts";

const python = spawnSync("python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
const [major = 0, minor = 0] = python.stdout?.trim().split(".").map(Number) ?? [];
const skip = python.error || python.status !== 0 || major < 3 || (major === 3 && minor < 8) ? "python3 >=3.8 is required" : false;
const KEY = "a".repeat(64);
const NEXT_KEY = "b".repeat(64);
const script = new URL("../lib/windows-use/guest-relay.py", import.meta.url);
const configText = (port: number, key = KEY) => `[server]\ntransport = "streamable-http"\nhost = "127.0.0.1"\nport = ${port}\nauth_key = "${key}"\nstateless_http = true\n`;

async function upstream(t: TestContext, handle: (socket: Socket) => void = (socket) => socket.pipe(socket)) {
	const sockets = new Set<Socket>();
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		handle(socket);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { port: address.port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function relay(t: TestContext, port: number, restart = false) {
	const dir = await mkdtemp(join(tmpdir(), "windows-relay-"));
	// Runs after the relay's own cleanup below: hooks run in the order they were added,
	// and a relay still logging would leave the directory non-empty.
	const removeDir = () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	const config = join(dir, "config.toml");
	const marker = join(dir, "restart.txt");
	await writeFile(config, configText(port));
	const child = spawn("python3", [script.pathname, "--config", config, "--tcp-test", ...(restart ? ["--test-restart-log", marker] : [])], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
	const exited = once(child, "exit");
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
	t.after(removeDir);
	const lines = createInterface({ input: child.stdout });
	t.after(() => lines.close());
	const first = await Promise.race([
		once(lines, "line").then(([line]) => JSON.parse(String(line)) as { data: number; control: number }),
		exited.then(([code]) => { throw new Error(`relay exited ${code}: ${stderr}`); }),
		new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("relay startup timed out")), 5000); timer.unref(); t.after(() => clearTimeout(timer)); }),
	]);
	assert.ok(Number.isInteger(first.data) && Number.isInteger(first.control));
	return { ...first, config, marker, child };
}

async function socket(t: TestContext, port: number) {
	const client = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
	client.on("error", () => {});
	t.after(() => client.destroy());
	await once(client, "connect");
	return client;
}

async function exchange(t: TestContext, port: number, bytes: string | Buffer) {
	const client = await socket(t, port);
	const chunks: Buffer[] = [];
	client.on("data", (data: Buffer) => chunks.push(data));
	// A refusal closes without reading request bytes, so TCP may reset after its reply.
	const closed = new Promise<void>((resolve, reject) => {
		client.once("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
		client.once("close", () => resolve());
		client.once("end", () => { client.end(); });
	});
	client.end(bytes);
	await closed;
	assert.ok(chunks.length > 0, "the relay delivers a status/reply before closing");
	return Buffer.concat(chunks);
}

async function control(t: TestContext, port: number, key = KEY, op: "ping" | "session" | "restart" = "ping") {
	return readControlReply((await exchange(t, port, controlRequest(key, op))).toString());
}

function integration(name: string, fn: (t: TestContext) => Promise<void>) { test(name, { skip, timeout: 15_000 }, fn); }

integration("relay sends status before bytes and preserves a reply after client half-close", async (t) => {
	const server = await upstream(t, (peer) => {
		const chunks: Buffer[] = [];
		peer.on("data", (data: Buffer) => { chunks.push(data); peer.write(data); });
		peer.on("end", () => peer.end(`after EOF:${Buffer.concat(chunks).toString()}`));
	});
	const r = await relay(t, server.port);
	assert.deepEqual(await exchange(t, r.data, "hello"), Buffer.concat([Buffer.from([1]), Buffer.from("helloafter EOF:hello")]));
});

integration("unavailable upstream refuses without forwarding host bytes", async (t) => {
	const server = await upstream(t);
	await server.close();
	const r = await relay(t, server.port);
	const reply = await exchange(t, r.data, "never forward");
	assert.equal(reply[0], 0);
	assert.match(reply.subarray(1).toString(), /Windows-MCP is not listening on 127\.0\.0\.1:/);
});

integration("control authenticates, validates, and reports live upstream availability", async (t) => {
	const server = await upstream(t);
	const r = await relay(t, server.port);
	const ping = await control(t, r.control);
	assert.ok(ping.ok && "relay" in ping);
	assert.equal(ping.relay, 1);
	assert.equal(ping.pid, r.child.pid);
	assert.equal(ping.listening, true);
	assert.ok(ping.uptime >= 0);
	assert.deepEqual(await control(t, r.control, NEXT_KEY), { ok: false, error: "unauthorized" });
	assert.deepEqual(JSON.parse((await exchange(t, r.control, '{"key":"\\ud800","op":"ping"}\n')).toString()), { ok: false, error: "unauthorized" });
	for (const request of ["{\n", "[]\n", "{\"op\":\"ping\"}\n", JSON.stringify({ key: KEY, op: "unknown" }) + "\n", "x".repeat(4097) + "\n"]) {
		const reply = JSON.parse((await exchange(t, r.control, request)).toString());
		assert.equal(reply.ok, false);
		assert.ok(["bad request", "unauthorized", "unknown op"].includes(reply.error));
	}
	await server.close();
	const down = await control(t, r.control);
	assert.ok(down.ok && "listening" in down && !down.listening);
});

integration("config rotation invalidates the old key, and invalid/missing config fails closed", async (t) => {
	const server = await upstream(t);
	const r = await relay(t, server.port);
	await writeFile(r.config, configText(server.port, NEXT_KEY));
	const later = new Date(Date.now() + 2000);
	await utimes(r.config, later, later);
	assert.ok((await control(t, r.control, NEXT_KEY)).ok);
	assert.deepEqual(await control(t, r.control), { ok: false, error: "unauthorized" });
	for (const invalid of ["[server]\nport = 0\nauth_key = \"bad\"\n", "[other]\nport = 8000\nauth_key = \"" + KEY + "\"\n", configText(server.port) + 'auth_key = "invalid duplicate"\n']) {
		await writeFile(r.config, invalid);
		assert.deepEqual(await control(t, r.control), { ok: false, error: "relay config unreadable" });
		assert.equal((await exchange(t, r.data, "no"))[0], 0);
	}
	await rm(r.config);
	assert.deepEqual(await control(t, r.control), { ok: false, error: "relay config unreadable" });
	await writeFile(r.config, configText(server.port));
	assert.ok((await control(t, r.control)).ok);
});

integration("test restart writes only the requested marker and is otherwise unavailable", async (t) => {
	const server = await upstream(t);
	const r = await relay(t, server.port, true);
	assert.deepEqual(await control(t, r.control, KEY, "restart"), { ok: true, steps: [] });
	assert.equal(await readFile(r.marker, "utf8"), "restart\n");
	const noRestart = await relay(t, server.port);
	assert.deepEqual(await control(t, noRestart.control, KEY, "restart"), { ok: false, error: "restart unavailable" });
});

integration("ten concurrent data streams round-trip independently", async (t) => {
	const server = await upstream(t);
	const r = await relay(t, server.port);
	await Promise.all(Array.from({ length: 10 }, async (_, i) => {
		const payload = Buffer.from(`stream ${i}`);
		assert.deepEqual(await exchange(t, r.data, payload), Buffer.concat([Buffer.from([1]), payload]));
	}));
});

integration("five MiB round-trips without truncation or duplex deadlock", async (t) => {
	const server = await upstream(t);
	const r = await relay(t, server.port);
	const payload = Buffer.alloc(5 * 1024 * 1024, 0x87);
	assert.deepEqual(await exchange(t, r.data, payload), Buffer.concat([Buffer.from([1]), payload]));
});

integration("abrupt client resets do not stop either listener", async (t) => {
	const server = await upstream(t);
	const r = await relay(t, server.port);
	await Promise.all(Array.from({ length: 10 }, async () => {
		const client = await socket(t, r.data);
		client.write("interrupted");
		client.resetAndDestroy();
	}));
	assert.ok((await control(t, r.control)).ok);
	assert.deepEqual(await exchange(t, r.data, "alive"), Buffer.concat([Buffer.from([1]), Buffer.from("alive")]));
});

integration("session queries on non-Windows fail explicitly", async (t) => {
	if (process.platform === "win32") { t.skip("non-Windows contract"); return; }
	const server = await upstream(t);
	const r = await relay(t, server.port);
	assert.deepEqual(await control(t, r.control, KEY, "session"), { ok: false, error: "session query needs Windows" });
});

integration("the global 64-connection cap refuses both services and recovers capacity", async (t) => {
	const server = await upstream(t, () => {});
	const r = await relay(t, server.port);
	const clients: Socket[] = [];
	for (let i = 0; i < 64; i++) {
		const client = await socket(t, r.data);
		const [status] = await once(client, "data");
		assert.deepEqual(status, Buffer.from([1]));
		clients.push(client);
	}
	assert.deepEqual(await exchange(t, r.data, ""), Buffer.concat([Buffer.from([0]), Buffer.from("relay busy")]));
	assert.deepEqual(await control(t, r.control), { ok: false, error: "relay busy" });
	for (const client of clients) client.resetAndDestroy();
	for (let i = 0; i < 100; i++) {
		const result = await control(t, r.control);
		if (result.ok) return;
		assert.equal(result.error, "relay busy");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("capacity was not released after disconnects");
});

integration("relay logging rotates and never includes an authentication key", async (t) => {
	const server = await upstream(t);
	await server.close();
	const r = await relay(t, server.port);
	const log = join(r.config, "..", "relay.log");
	const seed = ".".repeat(1024 * 1024 + 1);
	await writeFile(log, seed);
	assert.equal((await exchange(t, r.data, ""))[0], 0);
	assert.equal(await readFile(log + ".1", "utf8"), seed);
	const text = await readFile(log, "utf8");
	assert.match(text, /Windows-MCP is not listening/);
	assert.ok(!text.includes(KEY));
	await rm(log);
	await mkdir(log);
	assert.equal((await exchange(t, r.data, ""))[0], 0);
	assert.ok((await control(t, r.control)).ok, "a logging failure cannot kill the relay");
});

integration("production mode exits 2 when AF_HYPERV is unavailable", async (t) => {
	if (process.platform === "win32") { t.skip("AF_HYPERV may be available"); return; }
	const dir = await mkdtemp(join(tmpdir(), "windows-relay-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const result = spawnSync("python3", [script.pathname, "--config", join(dir, "config.toml")], { encoding: "utf8", timeout: 5000 });
	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.match(await readFile(join(dir, "relay.log"), "utf8"), /AF_HYPERV unavailable/);
});

test("relay protocol constants match the shipped Python source", () => {
	assert.ok(RELAY_SCRIPT.includes(`DATA_SERVICE = "${DATA_SERVICE}"`));
	assert.ok(RELAY_SCRIPT.includes(`CONTROL_SERVICE = "${CONTROL_SERVICE}"`));
	assert.ok(RELAY_SCRIPT.includes(`RELAY_VERSION = ${RELAY_VERSION}`));
	assert.equal(controlRequest("synthetic", "session"), '{"key":"synthetic","op":"session"}\n');
});

test("control replies have validated discriminated shapes and reject malformed success", () => {
	const ping = { ok: true, relay: 1, pid: 2, listening: false, uptime: 0.5 };
	const session = { ok: true, session: { id: 1, console: 0xffffffff, state: 4, locked: true, elevated: false } };
	const restart = { ok: true, steps: [{ step: "end", code: 1 }, { step: "kill", code: 128 }, { step: "run", code: 0 }] };
	for (const value of [ping, session, restart, { ok: false, error: "unauthorized" }]) assert.deepEqual(readControlReply(JSON.stringify(value) + "\n"), value);
	for (const value of [null, [], true, {}, { ok: true }, { ...ping, relay: 2 }, { ...ping, pid: 0 }, { ...ping, uptime: -1 }, { ...ping, listening: 1 }, { ok: false, error: 1 }, { ok: true, session: { ...session.session, state: 10 } }, { ok: true, session: { ...session.session, locked: 0 } }, { ok: true, steps: [{ step: "unknown", code: 0 }] }, { ok: true, steps: [{ step: ["end"], code: 0 }, { step: "kill", code: 0 }, { step: "run", code: 0 }] }, { ok: true, steps: [{ step: "run", code: 0.1 }] }, { ...ping, steps: [] }]) {
		assert.throws(() => readControlReply(JSON.stringify(value)), /control reply/i);
	}
	for (const text of ["{", "{}\n{}", " ", JSON.stringify(ping) + "\n\n"]) assert.throws(() => readControlReply(text), /control reply/i);
});
