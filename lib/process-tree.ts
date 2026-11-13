/**
 * process-tree: a shell call that leaves no process behind. RED stub: the
 * operations are Pi's own, which kill only the shell's process group.
 */
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { ShellOperations } from "./chain/exec.ts";

export interface ShellConfig {
	readonly shell: string;
	readonly args: readonly string[];
	readonly commandTransport?: "argv" | "stdin";
}

export type TreeMode = "auto" | "scope" | "group";

export interface TreeOptions {
	readonly graceMs?: number;
	readonly mode?: TreeMode;
}

export function treeShellOperations(resolveShell: () => ShellConfig, _options: TreeOptions = {}): ShellOperations {
	return createLocalBashOperations({ shellPath: resolveShell().shell }) as ShellOperations;
}

export function scopeSupported(): boolean {
	return false;
}
