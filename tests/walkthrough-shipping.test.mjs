/**
 * The skill ships to a public repository: no file in it may name the author's
 * machine, its addresses or a home path. A reviewer found the host name in a
 * reference file and in two comments of the scripts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SKILL = fileURLToPath(new URL("../skills/walkthrough-video/", import.meta.url));
const TESTS = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
/**
 * The patterns that name this machine stay out of the repository, this guard
 * included: they come from the environment or from an untracked local file.
 * WV_PRIVATE_PATTERNS is a |-separated list of regexes.
 */
const CONFIG = join(homedir(), ".config", "pi-walkthrough-video", "private-patterns.txt");

/** The owner's private patterns, or null when this machine has none set. */
export function privatePatterns(env = process.env) {
	const listed = (env.WV_PRIVATE_PATTERNS ?? "").split("|").map((p) => p.trim()).filter(Boolean);
	if (listed.length) return listed;
	if (!existsSync(CONFIG)) return null;
	return readFileSync(CONFIG, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const patterns = privatePatterns();
const skip = patterns ? false : `no private patterns on this machine: set WV_PRIVATE_PATTERNS or write ${CONFIG}, one regex a line`;

/** Every file under the skill, except the binary and the vendored template build output. */
function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "__pycache__" || name === ".venv") continue;
		const file = join(dir, name);
		if (statSync(file).isDirectory()) out.push(...walk(file));
		else if (/\.(?:mjs|js|json|md|py|ts|css|html|txt|sh)$/.test(name)) out.push(file);
	}
	return out;
}

/** The lines of `files` that a pattern matches, as `path:line: match`. */
function scanFiles(files, listed) {
	const hits = [];
	for (const file of files) {
		if (!existsSync(file)) continue;
		for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
			for (const pattern of listed) {
				const match = new RegExp(pattern).exec(line);
				if (match) hits.push(`${file}:${index + 1}: ${match[0]}`);
			}
		}
	}
	return hits;
}

test("the private-name guard finds a canary file with a canary pattern", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-canary-"));
	try {
		writeFileSync(join(dir, "clean.md"), "a page about walkthrough videos");
		writeFileSync(join(dir, "leak.md"), "the owner's private host is canary-host-42");
		mkdirSync(join(dir, "nested"));
		writeFileSync(join(dir, "nested", "deeper.mjs"), "const host = 'canary-host-42';");
		const hits = scanFiles(walk(dir), ["canary-host-[0-9]+"]);
		assert.equal(hits.length, 2, `the scan finds the canary in both files: ${hits.join(", ")}`);
		assert.ok(hits.some((hit) => hit.endsWith("leak.md:1: canary-host-42")), hits.join(", "));
		assert.ok(hits.some((hit) => hit.includes("nested/deeper.mjs:1")), "a nested file is scanned too");
		assert.deepEqual(scanFiles(walk(dir), ["no-such-pattern-here"]), [], "a pattern that does not match finds nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no shipped file names a private host, address or home path", { skip }, () => {
	// Both shipped skills with scripts, their tests and fixtures, and the two files at the repository root that describe them.
	const files = [...walk(SKILL), ...walk(join(PACKAGE, "skills", "ui-redline")), ...walk(TESTS).filter((f) => /^(?:walkthrough|ui-redline)-.*\.(?:mjs|ts|json|md|html)$/.test(basename(f))), ...["README.md", "THIRD_PARTY.md"].map((f) => join(PACKAGE, f))];
	assert.deepEqual(scanFiles(files, patterns), [], `remove the private details:\n${scanFiles(files, patterns).join("\n")}`);
});

test("the setup help and the README name what the code installs and how many gates it runs", async () => {
	const { usageText } = await import("../skills/walkthrough-video/scripts/lib/args.mjs");
	const pins = await import("../skills/walkthrough-video/scripts/lib/paths.mjs");
	const help = usageText("setup");
	for (const name of ["playwright-core", "hyperframes", "gsap", "typescript", "chromium-headless-shell", ...pins.pythonPackageNames()]) assert.ok(help.includes(name), `the setup help names ${name}`);
	for (const version of [pins.PLAYWRIGHT_CORE, pins.HYPERFRAMES, pins.GSAP, pins.TYPESCRIPT]) assert.ok(help.includes(version), `the setup help names the pin ${version}`);
	const gatesSource = readFileSync(join(SKILL, "scripts", "lib", "gates-run.mjs"), "utf8");
	const count = (gatesSource.match(/await timed\("/g) ?? []).length;
	assert.ok(count > 0, "gates-run.mjs registers its gates with timed()");
	const readme = readFileSync(join(SKILL, "..", "..", "README.md"), "utf8");
	assert.ok(readme.includes(`${count} measured gates`), `the README says ${count} measured gates`);
});

/** Every script file of the skill (no tests, no templates, no vendored code). */
function scripts() {
	return walk(join(SKILL, "scripts"));
}

/** The text of one call, from its open bracket to the matching close bracket. */
function callText(text, start) {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return text.slice(start);
}

test("every spawnSync in the skill has a timeout, so it cannot block the signal path for ever", () => {
	const missing = [];
	for (const file of scripts()) {
		const text = readFileSync(file, "utf8");
		for (let at = text.indexOf("spawnSync("); at >= 0; at = text.indexOf("spawnSync(", at + 1)) {
			const call = callText(text, at + "spawnSync".length);
			if (!/timeout\s*:/.test(call)) missing.push(`${file.slice(SKILL.length)}: ${call.split("\n")[0].slice(0, 90)}`);
		}
	}
	assert.deepEqual(missing, [], `give each spawnSync a timeout:\n${missing.join("\n")}`);
});

test("only proc.mjs starts a child with a plain spawn: every other tool child is tracked", () => {
	const plain = [];
	for (const file of scripts()) {
		if (file.endsWith(join("lib", "proc.mjs"))) continue;
		if (/\bspawn\(/.test(readFileSync(file, "utf8"))) plain.push(file.slice(SKILL.length));
	}
	assert.deepEqual(plain, [], `start the child with spawnChild from lib/proc.mjs so a signal can stop it:\n${plain.join("\n")}`);
});

test("every browser launch turns off Playwright's own signal handling", async () => {
	const { launchBrowser, OWN_SHUTDOWN } = await import("../skills/walkthrough-video/scripts/lib/browser.mjs");
	assert.deepEqual(OWN_SHUTDOWN, { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
	// A fake chromium: the options that wv passes are what Playwright would receive.
	const options = await launchBrowser({ launch: async (given) => given }, { executablePath: "/bin/true" });
	assert.equal(options.handleSIGINT, false);
	assert.equal(options.handleSIGTERM, false);
	assert.equal(options.handleSIGHUP, false);
	assert.equal(options.executablePath, "/bin/true", "the call's own options are kept");
	const bare = [];
	for (const file of scripts()) {
		if (file.endsWith(join("lib", "browser.mjs"))) continue;
		const text = readFileSync(file, "utf8");
		if (!/\.launch\(/.test(text)) continue;
		// A launch through launchBrowser is a function call, not a method on the browser type.
		if (/\bchromium\.launch\(|browserType\.launch\(/.test(text)) bare.push(file.slice(SKILL.length));
	}
	assert.deepEqual(bare, [], `launch the browser with launchBrowser from lib/browser.mjs, so Playwright cannot exit first:\n${bare.join("\n")}`);
});

test("no spawnSync may block the signal path for more than 60 s", () => {
	// Every long call now goes through run() or runStreaming(), which a signal can stop.
	const timeoutOf = (call) => {
		const match = /timeout:\s*([0-9_]+(?:\s*\*\s*[0-9_]+)*)/.exec(call);
		if (!match) return null;
		return match[1].split("*").reduce((value, part) => value * Number(part.trim().replace(/_/g, "")), 1);
	};
	const long = [];
	for (const file of scripts()) {
		const text = readFileSync(file, "utf8");
		for (let at = text.indexOf("spawnSync("); at >= 0; at = text.indexOf("spawnSync(", at + 1)) {
			const call = callText(text, at + "spawnSync".length);
			const ms = timeoutOf(call);
			if (ms === null || ms > 60_000) long.push(`${file.slice(SKILL.length)}: ${ms ?? "no timeout"} ms`);
		}
	}
	assert.deepEqual(long, [], `move a call above 60 s to run() or runStreaming() from lib/proc.mjs, so a signal stops it:\n${long.join("\n")}`);
});
