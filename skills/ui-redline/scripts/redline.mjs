#!/usr/bin/env node
/**
 * ui-redline: measure a rendered screen for the signs of generated-looking UI.
 *
 *   redline setup [--check]        install playwright-core and Chromium's headless shell (once per host)
 *   redline audit <url|file>       render at desktop and mobile size, measure, save audit.json and screenshots
 *   redline compare <before> <after>   compare two audits rule by rule; exit 1 on a high finding or a regression
 *   redline scan <file|folder>     search source files (Tailwind and CSS) for the same signs
 *   redline rules                  list every rule with its severity and options
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit, VIEWS } from "./lib/audit.mjs";
import { compareAudits, formatAudit, formatCompare } from "./lib/report.mjs";
import { kindOf, normalizeConfig, RULES } from "./lib/rules/index.mjs";
import { loadChromium, setup } from "./lib/runtime.mjs";
import { formatScan, scanSource } from "./lib/scan.mjs";

const HELP = {
	setup: "redline setup [--check]\n  Installs playwright-core and Chromium's headless shell into ~/.cache/pi-ui-redline. --check only reports.",
	audit: `redline audit <url|file> [--out dir] [--views desktop,mobile] [--width px] [--height px]
             [--scheme light|dark] [--config .redline.json] [--wait ms] [--facts] [--json]
  Renders the page at ${VIEWS.desktop.width}×${VIEWS.desktop.height} and ${VIEWS.mobile.width}×${VIEWS.mobile.height}, measures it and writes
  <out>/audit.json, <out>/<view>.png and <out>/<view>-redline.png (numbered boxes = finding numbers).
  --out defaults to ./redline-audit. --width and --height change the desktop view. A .redline.json in the
  current folder is read when --config is not given. --facts also saves the raw facts.`,
	compare: "redline compare <before> <after> [--json]\n  Each argument is an audit.json or the folder that holds one. Exit code 1 when a high finding is left or a rule got worse.",
	scan: "redline scan <file|folder> [--limit n] [--json]\n  Searches .html, .css, .jsx, .tsx, .vue, .svelte and similar files line by line.",
	rules: "redline rules [--json]\n  Lists the rules. Turn one off or change it in .redline.json: { \"rules\": { \"trailing-period\": \"off\", \"font-sizes\": { \"max\": 8 } } }",
};

/** The flags each command accepts: `true` for a switch, `false` for a flag that takes a value. */
export const FLAGS = {
	setup: { check: true },
	audit: { out: false, views: false, width: false, height: false, scheme: false, config: false, wait: false, facts: true, json: true },
	compare: { json: true },
	scan: { limit: false, json: true },
	rules: { json: true },
};

/** `--name value`, `--name=value` and `--switch` arguments; the rest are positional. Unknown flags are errors. */
export function parseArgs(argv, allowed = {}) {
	const known = { help: true, ...allowed };
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
		if (!(name in known)) throw new Error(`unknown flag --${name}; this command takes ${Object.keys(known).map((f) => `--${f}`).join(", ")}`);
		if (known[name]) {
			if (eq > 0) throw new Error(`--${name} takes no value`);
			flags[name] = true;
		} else if (eq > 0) flags[name] = arg.slice(eq + 1);
		else {
			if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`--${name} needs a value`);
			flags[name] = argv[++i];
		}
	}
	return { flags, positional };
}

function positiveInt(value, name) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number`);
	return n;
}

function loadConfig(path) {
	const file = path ?? (existsSync(".redline.json") ? ".redline.json" : null);
	if (!file) return {};
	let raw;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`cannot read the config ${file}: ${error.message}`);
	}
	return normalizeConfig(raw);
}

function readAudit(path) {
	const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "audit.json") : path;
	if (!existsSync(file)) throw new Error(`no audit at ${file}`);
	let audit;
	try {
		audit = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`cannot read the audit ${file}: ${error.message}`);
	}
	if (!audit?.views || typeof audit.views !== "object") throw new Error(`${file} is not a redline audit (no views)`);
	return audit;
}

async function audit({ flags, positional }) {
	const [target] = positional;
	if (!target) throw new Error(`name a URL or a file.\n${HELP.audit}`);
	const views = (flags.views ?? "desktop,mobile").split(",").map((v) => v.trim());
	for (const v of views) if (!VIEWS[v]) throw new Error(`unknown view "${v}"; use desktop, mobile or both`);
	if (flags.scheme && !["light", "dark"].includes(flags.scheme)) throw new Error("--scheme must be light or dark");
	const desktop = {};
	if (flags.width) desktop.width = positiveInt(flags.width, "width");
	if (flags.height) desktop.height = positiveInt(flags.height, "height");
	const { chromium } = await loadChromium();
	const result = await runAudit({
		chromium,
		target,
		out: resolve(flags.out ?? "redline-audit"),
		views,
		sizes: { desktop },
		scheme: flags.scheme,
		config: loadConfig(flags.config),
		wait: flags.wait === undefined ? undefined : positiveInt(flags.wait, "wait"),
		keepFacts: Boolean(flags.facts),
	});
	console.log(flags.json ? JSON.stringify(result, null, 2) : formatAudit(result));
}

async function main(argv) {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "help") {
		console.log(Object.values(HELP).join("\n\n"));
		return 0;
	}
	if (!HELP[command]) throw new Error(`unknown command "${command}"; use setup, audit, compare, scan or rules`);
	const args = parseArgs(rest, FLAGS[command]);
	if (args.flags.help) {
		console.log(HELP[command]);
		return 0;
	}
	switch (command) {
		case "setup": {
			const status = await setup({ check: Boolean(args.flags.check) });
			console.log(`playwright-core: ${status.playwright ?? "not installed"}\nchromium: ${status.browser ? "ok" : "not installed"}\ncache: ${status.root}`);
			return status.playwright && status.browser ? 0 : 1;
		}
		case "audit":
			await audit(args);
			return 0;
		case "compare": {
			const [before, after] = args.positional;
			if (!before || !after) throw new Error(HELP.compare);
			const result = compareAudits(readAudit(before), readAudit(after));
			console.log(args.flags.json ? JSON.stringify(result, null, 2) : formatCompare(result));
			return result.pass ? 0 : 1;
		}
		case "scan": {
			const [target] = args.positional;
			if (!target || !existsSync(target)) throw new Error(`name a file or folder that exists.\n${HELP.scan}`);
			const result = scanSource(target);
			console.log(args.flags.json ? JSON.stringify(result, null, 2) : formatScan(result, args.flags.limit ? positiveInt(args.flags.limit, "limit") : 10));
			return 0;
		}
		case "rules": {
			const list = RULES.map((r) => ({ id: r.id, kind: kindOf(r.id), category: r.category, severity: r.severity, views: r.views ?? ["desktop"], title: r.title, options: r.defaults ?? {} }));
			console.log(args.flags.json ? JSON.stringify(list, null, 2) : list.map((r) => `${r.severity.padEnd(6)} ${r.kind.padEnd(5)} ${r.id.padEnd(20)} ${r.title}${Object.keys(r.options).length ? `  ${JSON.stringify(r.options)}` : ""}`).join("\n"));
			return 0;
		}
	}
	return 0;
}

const invoked = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : null;
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(`redline: ${error.message}`);
			process.exitCode = 2;
		},
	);
}
