/**
 * The fingerprint of a plan, written into index.html and checked by the gates.
 * A project whose index.html was built from another plan renders something the
 * gates never measured: a hand-edited plan.json, or a compose that failed after
 * it wrote the plan.
 */
import { createHash } from "node:crypto";

export function planFingerprint(plan) {
	return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16);
}

/** The fingerprint in index.html, or null when the file has none. */
export function planHashInHtml(html) {
	const match = /data-plan-hash="([0-9a-f]{16})"/.exec(String(html ?? ""));
	return match ? match[1] : null;
}
