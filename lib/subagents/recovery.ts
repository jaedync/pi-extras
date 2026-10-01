/** Automatic retries belong to one interruption, not every later session start. */
import { randomUUID } from "node:crypto";
import type { AgentRecord } from "./types.ts";
import type { SubagentsConfig } from "./config.ts";

const slot = Symbol.for("pi-extras.subagents.session-owners");
const shared = globalThis as unknown as Record<symbol, WeakMap<object, string> | undefined>;
const owners = shared[slot] ??= new WeakMap();

/** Pi retains the same SessionManager on reload, but a second SDK parent has a distinct manager. */
export function recoveryOwner(sessionManager: object): string {
	let owner = owners.get(sessionManager);
	if (!owner) { owner = randomUUID(); owners.set(sessionManager, owner); }
	return owner;
}

interface RecoveryContext {
	reason: string;
	policy: SubagentsConfig["resumePolicy"];
	shutdown?: string;
	shutdownOwner?: string;
	owner: string;
	allowed: ReadonlySet<string>;
	moved: boolean;
}

export function recoveryDecision(record: AgentRecord, context: RecoveryContext): { resume: boolean; why: string } {
	if (record.restoreError) return { resume: false, why: record.restoreError };
	if (record.parent !== "main") return { resume: false, why: `Paused. Its parent ${record.parent} or /subagents resume ${record.name} can resume it.` };
	if (context.moved) return { resume: false, why: "Paused. The workspace moved; inspect and resume explicitly in the current workspace." };
	if (!context.allowed.has(record.model)) return { resume: false, why: "Paused. Its model is out of scope; explicit resume uses the current default model." };
	if (record.orphaned || !record.interruptionId || !record.interruptedBy) return { resume: false, why: "Paused. Legacy and orphan interruptions require explicit resume." };
	if ((record.autoResumeAttempts ?? 0) >= 1) return { resume: false, why: "Paused. Its one automatic resume attempt was already used; resume explicitly." };
	const reload = context.reason === "reload" && context.shutdown === "reload" && record.interruptedBy === "reload"
		&& context.shutdownOwner === context.owner && record.interruptedOwner === context.owner;
	const resume = context.policy === "always" || (context.policy === "reload" && reload);
	return { resume, why: resume ? "Resumed automatically; it will verify files before continuing." : "Paused. Resume explicitly; do not wait for a report yet." };
}
