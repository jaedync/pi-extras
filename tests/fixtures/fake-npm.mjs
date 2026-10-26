// A stand-in for npm in the auto-update tests. The registry is a JSON file (FAKE_NPM_REGISTRY):
// { "<name>": { "version": "1.0.0", "dir": "<package source folder>" } }. Pi installs get a prefix
// whose bin/pi is FAKE_PI_CLI (the repo's development Pi). Every call is logged to FAKE_NPM_LOG.
// FAKE_NPM_SHAPE picks the output of `view --json`: "array" (npm 12.2.1: one element for each matched
// version, pretty-printed) or "plain" (older npm: the value itself).
import { appendFileSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, `${args.join(" ")}\n`);
const registry = JSON.parse(readFileSync(process.env.FAKE_NPM_REGISTRY, "utf8"));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fail = (text) => {
	process.stderr.write(`npm error ${text}\n`);
	process.exit(1);
};
const split = (spec) => {
	const at = spec.lastIndexOf("@");
	return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
};

if (args[0] === "--version") {
	process.stdout.write("12.0.0\n");
} else if (args[0] === "view") {
	const entry = registry[args[1]];
	if (!entry) fail("code E404");
	const value = args[2] === "version" ? entry.version : { "dist-tags": { latest: entry.version }, time: { [entry.version]: "2020-01-01T00:00:00Z" } };
	if (process.env.FAKE_NPM_SHAPE === "plain") process.stdout.write(`${JSON.stringify(value)}\n`);
	else if (process.env.FAKE_NPM_SHAPE === "array") process.stdout.write(`${JSON.stringify([value], null, 2)}\n`);
	else fail(`FAKE_NPM_SHAPE must be "array" or "plain", not ${process.env.FAKE_NPM_SHAPE}`);
} else if (args[0] === "install" && args.includes("--omit=dev")) {
	// Dependencies of a git clone: the fixtures have none.
} else if (args[0] === "install") {
	sleep(Number(process.env.FAKE_NPM_DELAY_MS ?? 0));
	const prefix = args[args.indexOf("--prefix") + 1];
	const spec = args.find((arg) => /^@?[^@]+@\d/.test(arg));
	const [name, version] = split(spec);
	const entry = registry[name];
	if (!entry || entry.version !== version) fail(`code ETARGET ${spec}`);
	if (args.includes("-g")) {
		const root = join(prefix, "lib", "node_modules", name);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
		mkdirSync(join(prefix, "bin"), { recursive: true });
		symlinkSync(process.env.FAKE_PI_CLI, join(prefix, "bin", "pi"));
	} else {
		const target = join(prefix, "node_modules", name);
		cpSync(entry.dir, target, { recursive: true });
		const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		writeFileSync(join(target, "package.json"), JSON.stringify({ ...manifest, version }));
	}
} else {
	fail(`unknown command ${args.join(" ")}`);
}
