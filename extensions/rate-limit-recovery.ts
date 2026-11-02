/** Deterministic quota hibernation, and bounded backoff for short rate limits and connection failures. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Recovery, type RecoveryOptions } from "../lib/rate-limit-recovery/controller.ts";

export { RECOVERY_TYPE, type RecoveryOptions } from "../lib/rate-limit-recovery/controller.ts";

export default function recovery(pi: ExtensionAPI, options: RecoveryOptions = {}): void {
	new Recovery(pi, options).register();
}
