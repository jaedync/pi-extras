/** Fixtures for the auto-update tests: Pi prefixes, packages and git repositories, all in temp folders. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const PI_PACKAGE = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent");
export const PI_NAME = "@earendil-works/pi-coding-agent";

/** An npm prefix whose bin/pi is the repo's development Pi. */
export function piPrefix(dir: string): string {
	mkdirSync(join(dir, "bin"), { recursive: true });
	mkdirSync(join(dir, "lib", "node_modules", "@earendil-works"), { recursive: true });
	symlinkSync(PI_PACKAGE, join(dir, "lib", "node_modules", PI_NAME));
	symlinkSync(join(PI_PACKAGE, "dist", "cli.js"), join(dir, "bin", "pi"));
	return dir;
}

export type FixtureKind = "good" | "load-error" | "handler-error";

const EXTENSIONS: Record<FixtureKind, string> = {
	good: 'export default function (pi) { pi.registerCommand("fixture-ok", { description: "fixture", handler: async () => {} }); }\n',
	"load-error": 'import "./missing-module.ts";\nexport default function () {}\n',
	"handler-error": 'export default function (pi) { pi.on("session_start", () => { throw new Error("fixture failure"); }); }\n',
};

/** A Pi package with one extension that loads, fails to load, or throws at session start. */
export function fixturePackage(dir: string, kind: FixtureKind, name = "fixture", version = "1.0.0"): string {
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version, type: "module", keywords: ["pi-package"], pi: { extensions: ["extensions/main.ts"] } }, null, 2)}\n`);
	writeFileSync(join(dir, "extensions", "main.ts"), EXTENSIONS[kind]);
	return dir;
}

export const GIT_ENV = {
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_TERMINAL_PROMPT: "0",
};

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A git repository holding a fixture package, with one commit. Returns the folder. */
export function gitPackage(dir: string, kind: FixtureKind, version = "1.0.0", name = "fixture"): string {
	fixturePackage(dir, kind, name, version);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", `v${version}`);
	return dir;
}

/** Changes the package in a fixture repository and tags it `v<version>`. Returns the commit. */
export function tagRelease(dir: string, kind: FixtureKind, version: string, annotated = false): string {
	fixturePackage(dir, kind, JSON.parse(execFileSync("cat", [join(dir, "package.json")], { encoding: "utf8" })).name, version);
	git(dir, "add", ".");
	git(dir, "commit", "-q", "--allow-empty", "-m", `v${version}`);
	if (annotated) git(dir, "tag", "-a", `v${version}`, "-m", `v${version}`);
	else git(dir, "tag", `v${version}`);
	return git(dir, "rev-parse", "HEAD");
}

/** Removes a tree that holds read-only release folders. */
export function removeTree(dir: string): void {
	const writable = (path: string): void => {
		try {
			chmodSync(path, 0o755);
			for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) writable(join(path, entry.name));
		} catch {
			// A file or a link: nothing to open.
		}
	};
	writable(dir);
	rmSync(dir, { recursive: true, force: true });
}

export function writeFile(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/**
 * A fake git host: `https://git.example.invalid/<name>` clones from
 * `<root>/<name>` through git's `insteadOf`, set in this process's
 * environment (child processes inherit it). Returns the root folder and the
 * URL maker.
 */
export function fakeGitHost(root: string): { root: string; url: (name: string) => string } {
	mkdirSync(root, { recursive: true });
	Object.assign(process.env, {
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://git.example.invalid/",
		GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always",
	});
	return { root, url: (name) => `https://git.example.invalid/${name}` };
}
