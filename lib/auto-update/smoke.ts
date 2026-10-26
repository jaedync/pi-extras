/**
 * Tests a candidate set before any session uses it: the candidate Pi with
 * the candidate packages, in RPC mode, in a temporary home and agent dir,
 * against a fake Anthropic endpoint on 127.0.0.1. It passes when a prompt
 * gets the fake reply and no extension failed to load or threw.
 *
 * Pi 1.4 reports a package that fails to load by exiting with code 1 and
 * "Failed to load extension" on stderr; an extension that throws in a
 * handler gives an `extension_error` record. Both fail the test.
 *
 * Nothing from the real agent dir is copied: no auth.json, models.json or
 * sessions. Only the managed packages load (see the README for this limit).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine, sanitize, trackChild } from "./run.ts";

export const SMOKE_TIMEOUT_MS = 90_000;
const PROVIDER = "pi-extras-smoke";
const MODEL = "smoke";
const KILL_GRACE_MS = 2_000;

export interface SmokeInput {
	/** The Pi npm prefix: `<dir>/bin/pi`. */
	readonly piDir: string;
	/** settings.json `packages` entries to load. */
	readonly packages: readonly unknown[];
	readonly timeoutMs?: number;
	/** The node binary to run Pi with. */
	readonly node?: string;
}

export type SmokeResult = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly reason: string };

const sse = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** A minimal Anthropic Messages endpoint: every request streams `reply`. */
function fakeAnthropic(reply: string): Promise<{ server: Server; port: number }> {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			if (!req.url?.includes("/messages")) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(sse("message_start", { message: { id: "smoke", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
			res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
			res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } }));
			res.write(sse("content_block_stop", { index: 0 }));
			res.write(sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }));
			res.end(sse("message_stop", {}));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
	});
}

function writeAgent(agentDir: string, port: number, packages: readonly unknown[]): void {
	mkdirSync(agentDir, { recursive: true });
	const model = { id: MODEL, name: "Smoke", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER]: { baseUrl: `http://127.0.0.1:${port}`, api: "anthropic-messages", apiKey: "smoke", models: [model] } } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, quietStartup: true, enableInstallTelemetry: false, packages }));
}

/** Text of an assistant message record, or undefined. */
function assistantText(record: Record<string, unknown>): string | undefined {
	const message = record.message as { role?: string; content?: { type?: string; text?: string }[] } | undefined;
	if (record.type !== "message_end" || message?.role !== "assistant") return undefined;
	return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function extensionError(record: Record<string, unknown>): string {
	const path = typeof record.extensionPath === "string" ? record.extensionPath.split("/").slice(-3).join("/") : "an extension";
	return `${path} failed in ${String(record.event ?? "a handler")}: ${sanitize(String(record.error ?? "")).slice(0, 160)}`;
}

interface Drive {
	readonly bin: string;
	readonly node: string;
	readonly home: string;
	readonly agentDir: string;
	readonly reply: string;
	readonly timeoutMs: number;
}

function drivePi(drive: Drive): Promise<SmokeResult> {
	const started = Date.now();
	const child = spawn(drive.node, [drive.bin, "--mode", "rpc", "--no-session", "--model", `${PROVIDER}/${MODEL}`], {
		cwd: drive.home,
		env: {
			PATH: process.env.PATH, HOME: drive.home, TMPDIR: join(drive.home, "tmp"), PI_CODING_AGENT_DIR: drive.agentDir,
			PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
			// The candidate pi-extras loads too; it must not start an update cycle from inside the smoke test.
			PI_EXTRAS_UPDATE_SMOKE: "1", PI_EXTRAS_UPDATE_STORE: join(drive.home, "store"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	trackChild(child, false);
	return new Promise((resolve) => {
		let outcome: SmokeResult | undefined;
		let stderr = "";
		let buffer = "";
		let replied = false;
		// The result is known first; the promise settles once Pi has exited, so its home can be removed.
		const finish = (result: SmokeResult) => {
			if (outcome) return;
			outcome = result;
			clearTimeout(timer);
			child.stdin.end();
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
			setTimeout(() => resolve(result), 2 * KILL_GRACE_MS).unref();
		};
		const timer = setTimeout(() => finish({ ok: false, reason: `no reply within ${Math.round(drive.timeoutMs / 1000)} s` }), drive.timeoutMs);
		const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
		const onRecord = (record: Record<string, unknown>) => {
			if (record.type === "extension_error") return finish({ ok: false, reason: extensionError(record) });
			if (record.type === "response" && record.success === false) return finish({ ok: false, reason: `RPC ${String(record.command)} failed: ${sanitize(String(record.error ?? "")).slice(0, 160)}` });
			if (record.type === "response" && record.id === "state") return void send({ type: "prompt", id: "prompt", message: "smoke test" });
			const text = assistantText(record);
			if (text !== undefined && text.includes(drive.reply)) replied = true;
			if (record.type === "agent_end") finish(replied ? { ok: true, ms: Date.now() - started } : { ok: false, reason: "the prompt ended without the test reply" });
		};
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line.startsWith("{")) continue;
				try {
					onRecord(JSON.parse(line) as Record<string, unknown>);
				} catch {
					// Not a record (a stray line from an extension); the outcome comes from the records.
				}
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (/Failed to load extension/i.test(stderr)) finish({ ok: false, reason: firstLine(stderr.split("\n").find((line) => /Failed to load extension/i.test(line)) ?? stderr) });
		});
		child.on("error", (error) => {
			finish({ ok: false, reason: `Pi did not start: ${sanitize(error.message)}` });
			resolve(outcome!);
		});
		child.on("close", (code, signal) => {
			finish({ ok: false, reason: `Pi exited (${code ?? signal}) before the reply: ${firstLine(stderr) || "no error text"}` });
			resolve(outcome!);
		});
		send({ type: "get_state", id: "state" });
	});
}

export async function smokeTest(input: SmokeInput): Promise<SmokeResult> {
	const root = mkdtempSync(join(tmpdir(), "pi-extras-smoke-"));
	const reply = `smoke-${randomBytes(6).toString("hex")}`;
	let fake: { server: Server; port: number } | undefined;
	try {
		const home = join(root, "home");
		mkdirSync(join(home, "tmp"), { recursive: true });
		fake = await fakeAnthropic(reply);
		const agentDir = join(home, ".pi", "agent");
		writeAgent(agentDir, fake.port, input.packages);
		let bin: string;
		try {
			bin = realpathSync(join(input.piDir, "bin", "pi"));
		} catch {
			return { ok: false, reason: "the candidate Pi has no bin/pi" };
		}
		return await drivePi({ bin, node: input.node ?? process.execPath, home, agentDir, reply, timeoutMs: input.timeoutMs ?? SMOKE_TIMEOUT_MS });
	} finally {
		fake?.server.closeAllConnections();
		fake?.server.close();
		rmSync(root, { recursive: true, force: true });
	}
}
