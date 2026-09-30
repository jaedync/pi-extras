/**
 * Installing Windows-MCP through nothing but a guest's console: an
 * administrator's PowerShell opened from the Run box and read with OCR before
 * the installer, which carries the server's key, is typed into it; then the
 * installer's progress, which the guest publishes over Hyper-V key-value exchange.
 */
import type { HostCalls } from "./guest.ts";
import type { Screen } from "./screen.ts";

/**
 * The line typed into the guest's elevated PowerShell: it unpacks and runs the
 * gzip+base64 bootstrap the host substitutes for __PAYLOAD__. It lives here,
 * not in host.ps1, because antivirus delays scripts that contain it.
 */
export const LAUNCHER = "$b='__PAYLOAD__';$g=New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String($b))),[IO.Compression.CompressionMode]::Decompress);iex (New-Object IO.StreamReader($g)).ReadToEnd()";
/**
 * Typed instead of LAUNCHER when the bootstrap can go over Hyper-V key-value
 * exchange: it joins the host's items, checks them against the hash typed with
 * it, and runs them with the key it carries. The items reach the guest in about
 * two seconds; typing this takes about a minute. A refusal clears the key off the
 * screen and reports itself the way the bootstrap reports a failure.
 */
export const KVP_INCOMPLETE = /arrived incomplete over key-value exchange/;
export const STUB = "$k='__KEY__';$p=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Virtual Machine\\External';$z=[Convert]::FromBase64String(-join(0..__LAST__|%{$p.\"PiWindowsUse-__RUN__-$_\"}));if((-join([Security.Cryptography.SHA256]::Create().ComputeHash($z)|%{$_.ToString('x2')}))-ne'__SHA__'){cls;sp 'HKLM:\\SOFTWARE\\Microsoft\\Virtual Machine\\Guest' PiWindowsUse '__RUN__ FAIL the installer arrived incomplete over key-value exchange';throw 'incomplete'};iex (New-Object IO.StreamReader((New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,$z)),[IO.Compression.CompressionMode]::Decompress)))).ReadToEnd()";
/** An administrator's PowerShell window's title, which OCR reads with a letter off at times ("Wndows"). */
const ADMIN_SHELL = /Administrator\W+(?:\w+\s+)?Power\s?Shell/i;
/** PowerShell's prompt at the start of a line: it reads input from here on. */
const SHELL_PROMPT = /(?:^|\n)PS\s*[A-Z]:/;
/** Windows OCR can't read this guest's console, so what opened can't be checked. */
export const NO_OCR = /Windows OCR has no recognizer/;

export interface AdminShellOptions {
	readonly host: HostCalls;
	readonly vm: string;
	readonly screen: Screen;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly now: () => number;
	/** Between reads of the console. */
	readonly pollMs: number;
	/** For the window to show after UAC. */
	readonly openMs: number;
	/** After its title shows, for PowerShell to take input: keys typed before its prompt are lost. A read prompt ends it sooner. */
	readonly readyMs: number;
}

/**
 * Opens an administrator's PowerShell at the console and reads the console
 * until it shows and takes input, so the installer is neither typed into
 * whatever else has focus nor lost to a shell still starting. Without Windows
 * OCR there is nothing to read the console with, and the installer is typed unchecked.
 */
export async function openAdminShell(options: AdminShellOptions, signal?: AbortSignal): Promise<void> {
	const { host, vm, screen, sleep, now } = options;
	await host.call("adminShell", { vm }, { signal });
	const deadline = now() + options.openMs;
	let titled: number | undefined;
	let seen = "";
	for (;;) {
		await sleep(options.pollMs, signal);
		try {
			seen = await screen.text(signal);
		} catch (error) {
			if (error instanceof Error && NO_OCR.test(error.message)) return;
			throw error;
		}
		if (ADMIN_SHELL.test(seen)) {
			titled ??= now();
			if (SHELL_PROMPT.test(seen)) return;
		}
		// OCR misses the prompt at times; past this wait it's there all the same.
		if (titled !== undefined && now() - titled >= options.readyMs) return;
		if (titled === undefined && now() >= deadline) break;
	}
	const shown = seen.replace(/\s+/g, " ").trim().slice(0, 300) || "(no text)";
	throw new Error(`An administrator's PowerShell didn't open on ${vm} to install Windows-MCP (Run, Ctrl+Shift+Enter, Yes on the UAC prompt), so nothing was typed. The screen reads: ${shown}. Close what is in the way with win.console.* input, then call win.setup({ vm: ${JSON.stringify(vm)} }).`);
}

export interface Bootstrap {
	readonly run: string;
	readonly startBy: number;
	readonly started: boolean;
}

/**
 * Reads the bootstrap's progress, which the guest publishes as "<run> <status>".
 * A status from an earlier run is ignored, so a leftover success or failure
 * can't be misread.
 */
export function checkBootstrap(vm: string, now: number, bootstrap: Bootstrap, published: unknown): Bootstrap {
	const prefix = `${bootstrap.run} `;
	if (typeof published === "string" && published.startsWith(prefix)) {
		const status = published.slice(prefix.length);
		if (status.startsWith("FAIL ")) {
			throw new Error(`Installing Windows-MCP on ${vm} failed in the guest: ${status.slice(5)}. Its PowerShell window stays open with the details: win.console.screenshot({ vm: ${JSON.stringify(vm)} }). Fix the cause, then call win.setup.`);
		}
		return { ...bootstrap, started: true };
	}
	if (!bootstrap.started && now >= bootstrap.startBy) {
		throw new Error(`The Windows-MCP installer never started on ${vm}: the bootstrap typed into its administrator's PowerShell didn't run. Look with win.console.screenshot({ vm: ${JSON.stringify(vm)} }), close stray windows, then call win.setup.`);
	}
	return bootstrap;
}
