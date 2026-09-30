/** Only loopback TCP and random nonexistent VM IDs, never real guests or Hyper-V cmdlets. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FrameDecoder, Tunnel } from "../lib/windows-use/tunnel.ts";
import { TransportError } from "../lib/windows-use/transport.ts";

const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const wsl = process.platform === "linux" && existsSync(WSL_POWERSHELL);
const native = { skip: process.platform !== "win32" && !wsl, timeout: 90_000 };
const exe = wsl ? WSL_POWERSHELL : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const args = ["-NoLogo", "-NoProfile", "-NonInteractive"];
function scriptPath(): string {
	const path = fileURLToPath(new URL("../lib/windows-use/tunnel.ps1", import.meta.url));
	return wsl ? execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim() : path;
}

// Workers live in C# so PowerShell's single runspace cannot serialize echo clients.
const ECHO_SOURCE = `using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Threading;
public static class SyntheticEcho {
 static readonly ConcurrentBag<TcpClient> clients = new ConcurrentBag<TcpClient>();
 public static void Run() {
  TcpListener listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
  Console.WriteLine(((IPEndPoint)listener.LocalEndpoint).Port); Console.Out.Flush();
  Thread accept = new Thread(delegate() {
   try { while (true) {
    TcpClient client = listener.AcceptTcpClient(); clients.Add(client);
    Thread worker = new Thread(delegate() { Echo(client); }); worker.IsBackground = true; worker.Start();
   } } catch (SocketException) {} catch (ObjectDisposedException) {}
  });
  accept.IsBackground = true; accept.Start();
  try { Console.ReadLine(); } finally { listener.Stop(); foreach (TcpClient client in clients) client.Close(); }
 }
 static void Echo(TcpClient client) {
  try { using (client) {
   NetworkStream stream = client.GetStream(); byte[] buffer = new byte[65536]; int count;
   while ((count = stream.Read(buffer, 0, buffer.Length)) != 0) stream.Write(buffer, 0, count);
  } } catch (System.IO.IOException) {} catch (ObjectDisposedException) {}
 }
}`;

async function echo(stream: Duplex, bytes: Buffer): Promise<void> {
	const received: Buffer[] = [];
	stream.on("data", (chunk: Buffer) => received.push(chunk));
	const end = once(stream, "end"); stream.end(bytes); await end;
	assert.deepEqual(Buffer.concat(received), bytes);
}

async function listener(): Promise<{ readonly proc: ReturnType<typeof spawn>; readonly port: number }> {
	const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'\n${ECHO_SOURCE}\n'@ | Out-Null; [SyntheticEcho]::Run()`;
	const proc = spawn(exe, [...args, "-Command", command], { stdio: "pipe" });
	let stderr = "";
	proc.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
	const port = await new Promise<number>((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => { proc.kill(); reject(new Error(`synthetic listener timed out: ${stderr}`)); }, 20_000);
		proc.stdout.on("data", chunk => {
			text += chunk;
			if (!text.includes("\n")) return;
			clearTimeout(timer);
			const value = Number(text.trim());
			if (Number.isInteger(value) && value > 0) resolve(value); else reject(new Error(`invalid listener port: ${text}`));
		});
		proc.once("close", code => { clearTimeout(timer); reject(new Error(`synthetic listener exited ${code}: ${stderr}`)); });
		proc.once("error", error => { clearTimeout(timer); reject(error); });
	});
	return { proc, port };
}

async function stop(proc: ReturnType<typeof spawn>): Promise<void> {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	const closed = once(proc, "close");
	proc.stdin?.end();
	const timer = setTimeout(() => proc.kill(), 3000);
	try { await closed; } finally { clearTimeout(timer); }
}

test("native tunnel HELLO, echo, half-close, ten concurrent streams, 10 MiB and nonexistent VM", native, async t => {
	const server = await listener();
	const processes: ReturnType<typeof spawn>[] = [];
	let helloAt = 0;
	const tunnel = new Tunnel({ idleMs: 1000, launch: () => {
		const start = performance.now();
		const proc = spawn(exe, [...args, "-File", scriptPath()], { stdio: "pipe" }); processes.push(proc);
		const decoder = new FrameDecoder(frame => {
			if (frame.type === 0x80) { helloAt = performance.now(); t.diagnostic(`spawn-to-HELLO ${(helloAt - start).toFixed(1)} ms`); }
		});
		proc.stdout.on("data", chunk => decoder.push(chunk));
		return proc;
	} });
	try {
		const target = { tcp: `127.0.0.1:${server.port}` };
		const first = await tunnel.open(target, { timeoutMs: 2000 });
		t.diagnostic(`loopback connect ${(performance.now() - helloAt).toFixed(1)} ms`);
		await echo(first, Buffer.from("synthetic echo"));
		await Promise.all(Array.from({ length: 10 }, async () => echo(await tunnel.open(target), Buffer.alloc(32 * 1024, 19))));
		const large = await tunnel.open(target), start = performance.now();
		await echo(large, Buffer.alloc(10 * 1024 * 1024, 23));
		const seconds = (performance.now() - start) / 1000;
		t.diagnostic(`10 MiB round trip ${seconds.toFixed(3)} s, ${(10 / seconds).toFixed(1)} MiB/s`);
		const failedAt = performance.now();
		await assert.rejects(tunnel.open({ vm: randomUUID(), service: randomUUID() }, { timeoutMs: 2000 }), error => error instanceof TransportError && error.unsent);
		t.diagnostic(`nonexistent VM OPEN_FAILED ${(performance.now() - failedAt).toFixed(1)} ms`);
		// An individual OPEN_FAILED must not poison the process or a following stream.
		await echo(await tunnel.open(target), Buffer.from("still alive"));
	} finally {
		// stdin EOF lets the Windows processes close their sockets before WSL reaps them.
		await Promise.all(processes.map(stop)); tunnel.close(); await stop(server.proc);
	}
});

test("native tunnel rejects oversized headers and exits cleanly on stdin EOF", native, async () => {
	for (const oversize of [false, true]) {
		const proc = spawn(exe, [...args, "-File", scriptPath()], { stdio: "pipe" });
		const closed = once(proc, "close");
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("native HELLO timeout")), 20_000);
				const decoder = new FrameDecoder(frame => { if (frame.type === 0x80) { clearTimeout(timer); resolve(); } });
				proc.stdout.on("data", chunk => decoder.push(chunk));
				proc.once("close", code => { clearTimeout(timer); reject(new Error(`tunnel exited ${code} before HELLO`)); });
			});
			if (oversize) { const frame = Buffer.alloc(9); frame[0] = 1; frame.writeUInt32BE(1, 1); frame.writeUInt32BE(1024 * 1024 + 1, 5); proc.stdin.write(frame); }
			else proc.stdin.end();
			assert.equal((await closed)[0], oversize ? 1 : 0);
		} finally { await stop(proc); }
	}
});
