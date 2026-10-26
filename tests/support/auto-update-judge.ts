/**
 * A fake smoke test for the culprit-search tests: it decides by the
 * versions in the tested set and records each set.
 */
import { basename } from "node:path";
import type { SmokeInput, SmokeResult } from "../../lib/auto-update/smoke.ts";
import { GIT_KEY, NPM_KEY } from "./auto-update-world.ts";

export const sourceOf = (entry: unknown): string => (typeof entry === "string" ? entry : (entry as { source: string }).source);

/** The versions in a smoke input: the Pi folder's name and each store entry's release id. */
export interface Versions {
	readonly pi: string;
	readonly git: string | undefined;
	readonly npm: string | undefined;
}

export function versionsOf(input: SmokeInput): Versions {
	const idAfter = (key: string) => {
		const entry = input.packages.map(sourceOf).find((path) => path.includes(`/${key}/`));
		return entry?.split(`/${key}/`)[1]!.split("/")[0]!.replace(/-[0-9a-f]{7}$/, "");
	};
	return { pi: basename(input.piDir), git: idAfter(GIT_KEY), npm: idAfter(NPM_KEY) };
}

/** A fake smoke test that decides by the versions in the set, and records each set it tested. */
export function judge(rule: (v: Versions) => SmokeResult) {
	const tested: string[] = [];
	const smoke = async (input: SmokeInput): Promise<SmokeResult> => {
		const v = versionsOf(input);
		tested.push(`pi ${v.pi}, git ${v.git}, npm ${v.npm}`);
		return rule(v);
	};
	return { smoke, tested };
}

export const PASS: SmokeResult = { ok: true, ms: 1 };
export const fail = (reason: string): SmokeResult => ({ ok: false, reason });
