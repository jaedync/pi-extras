/**
 * The rendered audit end to end, opt-in: set UI_REDLINE_INTEGRATION=1. It needs
 * playwright-core (the redline cache, the walkthrough-video cache or this
 * repo's node_modules) and Chromium's headless shell.
 *
 * slop.html carries the signs on purpose; clean.html is the same screen
 * redesigned and must come out with no findings, so a rule that starts to fire
 * on good work fails here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAudit } from "../skills/ui-redline/scripts/lib/audit.mjs";
import { compareAudits } from "../skills/ui-redline/scripts/lib/report.mjs";
import { loadChromium } from "../skills/ui-redline/scripts/lib/runtime.mjs";

const skip = process.env.UI_REDLINE_INTEGRATION === "1" ? false : "set UI_REDLINE_INTEGRATION=1 to render the fixtures";
const fixture = (name) => fileURLToPath(new URL(`./fixtures/ui-redline/${name}`, import.meta.url));

test("slop fixture: the planted signs are found; clean fixture: nothing is", { skip, timeout: 120_000 }, async () => {
	const out = mkdtempSync(join(tmpdir(), "redline-audit-"));
	try {
		const { chromium } = await loadChromium();
		const slop = await runAudit({ chromium, target: fixture("slop.html"), out: join(out, "slop") });
		const found = new Set(Object.values(slop.views).flatMap((v) => v.findings.map((f) => f.id)));
		const planted = ["hue-gradient", "gradient-text", "colored-glow", "color-wash", "low-contrast", "text-colors", "neon-border", "heavy-weight", "tracked-caps", "tiny-text", "tabular-figures", "mixed-number-format", "off-grid", "uneven-siblings", "uneven-rhythm", "emoji", "exclamation", "hype-words", "unverified-claims", "greeting", "trailing-period", "looping-animation", "transition-all", "focus-ring", "mobile-viewport"];
		assert.deepEqual(planted.filter((id) => !found.has(id)), [], "every planted sign is found");
		assert.equal(found.has("placeholder-data"), false, "10,000+ is a claim, not placeholder data");

		const clean = await runAudit({ chromium, target: fixture("clean.html"), out: join(out, "clean") });
		const leftovers = Object.values(clean.views).flatMap((v) => v.findings.map((f) => `${f.id}: ${f.instances[0]?.detail ?? ""}`));
		assert.deepEqual(leftovers, [], "the clean screen has no findings");
		assert.deepEqual(clean.scores, { slop: 100, craft: 100 });
		assert.equal(clean.views.desktop.focusChecked > 0, true, "keyboard focus was probed");
		assert.equal(compareAudits(slop, clean).pass, true);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
