import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { readSession, SESSION_CHECK } from "../lib/windows-use/desktop-session.ts";
import { screenshotGeometry, screenshotPng } from "../lib/windows-use/display.ts";
import { RESTART_SHELL_UI } from "../lib/windows-use/stall.ts";
import { readFrame, toPng } from "../lib/windows-use/frame.ts";
import { hostFrame } from "./support/windows-frames.ts";

const report = (overrides = {}) => `Response: PI_WINDOWS_SESSION=${JSON.stringify({ id: 1, console: 1, state: 0, locked: false, elevated: false, ...overrides })}\nStatus Code: 0`;

test("session reports are structured, locale-independent, and distinguish remote from disconnected", () => {
	assert.deepEqual(readSession(report()), { id: 1, where: "console", active: true, disconnected: false, locked: false, elevated: false });
	assert.equal(readSession(report({ console: 3 })).where, "remote");
	assert.equal(readSession(report({ state: 4 })).disconnected, true);
	assert.equal(readSession(report({ state: 4 })).active, false);
	assert.equal(readSession(report({ console: 0xffffffff })).where, "unknown");
	assert.equal(readSession(report({ locked: true, elevated: true })).elevated, true);
	for (const value of ["", "Response: unlocked limited\nStatus Code: 0", report().replace("Code: 0", "Code: 1"), report({ id: 0 }), report({ id: "1" }), report({ console: -1 }), report({ console: 2 ** 32 }), report({ state: 10 }), report({ state: 0.5 }), report({ locked: "false" }), report({ elevated: null }), "Response: PI_WINDOWS_SESSION={bad}\nStatus Code: 0"]) {
		assert.throws(() => readSession(value), /could not report.*session/);
	}
});

test("the live check uses WTS and frees its native buffer; lock checks stay in its own session", () => {
	assert.match(SESSION_CHECK, /WTSGetActiveConsoleSessionId/);
	assert.match(SESSION_CHECK, /WTSQuerySessionInformationW\(IntPtr.Zero, session, 8,/);
	assert.match(SESSION_CHECK, /finally\s*\{[\s\S]*WTSFreeMemory\(buffer\)/);
	assert.match(SESSION_CHECK, /SessionId -eq \$me/);
	assert.doesNotMatch(SESSION_CHECK, /\$env:(?:SESSIONNAME|CLIENTNAME)|\bquser\b(?! text)/i);
});

const pngResult = (data: Buffer, mimeType = "image/png", isError = false) => ({ content: [{ type: "image" as const, mimeType, data: data.toString("base64") }], isError });

test("guest screenshots are bounded PNGs before host OCR sees them", () => {
	const png = toPng(readFrame(hostFrame({ taskbar: true, width: 64, height: 48 })));
	assert.deepEqual(screenshotPng(pngResult(png)), { data: png, width: 64, height: 48 });
	for (const bad of [pngResult(png, "image/jpeg"), pngResult(png, "image/png", true), pngResult(Buffer.from("not png")), { content: [], isError: false }]) assert.throws(() => screenshotPng(bad), /PNG screenshot/);
	for (const [w, h] of [[0, 48], [64, 1], [8193, 48], [8192, 8192]]) {
		const invalid = Buffer.from(png);
		invalid.writeUInt32BE(w!, 16); invalid.writeUInt32BE(h!, 20);
		assert.throws(() => screenshotPng(pngResult(invalid)), /dimensions/);
	}
	assert.throws(() => screenshotPng(pngResult(Buffer.alloc(16 * 1024 * 1024 + 1))), /16 MiB/);
});

test("screenshot geometry honors native dimensions, monitor origins and listed metadata", () => {
	const image = { width: 1920, height: 540 };
	const metadata = "Screenshot Original Size: (3840,1080)\nVisible Displays: 0:DISPLAY (-1920,0,0,1080); 1:DISPLAY (0,0,1920,1080) primary\n";
	const result = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });
	assert.deepEqual(screenshotGeometry(result(metadata), image), { x: -1920, y: 0, width: 3840, height: 1080, scaleX: 2, scaleY: 2 });
	assert.deepEqual(screenshotGeometry(result(JSON.stringify([metadata])), image), screenshotGeometry(result(metadata), image));
	const crop = "Screenshot Size: (1920,540)\nScreenshot Region: (-100,200,1820,740)";
	assert.equal(screenshotGeometry(result(crop), image).y, 200);
	for (const text of ["", metadata.replace("(3840,1080)", "(3841,1080)"), metadata.replace("(3840,1080)", "(9000,1080)"), metadata.replace("(3840,1080)", "(100,1080)"), metadata.replace("(-1920,0,0,1080)", "(-1920,0,-1921,1080)"), "Screenshot Size: (3840,1080)"]) {
		assert.throws(() => screenshotGeometry(result(text), image), /geometry/);
	}
});

test("shell UI recovery is restricted to the server's own desktop session", () => {
	assert.match(RESTART_SHELL_UI, /SessionId -eq \$me/);
});

test("host image OCR bounds dimensions before decoding and frees image resources", () => {
	const ocr = readFileSync(new URL("../lib/windows-use/ocr.psm1", import.meta.url), "utf8");
	const image = ocr.slice(ocr.indexOf("function Read-ImageText"));
	assert.match(image, /16777216/);
	assert.ok(image.indexOf("Assert-ImageSize") >= 0 && image.indexOf("Assert-ImageSize") < image.indexOf("PngBitmapDecoder"), "reject oversized headers before decoding pixel data");
	assert.match(image, /finally \{ \$stream.Dispose\(\) \}/);
	assert.match(ocr, /finally \{ \$bitmap.Dispose\(\) \}/);
	assert.match(ocr, /MaxImageDimension/);
});
