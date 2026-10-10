import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { toolRenderers } from "../lib/tool-display/tool.ts";
import { usageSpec } from "../lib/tool-display/usage.ts";
import { band, harness, row, text, theme } from "./support/tool-rows.ts";

const strip = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const reset = { resetsAt: "", resetsAtLocal: "Thu 3:00 AM", resetsInSeconds: 4 * 86400, resumeAfterSeconds: 0 };

const REPORT = {
	asOf: "", model: { provider: "anthropic", id: "claude-opus-5-5" }, warnings: "on", budget: null, snapshotAgeSeconds: {}, notes: [],
	limits: [
		{ provider: "anthropic", window: "7d", kind: "window", applies: true, usedPct: 59, status: "ok", reset,
			dollars: { basis: "implied", source: "tokenfold", scope: "all personal machines", spentUsd: 2725.26, limitUsd: 4619.08, remainingUsd: 1893.82, dataAgeSeconds: 27 } },
		{ provider: "anthropic", window: "5h", kind: "window", applies: true, usedPct: 3, status: "ok",
			dollars: { basis: "implied", source: "tokenfold", scope: "all personal machines", spentUsd: 22.48, dataAgeSeconds: 27, note: "Under 5% used: too little to size the window." } },
		{ provider: "opencode-go", window: "5h", kind: "window", applies: false, usedPct: 0, status: "ok",
			dollars: { basis: "plan cap", source: "plan table", perModel: { "deepseek-v4.1-flash": { limitUsd: 12, remainingUsd: 12 }, "glm-5.3": { limitUsd: 3, remainingUsd: 3 } } } },
		{ provider: "anthropic", window: "", kind: "budget", applies: true, status: "ok", remaining: "$829/$2000",
			dollars: { basis: "meter", source: "provider", limitUsd: 2000, spentUsd: 1170.83, remainingUsd: 829.17, resetsAt: "", resetsAtLocal: "Sat, Oct 31, 7:00 PM CDT",
				calendarDaysLeft: 22, businessDaysLeft: 15, perBusinessDayUsd: 55.28, spentTodayUsd: 40, leftTodayUsd: 15.28 } },
	],
	dollars: {
		date: "2026-10-10", timeZone: "America/Chicago", spentTodayThisMachineUsd: 160.3, spentTodayAllPersonalMachinesUsd: 516.1,
		providers: {
			anthropic: { spentTodayUsd: 160.29, remainingUsd: 1893.82, bindingWindow: "7d", unsizedWindows: ["5h"] },
			"opencode-go": { spentTodayUsd: 0.01, remainingUsdByModel: { "deepseek-v4.1-flash": 12, "glm-5.3": 3 } },
		},
		notes: ["Spend is the API list price."],
	},
};

const VERBATIM = JSON.stringify(REPORT, null, 1);

function opened() {
	const h = harness();
	const usage = row(toolRenderers(h.kit, usageSpec) as never, { all: true });
	usage.update({ isPartial: false, result: text(VERBATIM, REPORT) });
	return { h, usage };
}

test("the band adds the dollars left for the active provider", () => {
	const { usage } = opened();
	assert.equal(usage.lines()[0], band("usage 7d 59% 5h 3%, $1,894 left"));
});

test("the popup names providers and shows each limit's dollars under it", () => {
	const { h, usage } = opened();
	usage.click();
	const output = strip(h.popups.at(-1)!.output(theme, 200, 0));
	assert.deepEqual(output.slice(0, 10), [
		"anthropic 7d     59%  resets in 4d (Thu 3:00 AM)",
		"                      $1,893.82 left of $4,619.08, $2,725.26 spent, Tokenfold (all personal machines), 27s old",
		"anthropic 5h      3%",
		"                      $22.48 spent, Tokenfold (all personal machines), 27s old",
		"                      Under 5% used: too little to size the window.",
		"opencode-go 5h    0%  other model",
		"                      deepseek-v4.1-flash $12.00 of $12.00, glm-5.3 $3.00 of $3.00",
		"anthropic       $829/$2000",
		"                      $829.17 left of $2,000.00, resets Sat, Oct 31, 7:00 PM CDT",
		"                      15 business days left, $55.28 per business day, $40.00 spent today, $15.28 left today",
	]);
});

test("the popup ends with today's spend and the dollars left per provider", () => {
	const { h, usage } = opened();
	usage.click();
	const output = strip(h.popups.at(-1)!.output(theme, 200, 0));
	const start = output.indexOf("Dollars, 2026-10-10 (America/Chicago)");
	assert.ok(start > 0);
	assert.deepEqual(output.slice(start, start + 6), [
		"Dollars, 2026-10-10 (America/Chicago)",
		"today: $160.30 on this machine, $516.10 on all personal machines",
		"anthropic: $160.29 today, $1,893.82 left (7d), no size yet: 5h",
		"opencode-go: $0.01 today, deepseek-v4.1-flash $12.00 left, glm-5.3 $3.00 left",
		"",
		"Spend is the API list price.",
	]);
});

test("the popup copies the verbatim JSON the model received", () => {
	const { h, usage } = opened();
	usage.click();
	const copy = h.popups.at(-1)!.copies!(0).find((item) => item.key === "j");
	assert.equal(copy?.label, "copy JSON");
	assert.equal(copy?.text(), VERBATIM);
	assert.ok(h.popups.at(-1)!.copies!(0).some((item) => item.key === "o"));
});
