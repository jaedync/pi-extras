import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// PI_TEST_AGENT_ROOT alone changes fixture paths, not bare imports. Opt in to test the actual host classes too.
if (process.env.PI_TEST_AGENT_ROOT) {
	const root = resolve(process.env.PI_TEST_AGENT_ROOT);
	const packages = new Map(["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core"].map((short) => {
		const name = `@earendil-works/${short}`;
		const candidates = short === "pi-coding-agent" ? [root] : [join(root, "node_modules", name), join(dirname(root), short)];
		const directory = candidates.find((path) => existsSync(join(path, "dist/index.js")));
		if (!directory) throw new Error(`Cannot locate ${name} in the selected Pi runtime: ${root}`);
		return [name, pathToFileURL(join(directory, "dist/index.js")).href];
	}));
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const name = specifier.startsWith("@earendil-works/") ? specifier.split("/").slice(0, 2).join("/") : undefined;
			if (!packages.has(name)) return nextResolve(specifier, context);
			if (specifier !== name) return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(root, "package.json")).href });
			return { url: packages.get(name), shortCircuit: true };
		},
	});
}
