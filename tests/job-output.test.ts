import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { overwritten } from "../lib/band/job-look.ts";
import { createCompletionRenderer } from "../lib/shell-jobs-render.ts";
import { quiet } from "./support/quiet-theme.ts";

test("output reads as a terminal leaves it: a carriage return overwrites its line", () => {
	assert.equal(overwritten("  5%\r 50%\r100%\nnext"), "100%\nnext");
	assert.equal(overwritten("line\r\nnext\r\n"), "line\nnext\n");
	assert.equal(overwritten("abc\r"), "abc");
	assert.equal(overwritten("plain\ntext"), "plain\ntext");
});

test("a download's completion shows curl's last meter line, not every update run together", () => {
	const meter = (percent: number) => `${String(percent).padStart(3)} 48.0M ${String(percent).padStart(4)} ${(percent * 0.48).toFixed(1)}M    0     0  1492k      0  0:00:32  0:00:10  0:00:22 1495k`;
	const log = [
		"  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
		"                                 Dload  Upload   Total   Spent    Left  Speed",
		[0, 30, 60, 100].map(meter).join("\r"),
	].join("\n");
	const message = {
		customType: "shell-job-complete",
		content: `Job download-dataset finished: exit 0 after 32.7s\nlog: /tmp/download-dataset.log\n\n${log}`,
		details: { code: 0, durationMs: 32_700, command: "curl -o data.bin http://127.0.0.1:8765/data.bin", title: "Download dataset" },
	};
	const lines = createCompletionRenderer()(message as any, { expanded: false } as any, quiet() as any)!.render(140).map(stripTerminalSequences);
	const last = lines.at(-1)!;
	assert.ok(last.includes(meter(100)), last);
	assert.ok(!last.includes(meter(60)), "earlier updates are overwritten");
	assert.equal(lines.filter((line) => line.includes("48.0M")).length, 1);
});
