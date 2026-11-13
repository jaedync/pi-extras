/**
 * tree-bash: the bash operations that pi-extras gives Pi's bash tool, in the
 * main session (Tool Display) and in subagents. They end every process of a
 * call when it ends (lib/process-tree.ts). They are on by default on Linux
 * only (`treeKillOn`); elsewhere Pi's own operations run. PI_TREE_KILL=1 turns
 * them on elsewhere (not Windows), and PI_TREE_KILL=0 turns them off on Linux.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { treeKillOn, treeShellOperations } from "./process-tree.ts";

/** What these operations take from Pi's SDK: the one Pi runs with, so the shell is found as Pi finds it. */
export interface BashSdk {
	createLocalBashOperations(options?: { shellPath?: string }): BashOperations;
	getShellConfig(customShellPath?: string): { shell: string; args: string[]; commandTransport?: "argv" | "stdin" };
}

const treeKills = () => treeKillOn();

export function treeBashOperations(sdk: BashSdk, shellPath: string | undefined): BashOperations {
	if (!treeKills()) return sdk.createLocalBashOperations(shellPath ? { shellPath } : undefined);
	return treeShellOperations(() => sdk.getShellConfig(shellPath)) as BashOperations;
}

/** The bash guideline that tells the model about the end of a call. */
export const TREE_GUIDELINE = "Background processes that a bash call starts end when the call ends; to keep one, start it as a shell job or with `systemd-run --user --unit=<name> <command>`.";

/** A bash definition with the tree guideline added, where these operations end the tree. */
export function withTreeGuideline<T extends { promptGuidelines?: string[] | undefined }>(definition: T): T {
	if (!treeKills()) return definition;
	return { ...definition, promptGuidelines: [...(definition.promptGuidelines ?? []), TREE_GUIDELINE] };
}
