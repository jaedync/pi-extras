import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPlanAuthFile } from "../../lib/plan-billing.ts";

/** Point lib/plan-billing.ts at a temp auth.json whose openai login is Sign in with ChatGPT (`oauth`) or an API key, for one test. */
export function openaiLogin(t: { after(fn: () => void): void }, type: "oauth" | "api_key" = "oauth"): void {
	const dir = mkdtempSync(join(tmpdir(), "plan-login-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { type } }));
	setPlanAuthFile(join(dir, "auth.json"));
	t.after(() => {
		setPlanAuthFile(undefined);
		rmSync(dir, { recursive: true, force: true });
	});
}
