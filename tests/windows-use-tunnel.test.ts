import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { Duplex, PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ClientProcess } from "../lib/computer-use/mcp-link.ts";
import { openRelay, postMcp } from "../lib/windows-use/mcp-http.ts";
import { FrameDecoder, encodeFrame, Tunnel } from "../lib/windows-use/tunnel.ts";
import { TransportError } from "../lib/windows-use/transport.ts";

const target = { tcp: "127.0.0.1:1" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class Fake extends EventEmitter implements ClientProcess {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly frames: { type: number; stream: number; payload: Buffer }[] = [];
	readonly stdin: Writable;
	killed = false;
	constructor(respond = true, hello = true) {
		super();
		const decoder = new FrameDecoder(frame => {
			this.frames.push(frame);
			if (!respond) return;
			if (frame.type === 1) this.send(0x81, frame.stream);
			if (frame.type === 2) this.send(0x83, frame.stream, frame.payload);
			if (frame.type === 3) { this.send(0x84, frame.stream); this.send(0x85, frame.stream); }
			if (frame.type === 4) this.send(0x85, frame.stream);
		});
		this.stdin = new Writable({ write: (chunk, _encoding, cb) => { decoder.push(chunk); cb(); } });
		if (hello) setImmediate(() => this.send(0x80, 0, Buffer.from('{"version":1}')));
	}
	send(type: number, stream: number, payload: Buffer = Buffer.alloc(0)): void { this.stdout.write(encodeFrame(type, stream, payload)); }
	kill(): boolean { if (!this.killed) { this.killed = true; this.emit("close", 0); } return true; }
}
function pair(): readonly [Duplex, Duplex] {
	const side = (other: () => Duplex) => new Duplex({
		read() {}, write(chunk, _encoding, cb) { other().push(chunk); cb(); },
		final(cb) { other().push(null); cb(); },
		destroy(error, cb) { other().push(null); cb(error); },
	});
	const a = side(() => b), b = side(() => a);
	for (const stream of [a, b]) {
		stream.on("error", () => {});
		Object.assign(stream, { setTimeout() {}, setNoDelay() {}, setKeepAlive() {} });
	}
	return [a, b];
}
const unsent = (error: unknown) => error instanceof TransportError && error.unsent;

test("frame decoder accepts split and coalesced frames and rejects oversize", () => {
	const frames: unknown[] = [], decoder = new FrameDecoder(f => frames.push(f));
	const bytes = Buffer.concat([encodeFrame(1, 42, Buffer.from("abc")), encodeFrame(3, 42)]);
	for (const byte of bytes.subarray(0, 10)) decoder.push(Buffer.from([byte]));
	decoder.push(bytes.subarray(10));
	assert.equal(frames.length, 2);
	assert.deepEqual(frames[0], { type: 1, stream: 42, payload: Buffer.from("abc") });
	const header = Buffer.alloc(9); header.writeUInt32BE(1024 * 1024 + 1, 5);
	assert.throws(() => decoder.push(header), /payload/);
	assert.throws(() => encodeFrame(2, 1, Buffer.alloc(1024 * 1024 + 1)), /payload/);
});

test("Tunnel waits for HELLO and supports concurrent split writes and half close", async () => {
	const proc = new Fake(true, false), tunnel = new Tunnel({ launch: () => proc, idleMs: 1000 });
	try {
		const opened = tunnel.open(target);
		await sleep(5); assert.equal(proc.frames.length, 0);
		proc.send(0x80, 0, Buffer.from('{"version":1}'));
		const first = await opened;
		const streams = [first, ...await Promise.all(Array.from({ length: 20 }, () => tunnel.open(target)))];
		await Promise.all(streams.map(async stream => {
			const chunks: Buffer[] = []; stream.on("data", chunk => chunks.push(chunk));
			const end = once(stream, "end"); stream.end(Buffer.alloc(150_000, 7)); await end;
			assert.equal(Buffer.concat(chunks).length, 150_000);
		}));
		assert.ok(proc.frames.filter(f => f.type === 2).every(f => f.payload.length <= 65536));
		assert.equal(new Set(proc.frames.filter(f => f.type === 1).map(f => f.stream)).size, 21);
	} finally { tunnel.close(); }
});

test("Tunnel maps startup, HELLO timeout, OPEN_FAILED and pre-open death to unsent", async () => {
	const failing = new Tunnel({ launch: () => { throw new Error("launch failed"); }, idleMs: 10 });
	await assert.rejects(failing.open(target), unsent); failing.close();
	const silent = new Fake(false, false), timeout = new Tunnel({ launch: () => silent, idleMs: 10, helloTimeoutMs: 10 });
	await assert.rejects(timeout.open(target), unsent); assert.ok(silent.killed); timeout.close();
	for (const die of [false, true]) {
		const proc = new Fake(false), tunnel = new Tunnel({ launch: () => proc, idleMs: 1000 });
		const result = tunnel.open(target); await sleep(10);
		if (die) { proc.stderr.write("synthetic failure"); proc.emit("close", 9); }
		else proc.send(0x82, 1, Buffer.from('{"message":"unreachable","code":1}'));
		await assert.rejects(result, unsent); tunnel.close();
	}
});

test("Tunnel death destroys opened streams, idle closes, and next open restarts", async () => {
	const procs: Fake[] = [], tunnel = new Tunnel({ launch: () => { const p = new Fake(); procs.push(p); return p; }, idleMs: 10 });
	const stream = await tunnel.open(target), error = once(stream, "error");
	procs[0]!.stderr.write("diagnostic"); procs[0]!.emit("close", 3);
	assert.match(String((await error)[0]), /exited.*3.*diagnostic/);
	const next = await tunnel.open(target); next.destroy(); await sleep(25);
	assert.ok(procs[1]!.killed);
	const last = await tunnel.open(target); assert.equal(procs.length, 3); last.destroy(); tunnel.close();
});

test("Tunnel abort before OPENED rejects unsent and closes the late open", async () => {
	const proc = new Fake(false), tunnel = new Tunnel({ launch: () => proc, idleMs: 1000 });
	const controller = new AbortController(), result = tunnel.open(target, { signal: controller.signal });
	await sleep(10); controller.abort(); await assert.rejects(result, unsent);
	proc.send(0x81, 1); await sleep(5);
	assert.ok(proc.frames.some(f => f.type === 4 && f.stream === 1)); tunnel.close();
});

test("openRelay consumes success byte only and handles failure, EOF and timeout as unsent", async () => {
	for (const kind of ["ok", "failure", "eof", "timeout"] as const) {
		const [client, server] = pair();
		const fake = { open: async () => client } as unknown as Tunnel;
		const result = openRelay(fake, target, { timeoutMs: 20 });
		if (kind === "ok") server.write(Buffer.from([1, 65, 66]));
		if (kind === "failure") server.end(Buffer.concat([Buffer.from([0]), Buffer.from("not ready")]));
		if (kind === "eof") server.end();
		if (kind === "ok") { const stream = await result; assert.equal(stream.read().toString(), "AB"); stream.destroy(); }
		else await assert.rejects(result, unsent);
		server.destroy();
	}
});

test("postMcp uses authenticated HTTP and parses JSON, SSE, 202 and HTTP errors", async () => {
	for (const kind of ["json", "sse", "accepted", "denied"] as const) {
		const [client, peer] = pair();
		const server = createServer((req, res) => {
			assert.equal(req.headers.authorization, "Bearer synthetic-key"); assert.equal(req.url, "/mcp");
			if (kind === "accepted") { res.writeHead(202); res.end(); }
			if (kind === "denied") { res.writeHead(401); res.end("denied synthetic-key"); }
			if (kind === "json") { res.setHeader("Content-Type", "application/json"); res.end('{"id":1,"result":{}}'); }
			if (kind === "sse") { res.setHeader("Content-Type", "text/event-stream"); res.end('event: message\r\ndata: {"id":1,\r\ndata: "result":{}}\r\n\r\ndata:{"id":2}'); }
		});
		server.emit("connection", peer);
		try {
			const result = postMcp(client, { key: "synthetic-key", message: { id: 1 }, timeoutMs: 1000 });
			if (kind === "denied") await assert.rejects(result, e => e instanceof TransportError && !e.unsent && /HTTP 401/.test(e.message) && !e.message.includes("synthetic-key"));
			else assert.deepEqual(await result, kind === "accepted" ? [] : kind === "json" ? [{ id: 1, result: {} }] : [{ id: 1, result: {} }, { id: 2 }]);
		} finally { client.destroy(); peer.destroy(); server.close(); }
	}
});

test("postMcp marks incomplete response and timeout as possibly run, supports cancellation", async () => {
	for (const kind of ["reset", "timeout", "abort"] as const) {
		const [client, peer] = pair(), controller = new AbortController();
		const server = createServer((_req, res) => {
			if (kind === "reset") { res.writeHead(200, { "Content-Length": "100" }); res.write("{"); setImmediate(() => peer.destroy()); }
			if (kind === "abort") controller.abort();
		});
		server.emit("connection", peer);
		try {
			await assert.rejects(postMcp(client, { key: "synthetic-key", message: {}, timeoutMs: 30, signal: controller.signal }), e => {
				if (kind === "abort") return e instanceof Error && /cancelled/.test(e.message);
				return e instanceof TransportError && !e.unsent && (kind === "timeout" ? e.timedOut && /^windows_use tunnel mcp timed out after/.test(e.message) : /may have run/.test(e.message));
			});
		} finally { client.destroy(); peer.destroy(); server.close(); }
	}
});

test("Tunnel handles asynchronous child launch errors without an unhandled error", async () => {
	const proc = new Fake(false, false), tunnel = new Tunnel({ launch: () => proc, idleMs: 10 });
	const result = tunnel.open(target); await sleep(5);
	proc.emit("error", new Error("synthetic spawn failure"));
	await assert.rejects(result, e => unsent(e) && /spawn failure/.test(String(e))); tunnel.close();
});

test("cancelled connecting streams do not prevent idle shutdown", async () => {
	const proc = new Fake(false), tunnel = new Tunnel({ launch: () => proc, idleMs: 10 });
	const controller = new AbortController(), result = tunnel.open(target, { signal: controller.signal });
	await sleep(5); controller.abort(); await assert.rejects(result, unsent);
	await sleep(25); assert.ok(proc.killed); tunnel.close();
});

test("Tunnel abort during HELLO or asynchronous launch and close during launch stay unsent", async () => {
	const cancelled = AbortSignal.abort();
	const unused = new Tunnel({ launch: () => { throw new Error("must not launch"); }, idleMs: 10 });
	await assert.rejects(unused.open(target, { signal: cancelled }), unsent); unused.close();
	for (const close of [false, true]) {
		let release!: (proc: ClientProcess) => void;
		const launched = new Promise<ClientProcess>(resolve => { release = resolve; });
		const tunnel = new Tunnel({ launch: () => launched, idleMs: 10 });
		const controller = new AbortController(), result = tunnel.open(target, { signal: controller.signal });
		await sleep(5); if (close) tunnel.close(); else controller.abort();
		const proc = new Fake(); release(proc);
		await assert.rejects(result, unsent); tunnel.close(); assert.ok(proc.killed);
	}
});

test("Tunnel rejects malformed HELLO and oversize frames, then restarts", async () => {
	for (const oversize of [false, true]) {
		let launches = 0;
		const bad = new Fake(false, false), good = new Fake(true, false);
		const tunnel = new Tunnel({ launch: () => ++launches === 1 ? bad : good, idleMs: 1000 });
		const failed = tunnel.open(target); await sleep(5);
		if (oversize) { const header = Buffer.alloc(9); header.writeUInt32BE(1024 * 1024 + 1, 5); bad.stdout.write(header); }
		else bad.send(0x80, 0, Buffer.from('{"version":2}'));
		await assert.rejects(failed, unsent); assert.ok(bad.killed);
		const opened = tunnel.open(target); await sleep(5); good.send(0x80, 0, Buffer.from('{"version":1}'));
		(await opened).destroy(); tunnel.close();
	}
});

test("Tunnel bounds unread data and stream errors do not kill other streams", async () => {
	const proc = new Fake(), tunnel = new Tunnel({ launch: () => proc, idleMs: 1000 });
	try {
		const slow = await tunnel.open(target), other = await tunnel.open(target), error = once(slow, "error");
		for (let i = 0; i < 5; i++) proc.send(0x83, 1, Buffer.alloc(1024 * 1024));
		assert.match(String((await error)[0]), /buffer exceeded/); assert.equal(proc.killed, false);
		const closedError = once(other, "error"); proc.send(0x85, 2, Buffer.from("synthetic socket failure"));
		assert.match(String((await closedError)[0]), /socket failure/);
	} finally { tunnel.close(); }
});

test("openRelay buffers split UTF-8 failure messages and honours cancellation", async () => {
	const [client, peer] = pair(), fake = { open: async () => client } as unknown as Tunnel;
	const failed = openRelay(fake, target, { timeoutMs: 100 });
	peer.write(Buffer.from([0])); peer.write(Buffer.from([0xc3])); peer.end(Buffer.from([0xa9]));
	await assert.rejects(failed, e => unsent(e) && (e as Error).message === "é"); peer.destroy();
	const [next, other] = pair(), controller = new AbortController();
	const aborted = openRelay({ open: async () => next } as unknown as Tunnel, target, { signal: controller.signal });
	controller.abort(); await assert.rejects(aborted, unsent); assert.ok(next.destroyed); other.destroy();
});

test("postMcp returns 202 on headers and rejects invalid JSON with key redaction", async () => {
	for (const accepted of [false, true]) {
		const [client, peer] = pair();
		const server = createServer((_req, res) => {
			if (accepted) { res.writeHead(202); res.flushHeaders(); }
			else { res.writeHead(200, { "Content-Type": "application/json" }); res.end("synthetic-key"); }
		});
		server.emit("connection", peer);
		try {
			const result = postMcp(client, { key: "synthetic-key", message: '{"id":1}', timeoutMs: 30 });
			if (accepted) assert.deepEqual(await result, []);
			else await assert.rejects(result, e => e instanceof TransportError && !e.unsent && !e.message.includes("synthetic-key"));
		} finally { client.destroy(); peer.destroy(); server.close(); }
	}
});
