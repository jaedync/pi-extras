/**
 * Hashes of the rule set that a count depends on: each rule's own YAML text, sgconfig.yml (its languageGlobs and
 * folders decide which files a rule reads) and the util rules. The ratchet compares them with the baseline, so a
 * rule that someone narrows cannot lower its count without the same explicit acceptance as a higher count.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const RULE_FILE = /\.ya?ml$/;
export const CONFIG_KEY = "sgconfig.yml";
export const UTILS_KEY = "utils";

/** @param {string} text */
const hash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);

/**
 * Reads a top-level list from sgconfig.yml in the two forms that YAML allows for a list of plain paths:
 * `key: [a, b]` and a block of `- a` lines.
 * @param {string} text
 * @param {string} key
 * @returns {string[] | null} null when the key is absent
 */
export function configList(text, key) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const at = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (at < 0) return null;
	const unquote = (/** @type {string} */ value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
	const rest = lines[at].slice(key.length + 1).replace(/\s+#.*$/, "").trim();
	if (rest.startsWith("[")) {
		if (!rest.endsWith("]")) throw new Error(`sgconfig.yml: write ${key} on one line or as a block list`);
		return rest.slice(1, -1).split(",").map(unquote).filter(Boolean);
	}
	if (rest) throw new Error(`sgconfig.yml: ${key} must be a list`);
	/** @type {string[]} */
	const values = [];
	for (const line of lines.slice(at + 1)) {
		if (/^\s*(#.*)?$/.test(line)) continue;
		const item = /^\s+-\s+(.*?)\s*(#.*)?$/.exec(line);
		if (!item) break;
		values.push(unquote(item[1]));
	}
	return values;
}

/** @param {string} dir @returns {string[]} */
function yamlFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return yamlFiles(path);
		return RULE_FILE.test(entry.name) ? [path] : [];
	}).sort();
}

/**
 * @param {string} configPath
 * @returns {Record<string, string>} rule id (or CONFIG_KEY, UTILS_KEY) to a short hash
 */
export function ruleSetHashes(configPath) {
	const root = dirname(resolve(configPath));
	const config = readFileSync(configPath, "utf8");
	const ruleDirs = configList(config, "ruleDirs");
	if (!ruleDirs?.length) throw new Error(`${configPath} has no ruleDirs list`);
	/** @type {Record<string, string>} */
	const hashes = { [CONFIG_KEY]: hash(config) };
	for (const file of ruleDirs.flatMap((dir) => yamlFiles(resolve(root, dir)))) {
		// One file can hold several rules, separated by `---` lines.
		for (const doc of readFileSync(file, "utf8").replace(/\r\n/g, "\n").split(/^---\s*$/m)) {
			const id = /^id:\s*["']?([^"'\s#]+)/m.exec(doc)?.[1];
			if (id) hashes[id] = hash(doc);
		}
	}
	const utilFiles = (configList(config, "utilDirs") ?? []).flatMap((dir) => yamlFiles(resolve(root, dir)));
	if (utilFiles.length) hashes[UTILS_KEY] = hash(utilFiles.map((file) => `${relative(root, file)}\n${readFileSync(file, "utf8")}`).join("\n"));
	return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
