/**
 * Subcommands of `/pi-extras`. Pi lets one command name have one handler, and
 * release-notes owns `/pi-extras`, so other extensions add subcommands here
 * (auto-update adds `update`). The table is on the global object because
 * each extension gets its own copy of this module.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface Subcommand {
	readonly description: string;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

const SLOT = Symbol.for("pi-extras.command.subcommands.v1");

function table(): Map<string, Subcommand> {
	const shared = globalThis as { [SLOT]?: Map<string, Subcommand> };
	shared[SLOT] ??= new Map();
	return shared[SLOT];
}

/** Adds or replaces a subcommand. Returns the removal, for session shutdown: a reload registers it again. */
export function registerSubcommand(name: string, subcommand: Subcommand): () => void {
	table().set(name, subcommand);
	return () => {
		if (table().get(name) === subcommand) table().delete(name);
	};
}

export function subcommand(name: string): Subcommand | undefined {
	return table().get(name);
}

export function subcommandNames(): { name: string; description: string }[] {
	return [...table()].map(([name, entry]) => ({ name, description: entry.description }));
}
