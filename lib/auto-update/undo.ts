/**
 * A copy of what `disable` needs (the enable record and the original
 * settings entries) in Pi's agent dir, beside pi-extras.json. state.json in
 * the store has the same data, but settings.json names store folders, so a
 * deleted or moved store must not leave the user without a way back.
 */
import { join } from "node:path";
import { rmSync } from "node:fs";
import { readJsonObject, writeJsonAtomic } from "../json-file.ts";
import type { EnableRecord, ManagedEntry } from "./state.ts";

export const UNDO_VERSION = 1;

export interface UndoRecord {
	readonly version: number;
	/** The store root that settings.json entries name. */
	readonly storeRoot: string;
	readonly enabled: EnableRecord;
	readonly managed: Readonly<Record<string, ManagedEntry>>;
}

export const undoFile = (agentDir: string): string => join(agentDir, "pi-extras-update-undo.json");

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Written atomically, mode 0600 for a new file: entries can hold token URLs. */
export function writeUndo(agentDir: string, record: Omit<UndoRecord, "version">): void {
	writeJsonAtomic(undoFile(agentDir), { version: UNDO_VERSION, ...record });
}

/** The copy, or undefined when there is none or it is not one this code wrote. */
export function readUndo(agentDir: string): UndoRecord | undefined {
	let raw: Record<string, unknown>;
	try {
		raw = readJsonObject(undoFile(agentDir));
	} catch {
		return undefined;
	}
	const enabled = raw.enabled as Record<string, unknown> | undefined;
	if (raw.version !== UNDO_VERSION || typeof raw.storeRoot !== "string" || !isObject(enabled) || typeof enabled.launcher !== "string" || typeof enabled.previousLink !== "string" || !isObject(raw.managed)) return undefined;
	return raw as unknown as UndoRecord;
}

export function removeUndo(agentDir: string): void {
	rmSync(undoFile(agentDir), { force: true });
}
