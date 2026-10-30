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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

const page = (body, style = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px/1.5 system-ui;color:#1a1a1a}${style}</style></head><body>${body}</body></html>`;

test("collector edge cases: error pages, SVG documents, shadow DOM, :focus-within, hidden root overflow", { skip, timeout: 180_000 }, async () => {
	const out = mkdtempSync(join(tmpdir(), "redline-edge-"));
	const server = createServer((_, res) => res.writeHead(500, { "content-type": "text/html" }).end("<p>Internal error</p>"));
	try {
		const { chromium } = await loadChromium();
		const audit = async (name, html, ext = "html") => {
			const file = join(out, `${name}.${ext}`);
			writeFileSync(file, html);
			return runAudit({ chromium, target: file, out: join(out, name) });
		};
		const ids = (result) => new Set(Object.values(result.views).flatMap((v) => v.findings.map((f) => f.id)));

		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
		await assert.rejects(runAudit({ chromium, target: `http://127.0.0.1:${port}/`, out: join(out, "error"), views: ["desktop"] }), /HTTP 500/);

		const svg = await audit("drawing", '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="50">Chart</text></svg>', "svg");
		assert.ok(svg.views.desktop, "an SVG document is audited without a crash");

		const shadow = await audit("shadow", page('<p>Host below</p><x-card></x-card><script>customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<p>Supercharge your workflow 🚀</p>"; } });</script>'));
		const shadowIds = ids(shadow);
		assert.ok(shadowIds.has("hype-words") && shadowIds.has("emoji"), "open shadow roots are read");

		const within = await audit("within", page('<label class="field"><span>Name</span><input aria-label="Name"></label>', ".field{display:inline-flex;gap:8px;padding:8px;border:1px solid #888;border-radius:8px}.field:focus-within{outline:2px solid #2563eb}.field input{outline:none;border:0;font:inherit}"));
		assert.equal(ids(within).has("focus-ring"), false, "a ring on the wrapper counts as visible focus");

		const hidden = await audit("hidden", page('<div style="width:600px">Wide strip</div><div style="height:1400px"></div><p style="color:#bbb">Muted note!!!</p>', "html,body{height:100%}body{overflow-x:hidden}"));
		const hiddenIds = ids(hidden);
		assert.equal(hiddenIds.has("horizontal-overflow"), false, "overflow the body hides cannot be scrolled to");
		assert.ok(hiddenIds.has("low-contrast") && hiddenIds.has("exclamation"), "content below the first screen is still read");
	} finally {
		server.close();
		rmSync(out, { recursive: true, force: true });
	}
});
