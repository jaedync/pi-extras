/**
 * RelayChannel end to end, without Hyper-V: the real guest relay in its TCP
 * test mode, a fake Windows-MCP, and a fake tunnel process that routes each
 * Hyper-V service id to the relay's matching local port.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import type { ClientProcess } from "../lib/computer-use/mcp-link.ts";
import type { HostCalls } from "../lib/windows-use/guest.ts";
import { RelayChannel } from "../lib/windows-use/relay-channel.ts";
import { DATA_SERVICE } from "../lib/windows-use/relay.ts";
import { TransportError } from "../lib/windows-use/transport.ts";
import { encodeFrame, FrameDecoder, Tunnel } from "../lib/windows-use/tunnel.ts";

const python = spawnSync("python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
const [major = 0, minor = 0] = python.stdout?.trim().split(".").map(Number) ?? [];
const skip = python.error || python.status !== 0 || major < 3 || (major === 3 && minor < 8) ? "python3 >=3.8 is required" : false;
const VM_ID = "11111111-2222-3333-4444-555555555555";
const KEY = "c".repeat(64);
const OTHER_KEY = "d".repeat(64);
const script = new URL("../lib/windows-use/guest-relay.py", import.meta.url).pathname;

/** A tunnel process that connects each OPEN to the relay's TCP port for its service. */
class RoutingTunnel extends EventEmitter implements ClientProcess {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly opens: string[] = [];
	private readonly sockets = new Map<number, Socket>();
	constructor(ports: { data: number; control: number } | undefined) {
		super();
		const decoder = new FrameDecoder((frame) => {
			const socket = this.sockets.get(frame.stream);
			if (frame.type === 1) this.open(frame.stream, JSON.parse(frame.payload.toString()), ports);
			else if (frame.type === 2) socket?.write(frame.payload);
			else if (frame.type === 3) socket?.end();
			else if (frame.type === 4) socket?.destroy();
		});
		this.stdin = new Writable({ write: (chunk, _encoding, cb) => { decoder.push(chunk); cb(); } });
		setImmediate(() => this.send(0x80, 0, Buffer.from('{"version":1}')));
	}
	private open(id: number, target: { vm: string; service: string }, ports: { data: number; control: number } | undefined): void {
		this.opens.push(target.service);
		if (!ports || target.vm !== VM_ID) { this.send(0x82, id, Buffer.from('{"message":"connect timed out","code":10060}')); return; }
		const socket = connect({ host: "127.0.0.1", port: target.service === DATA_SERVICE ? ports.data : ports.control, allowHalfOpen: true });
		this.sockets.set(id, socket);
		socket.on("connect", () => this.send(0x81, id));
		socket.on("data", (chunk: Buffer) => this.send(0x83, id, chunk));
		socket.on("end", () => this.send(0x84, id));
		socket.on("error", () => {});
		socket.on("close", () => { this.sockets.delete(id); this.send(0x85, id); });
	}
	private send(type: number, stream: number, payload: Buffer = Buffer.alloc(0)): void { this.stdout.write(encodeFrame(type, stream, payload)); }
	kill(): boolean { for (const socket of this.sockets.values()) socket.destroy(); this.emit("close", 0); return true; }
}

/** Windows-MCP as seen over HTTP: Bearer auth, SSE replies. */
async function windowsMcp(t: TestContext) {
	const seen: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"unauthorized"}'); return; }
			const message = JSON.parse(body);
			seen.push(message.method);
			if (message.id === undefined) { res.writeHead(202).end(); return; }
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echo: message.method } })}\n\n`);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { port: address.port, seen, stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function guestRelay(t: TestContext, port: number) {
	const dir = await mkdtemp(join(tmpdir(), "windows-relay-channel-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const config = join(dir, "config.toml");
	const marker = join(dir, "restart.txt");
	await writeFile(config, `[server]\ntransport = "streamable-http"\nhost = "127.0.0.1"\nport = ${port}\nauth_key = "${KEY}"\nstateless_http = true\n`);
	const child = spawn("python3", [script, "--config", config, "--tcp-test", "--test-restart-log", marker], { stdio: ["ignore", "pipe", "ignore"] });
	const exited = once(child, "exit");
	t.after(async () => { if (child.exitCode === null) { child.kill(); await exited; } });
	const lines = createInterface({ input: child.stdout });
	t.after(() => lines.close());
	const [line] = await once(lines, "line");
	return { ports: JSON.parse(String(line)) as { data: number; control: number }, marker };
}

function channel(t: TestContext, ports: { data: number; control: number } | undefined, key: () => string | Error = () => KEY) {
	const auth: string[] = [];
	const host: HostCalls = {
		async call(method, params = {}) {
			assert.equal(method, "relayAuth");
			auth.push(String(params.vm));
			const value = key();
			if (value instanceof Error) throw value;
			return { id: VM_ID, key: value };
		},
	};
	let proc: RoutingTunnel | undefined;
	const tunnel = new Tunnel({ idleMs: 60_000, launch: () => (proc = new RoutingTunnel(ports)) });
	t.after(() => tunnel.close());
	return { relay: new RelayChannel({ tunnel, host, vm: "Win11" }), auth, opens: () => proc?.opens ?? [] };
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
const unsent = (pattern: RegExp) => (error: unknown) => error instanceof TransportError && error.unsent && pattern.test(error.message) && !error.message.includes(KEY) && !error.message.includes(OTHER_KEY);

test("MCP calls and control requests reach Windows-MCP through the relay, with the key looked up once", { skip }, async (t) => {
	const mcp = await windowsMcp(t);
	const { ports, marker } = await guestRelay(t, mcp.port);
	const { relay, auth } = channel(t, ports);
	assert.deepEqual(await relay.mcp(initialize, { timeoutMs: 10_000 }), [{ jsonrpc: "2.0", id: 7, result: { echo: "initialize" } }]);
	assert.deepEqual(await relay.mcp(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), { timeoutMs: 10_000 }), []);
	const ping = await relay.control("ping");
	assert.ok(ping.ok && "listening" in ping && ping.listening);
	const session = await relay.control("session");
	assert.deepEqual(session, { ok: false, error: "session query needs Windows" });
	assert.deepEqual(await relay.control("restart"), { ok: true, steps: [] });
	assert.equal((await readFile(marker, "utf8")).trim(), "restart");
	assert.deepEqual(mcp.seen, ["initialize", "notifications/initialized"]);
	assert.deepEqual(auth, ["Win11"], "the host's key file is read once, not per call");
});

test("a key the server rejects is unsent, never echoed, and a fresh key is read after forget", { skip }, async (t) => {
	const mcp = await windowsMcp(t);
	const { ports } = await guestRelay(t, mcp.port);
	let current = OTHER_KEY;
	const { relay, auth } = channel(t, ports, () => current);
	await assert.rejects(relay.mcp(initialize, { timeoutMs: 10_000 }), unsent(/rejected the host's key/));
	await assert.rejects(relay.control("ping"), unsent(/rejected the host's key/));
	current = KEY;
	relay.forget();
	assert.equal((await relay.mcp(initialize, { timeoutMs: 10_000 })).length, 1);
	assert.ok(auth.length >= 2);
});

test("a stopped Windows-MCP is reported unsent by the relay, and ping says it isn't listening", { skip }, async (t) => {
	const mcp = await windowsMcp(t);
	const { ports } = await guestRelay(t, mcp.port);
	const { relay } = channel(t, ports);
	await mcp.stop();
	await assert.rejects(relay.mcp(initialize, { timeoutMs: 10_000 }), unsent(/not listening/));
	const ping = await relay.control("ping");
	assert.ok(ping.ok && "listening" in ping && !ping.listening);
});

test("no relay in the guest, or no host to identify the VM, is unsent", async (t) => {
	const { relay } = channel(t, undefined);
	await assert.rejects(relay.mcp(initialize, { timeoutMs: 10_000 }), unsent(/connect timed out/));
	await assert.rejects(relay.control("ping"), unsent(/connect timed out/));
	const failing = channel(t, undefined, () => new Error("unknown method 'relayAuth'"));
	await assert.rejects(failing.relay.control("ping"), unsent(/can't identify 'Win11'.*relayAuth/));
	assert.deepEqual(failing.opens(), [], "nothing is opened without the VM's id");
	const unset = channel(t, undefined, () => "");
	await assert.rejects(unset.relay.control("ping"), unsent(/not set up/));
});
