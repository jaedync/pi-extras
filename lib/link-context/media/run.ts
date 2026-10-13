/** Runs one helper.py command: JSON in on stdin, JSON out on stdout, killed with its children on abort or timeout. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { killGroup, track } from "./children.ts";
import { nodePath, toolEnv, type Toolchain } from "./provision.ts";

const MAX_STDOUT = 64 * 1024 * 1024;
const NETWORK_COMMANDS = new Set(["info", "captions", "download"]);

interface CookieCopy { readonly path: string; readonly remove: () => void }

/**
 * yt-dlp writes its cookie jar back when it stops, so it gets a copy, owner-only
 * in a private temporary folder. This side removes the folder when the helper
 * ends, so a killed helper leaves no copy behind.
 */
function copyCookies(source: string): CookieCopy {
	const file = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
	let text: Buffer;
	try {
		text = readFileSync(file);
	} catch (error) {
		throw new Error(`linkContext.cookies could not be read: ${(error as Error).message}`);
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-link-cookies-"));
	const path = join(dir, "cookies.txt");
	writeFileSync(path, text, { mode: 0o600 });
	return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function runHelper<T>(toolchain: Toolchain, command: string, request: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number; cwd: string }): Promise<T> {
	// Only the commands that reach the link's hosts use cookies; the others never get a copy.
	const cookies = typeof request.cookies === "string" && NETWORK_COMMANDS.has(command) ? copyCookies(request.cookies) : undefined;
	const body = JSON.stringify({ node: toolchain.node, serverHome: toolchain.serverHome, ...request, cookies: cookies?.path });
	return spawnHelper<T>(toolchain, command, body, options).finally(() => cookies?.remove());
}

function spawnHelper<T>(toolchain: Toolchain, command: string, body: string, options: { signal?: AbortSignal; timeoutMs: number; cwd: string }): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		// -I keeps the working directory and user site-packages off sys.path; it also ignores PYTHON*
		// variables, hence -B and -X utf8 as flags. Its own process group, so a kill reaches the ffmpeg
		// and token script that yt-dlp starts.
		const child = spawn(toolchain.python, ["-I", "-B", "-X", "utf8", toolchain.helper, command], { cwd: options.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...toolEnv(), PATH: nodePath(toolchain.home) } });
		const untrack = track(child.pid);
		const out: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let why: string | undefined;
		const stop = (reason: string) => {
			why ??= reason;
			killGroup(child.pid);
		};
		const settle = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			untrack();
		};
		const onAbort = () => stop("aborted");
		const timer = setTimeout(() => stop(`was stopped after ${Math.round(options.timeoutMs / 1000)} s`), options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_STDOUT) stop(`wrote more than ${MAX_STDOUT / 1024 / 1024} MB`);
			else out.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		// A helper that dies before reading its request must not crash Pi with EPIPE.
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			settle();
			reject(error);
		});
		child.on("close", (code) => {
			settle();
			if (options.signal?.aborted) return reject(options.signal.reason ?? new Error("aborted"));
			if (why) return reject(new Error(`media helper ${command} ${why}`));
			let reply: { error?: string } & T;
			try {
				reply = JSON.parse(Buffer.concat(out).toString("utf8"));
			} catch {
				return reject(new Error(`media helper ${command} failed (exit ${code}): ${stderr.trim().split("\n").slice(-3).join(" ") || "no output"}`));
			}
			if (reply.error) return reject(new Error(reply.error));
			resolve(reply);
		});
		child.stdin.end(body);
	});
}
