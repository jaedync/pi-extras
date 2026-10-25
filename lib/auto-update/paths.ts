/**
 * Where auto-update keeps its files. Nothing here imports Pi: the cycle runs
 * as a plain `node` process from a pi-extras release folder, where Pi is not
 * a resolvable package.
 */
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Readonly<Record<string, string | undefined>>;

function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** Pi's agent dir, as Pi's own getAgentDir resolves it. */
export function agentDirFrom(env: Env = process.env, home = homedir()): string {
	const dir = env.PI_CODING_AGENT_DIR;
	return dir ? resolve(expandTilde(dir, home)) : join(home, ".pi", "agent");
}

export function storeRootFrom(env: Env = process.env, home = homedir()): string {
	const store = env.PI_EXTRAS_UPDATE_STORE;
	if (store) return resolve(expandTilde(store, home));
	const data = env.XDG_DATA_HOME ? expandTilde(env.XDG_DATA_HOME, home) : join(home, ".local", "share");
	return join(resolve(data), "pi-extras", "updates");
}

/** The pi-extras folder this code runs from. */
export const EXTRAS_DIR = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

/** A name used as one path part: no separators, no dot names, nothing a shell or a log would misread. */
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function safePart(value: string): string {
	if (!SAFE_PART.test(value) || value.includes("..")) throw new Error(`unsafe store name: ${JSON.stringify(value).slice(0, 80)}`);
	return value;
}

export interface StorePaths {
	readonly root: string;
	readonly piRoot: string;
	readonly packagesRoot: string;
	readonly piCurrent: string;
	readonly state: string;
	readonly lock: string;
	readonly leases: string;
	readonly restart: string;
	readonly log: string;
	readonly piDir: (version: string) => string;
	readonly releaseDir: (key: string, id: string) => string;
}

export function storePaths(root: string): StorePaths {
	const piRoot = join(root, "pi");
	const packagesRoot = join(root, "packages");
	return {
		root,
		piRoot,
		packagesRoot,
		piCurrent: join(root, "pi-current"),
		state: join(root, "state.json"),
		lock: join(root, "lock"),
		leases: join(root, "leases"),
		restart: join(root, "restart"),
		log: join(root, "update.log"),
		piDir: (version) => join(piRoot, safePart(version)),
		releaseDir: (key, id) => join(packagesRoot, safePart(key), safePart(id)),
	};
}

/** True when `child` is strictly inside `parent` (both absolute; no `..` escapes). */
export function isInside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..";
}
