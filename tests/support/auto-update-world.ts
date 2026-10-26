/**
 * A whole machine for the auto-update integration tests, in one temp folder:
 * a HOME with ~/.local/bin/pi linked into an npm prefix, an agent dir with
 * settings.json, a store, a fake git host (real git, local repositories) and
 * a fake npm on PATH. Nothing outside the temp folder is read or changed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type test from "node:test";
import { DEFAULT_CONFIG, type AutoUpdateConfig } from "../../lib/auto-update/config.ts";
import type { CycleDeps } from "../../lib/auto-update/cycle.ts";
import { storePaths, type StorePaths } from "../../lib/auto-update/paths.ts";
import { runCommand } from "../../lib/auto-update/run.ts";
import { readSettingsPackages } from "../../lib/auto-update/settings.ts";
import { smokeTest } from "../../lib/auto-update/smoke.ts";
import { fakeGitHost, fixturePackage, gitPackage, PI_NAME, PI_PACKAGE, removeTree, REPO, tagRelease } from "./auto-update-fixtures.ts";

const exec = promisify(execFile);
export const CLI = join(REPO, "lib", "auto-update", "cli.ts");
const FAKE_NPM = join(REPO, "tests", "fixtures", "fake-npm.mjs");

export interface World {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly settings: string;
	readonly paths: StorePaths;
	readonly gitUrl: string;
	readonly gitRepo: string;
	readonly npmLog: string;
	readonly launcher: string;
	readonly env: Record<string, string>;
	readonly setRegistry: (name: string, version: string, dir?: string) => void;
	readonly cycleDeps: (overrides?: Partial<CycleDeps>) => CycleDeps;
	readonly cli: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	readonly read: (path: string) => string;
}

export const ORIGINAL_SETTINGS = (gitUrl: string) => JSON.stringify({ theme: "quiet", packages: [gitUrl, { source: "npm:fixture-npm", extensions: ["extensions/main.ts"] }, "/local/pinned-path", "npm:pinned@1.0.0"], steeringMode: "one-at-a-time" }, null, 2);

export function world(t: test.TestContext): World {
	// The real path, as the CLI and the extension resolve the store root: on macOS tmpdir() is under the /var -> /private/var link.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "au-world-")));
	t.after(() => removeTree(root));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const host = fakeGitHost(join(root, "host"));
	const gitRepo = gitPackage(join(host.root, "jaedync", "fixture-git"), "good", "0.0.1", "fixture-git");
	const gitUrl = host.url("jaedync/fixture-git");
	const npmSource = fixturePackage(join(root, "npm-source"), "good", "fixture-npm");
	// The Pi that npm -g installed before enable: ~/.local/bin/pi -> ../lib/node_modules/<pi>/dist/bundle/cli.js.
	const oldPi = join(home, ".local", "lib", "node_modules", PI_NAME);
	mkdirSync(join(oldPi, "dist", "bundle"), { recursive: true });
	writeFileSync(join(oldPi, "package.json"), JSON.stringify({ name: PI_NAME, version: "1.3.0" }));
	writeFileSync(join(oldPi, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
	chmodSync(join(oldPi, "dist", "bundle", "cli.js"), 0o755);
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	const launcher = join(home, ".local", "bin", "pi");
	symlinkSync(`../lib/node_modules/${PI_NAME}/dist/bundle/cli.js`, launcher);
	const settings = join(agentDir, "settings.json");
	writeFileSync(settings, ORIGINAL_SETTINGS(gitUrl));
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "npm"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_NPM}' "$@"\n`);
	chmodSync(join(bin, "npm"), 0o755);
	const registryFile = join(root, "registry.json");
	const registry: Record<string, { version: string; dir?: string }> = { [PI_NAME]: { version: "1.4.0" }, "fixture-npm": { version: "1.0.0", dir: npmSource } };
	const setRegistry = (name: string, version: string, dir?: string) => {
		registry[name] = { version, dir: dir ?? registry[name]?.dir };
		writeFileSync(registryFile, JSON.stringify(registry));
	};
	setRegistry(PI_NAME, "1.4.0");
	const npmLog = join(root, "npm.log");
	writeFileSync(npmLog, "");
	const store = join(root, "store");
	const env: Record<string, string> = {
		HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_EXTRAS_UPDATE_STORE: store,
		FAKE_NPM_LOG: npmLog, FAKE_NPM_REGISTRY: registryFile, FAKE_PI_CLI: join(PI_PACKAGE, "dist", "cli.js"),
		PATH: `${bin}:${process.env.PATH}`, PI_OFFLINE: "", TMPDIR: tmpdir(),
		// npm 12's shape by default, the one op01 has; FAKE_NPM_SHAPE=plain runs the cycle tests with older npm's.
		FAKE_NPM_SHAPE: process.env.FAKE_NPM_SHAPE ?? "array",
	};
	// runCommand passes process.env to npm and git, so the fake npm must be first on this process's PATH too.
	Object.assign(process.env, env);
	const paths = storePaths(store);
	mkdirSync(store, { recursive: true });
	const config: AutoUpdateConfig = { ...DEFAULT_CONFIG, enabled: true };
	return {
		root, home, agentDir, settings, paths, gitUrl, gitRepo, npmLog, launcher, env, setRegistry,
		cycleDeps: (overrides = {}) => ({ paths, agentDir, config, runner: runCommand, smoke: smokeTest, now: Date.now, log: () => {}, env: { ...process.env, PI_OFFLINE: "" }, ...overrides }),
		cli: async (...args) => {
			try {
				const result = await exec(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 });
				return { code: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				const failed = error as { code?: number; stdout?: string; stderr?: string };
				return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
			}
		},
		read: (path) => readFileSync(path, "utf8"),
	};
}

/** The store keys of the world's two managed sources (sources.ts storeKeyFor). */
export const GIT_KEY = "git-git.example.invalid-jaedync-fixture-git-ba28a080";
export const NPM_KEY = "npm-fixture-npm-23995fd2";

/** A world after a successful `enable` with the Git source at v1.0.0. */
export async function enabled(t: test.TestContext): Promise<World> {
	const w = world(t);
	tagRelease(w.gitRepo, "good", "1.0.0");
	const result = await w.cli("enable");
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
	return w;
}

/** The source of each `packages` entry in the world's settings.json. */
export const entrySources = (w: World) => readSettingsPackages(w.settings).map((entry) => (typeof entry === "string" ? entry : (entry as { source: string }).source));
