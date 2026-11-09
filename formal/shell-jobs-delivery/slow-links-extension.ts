/**
 * Stand-in for Pull Link auto-pull in the gap repro (repro-gap.mts). It runs
 * the real auto-pull code (lib/link-context/auto.ts): its before_agent_start
 * handler awaits the link reads before the run's agent loop starts. Only the
 * network read is replaced: each read takes READ_MS and returns a short page,
 * because link-context refuses local addresses and the repro runs offline.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTimeout as sleep } from "node:timers/promises";
import { registerAutoPull } from "../../lib/link-context/auto.ts";
import { loadConfig } from "../../lib/link-context/config.ts";
import type { LinkReader } from "../../lib/link-context/reader.ts";

export const READ_MS = 2_000;

const reader = {
	async readPlain(url: string) {
		await sleep(READ_MS);
		return { cached: false, pulled: { platform: "web", title: "Example page", url, markdown: "Example page text." } };
	},
	read() {
		throw new Error("not used by auto-pull");
	},
} as unknown as LinkReader;

export default function (pi: ExtensionAPI): void {
	registerAutoPull(pi, { reader, config: () => ({ ...loadConfig(), autoPull: true }) });
}
