/** Fake uv and git on PATH, so ensureMedia runs its real steps with no network and no real install. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const UV = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls.log"
case "$1" in
--version) echo "uv 99.0.0" ;;
venv) mkdir -p "$5/bin" && : > "$5/bin/python" ;;
esac
exit 0
`;

// The token provider's clone fails, as it does on a host without git; ensureMedia records it and goes on.
const GIT = `#!/bin/sh
echo "git $*" >> "$(dirname "$0")/calls.log"
exit 1
`;

// A clone that works: an empty server folder, so the next step (npm ci) fails fast with no lock file and no network.
const CLONING_GIT = `#!/bin/sh
echo "git $*" >> "$(dirname "$0")/calls.log"
for last; do :; done
mkdir -p "$last/server"
exit 0
`;

export interface FakeTools {
	readonly calls: () => string[];
	readonly restore: () => void;
}

export function fakeMediaTools(dir: string, options: { cloneWorks?: boolean } = {}): FakeTools {
	const bin = join(dir, "fake-bin");
	mkdirSync(bin, { recursive: true });
	for (const [name, body] of [["uv", UV], ["git", options.cloneWorks ? CLONING_GIT : GIT]] as const) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const saved = { PATH: process.env.PATH, PI_OFFLINE: process.env.PI_OFFLINE };
	process.env.PATH = [bin, saved.PATH].filter(Boolean).join(delimiter);
	delete process.env.PI_OFFLINE;
	return {
		calls: () => {
			try {
				return readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n");
			} catch {
				return [];
			}
		},
		restore: () => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}
