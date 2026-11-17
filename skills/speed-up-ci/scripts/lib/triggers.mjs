/**
 * Inputs that reach tests through no import edge: an import-graph selector (vitest --changed, nx affected,
 * turbo --affected) cannot see a change to them, so a change to any of them runs the full suite.
 */
export const DEFAULT_TRIGGERS = [
	// Dependency versions can change any test.
	"**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/bun.lock", "**/bun.lockb", "**/npm-shrinkwrap.json",
	"**/uv.lock", "**/poetry.lock", "**/Pipfile.lock", "**/requirements*.txt", "**/Cargo.lock", "**/go.sum", "**/Gemfile.lock",
	"**/package.json", "**/pnpm-workspace.yaml", "**/pyproject.toml", "**/go.mod", "**/Cargo.toml",
	"**/patches/**", "**/.npmrc", "**/.yarnrc*", "**/bunfig.toml",
	// Tool and runtime config that every test reads.
	"**/tsconfig*.json", "**/{vite,vitest,jest,playwright,babel,webpack,rollup,turbo,nx}.config.*", "**/vitest.workspace.*",
	"**/.babelrc*", "**/.swcrc", "**/setup-tests.*", "**/test-setup.*", "**/vitest.setup.*", "**/jest.setup.*",
	"**/global{-setup,Setup,setup,-teardown,Teardown,teardown}.*", "**/__mocks__/**",
	"**/conftest.py", "**/pytest.ini", "**/setup.cfg", "**/tox.ini", "**/nx.json", "**/turbo.json",
	".nvmrc", ".node-version", ".tool-versions", ".python-version", "**/.env*",
	// The CI definition and this selector with its own trigger list, the containers, and data that tests read from disk.
	".github/**", ".ci/**", "**/Dockerfile*", "**/{docker-compose,compose}*.{yml,yaml}", "**/__snapshots__/**", "**/*.snap", "**/fixtures/**", "**/__fixtures__/**", "**/testdata/**",
	"**/migrations/**", "**/*.sql", "**/schema.prisma", "**/openapi.{json,yaml,yml}", "**/*.graphql",
];

/** @param {string} text */
function escape(text) {
	return text.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

/**
 * A glob over a whole repository-relative path: `*` and `?` stay inside one path segment, `**` crosses them, and
 * `{a,b}` is a choice.
 * @param {string} glob
 */
export function globToRegExp(glob) {
	return new RegExp(`^${globSource(glob)}$`);
}

/** @param {string} glob */
function globSource(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			out += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (char === "*") out += "[^/]*";
		else if (char === "?") out += "[^/]";
		else if (char === "{") {
			const end = glob.indexOf("}", i);
			if (end < 0) { out += "\\{"; continue; }
			if (glob.slice(i + 1, end).includes("{")) throw new Error(`nested braces are not supported: ${glob}`);
			out += `(?:${glob.slice(i + 1, end).split(",").map(globSource).join("|")})`;
			i = end;
		} else out += escape(char);
	}
	return out;
}

/**
 * One glob per line; `#` starts a comment line. A line `--no-defaults` drops the built-in list. As in .gitignore, a
 * leading `./` or `/` anchors a line at the repository root, and a line with no slash matches at any depth.
 * @param {string} text
 */
export function parseTriggerFile(text) {
	const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
	const globs = lines.filter((line) => line !== "--no-defaults").map((line) => {
		if (line.startsWith("./")) return line.slice(2);
		if (line.startsWith("/")) return line.slice(1);
		return line.includes("/") ? line : `**/${line}`;
	});
	for (const glob of globs) globToRegExp(glob);
	return { globs, defaults: !lines.includes("--no-defaults") };
}

/**
 * Full when a changed path matches a trigger, when a file was deleted (it is in no import graph, so a selector cannot
 * find the tests that imported it), when git quoted a path (it cannot match a glob), or when there is no diff to judge
 * (an unknown diff must not narrow the run). Affected otherwise.
 * @param {{ status: string, path: string }[]} changed git diff --name-status entries
 * @param {string[]} globs
 * @returns {{ mode: "full" | "affected", reasons: { file: string, glob: string }[] }}
 */
export function decide(changed, globs) {
	if (changed.length === 0) return { mode: "full", reasons: [{ file: "(no changed files)", glob: "-" }] };
	const compiled = globs.map((glob) => ({ glob, re: globToRegExp(glob) }));
	const reasons = [];
	for (const { status, path } of changed) {
		if (status.startsWith("D")) {
			reasons.push({ file: path, glob: "(deleted)" });
			continue;
		}
		// Git quotes these also with core.quotePath=false, so a selector that reads git output cannot match the path.
		if (/^"|[\u0000-\u001f\u007f"\\]/.test(path)) {
			reasons.push({ file: path, glob: "(quoted path)" });
			continue;
		}
		const hit = compiled.find(({ re }) => re.test(path));
		if (hit) reasons.push({ file: path, glob: hit.glob });
	}
	return { mode: reasons.length > 0 ? "full" : "affected", reasons };
}
