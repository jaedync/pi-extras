import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResult } from "../lib/computer-use/session.ts";
import { WIN_API, WinSession } from "../lib/windows-use/api.ts";
import { readFrame, toPng } from "../lib/windows-use/frame.ts";
import type { Guest } from "../lib/windows-use/guest.ts";
import { checkImages, MAX_BASE64, MAX_SIDE, type Resize } from "../lib/windows-use/image-check.ts";
import { hostFrame } from "./support/windows-frames.ts";

const u32be = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const chunk = (type: string, data = Buffer.alloc(0)) => Buffer.concat([u32be(data.length), Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
/** A PNG header that claims a size; nothing past it is read without a decode. */
function pngClaiming(width: number, height: number, animated = false): Buffer {
	const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(animated ? [chunk("acTL", Buffer.alloc(8))] : []), chunk("IDAT"), chunk("IEND")]);
}
function jpegClaiming(width: number, height: number): Buffer {
	const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...Array(9).fill(0)]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function gifClaiming(width: number, height: number): Buffer {
	const size = Buffer.alloc(4);
	size.writeUInt16LE(width, 0);
	size.writeUInt16LE(height, 2);
	return Buffer.concat([Buffer.from("GIF89a", "latin1"), size, Buffer.alloc(8)]);
}
function webpClaiming(width: number, height: number): Buffer {
	const body = Buffer.alloc(10);
	body.writeUIntLE(width - 1, 4, 3);
	body.writeUIntLE(height - 1, 7, 3);
	const vp8x = Buffer.concat([Buffer.from("VP8X", "latin1"), Buffer.from([10, 0, 0, 0]), body]);
	const size = Buffer.alloc(4);
	size.writeUInt32LE(4 + vp8x.length);
	return Buffer.concat([Buffer.from("RIFF", "latin1"), size, Buffer.from("WEBP", "latin1"), vp8x]);
}
const realPng = () => toPng(readFrame(hostFrame({ taskbar: true, width: 64, height: 48 })));
const result = (data: Buffer, mimeType = "image/png"): ToolResult => ({ content: [{ type: "text", text: "Screenshot" }, { type: "image", data: data.toString("base64"), mimeType }], isError: false });
const noResize: Resize = async () => { throw new Error("resize should not run"); };

test("an image inside Pi's read-tool limits goes as it is, typed by its bytes and not its label", async () => {
	const png = realPng();
	const checked = await checkImages(result(png, "image/jpeg"), noResize);
	assert.deepEqual(checked.content, [{ type: "text", text: "Screenshot" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
	for (const [bytes, mimeType] of [[jpegClaiming(800, 600), "image/jpeg"], [gifClaiming(800, 600), "image/gif"], [webpClaiming(800, 600), "image/webp"]] as const) {
		const kept = await checkImages(result(bytes, "image/png"), noResize);
		assert.equal(kept.content[1]?.type === "image" && kept.content[1].mimeType, mimeType);
	}
});

test("bytes that are no supported image, an animated PNG, and an absurd pixel count are dropped with a note", async () => {
	for (const bytes of [Buffer.from("<html>error</html>"), pngClaiming(100, 100, true), pngClaiming(100_000, 100_000), Buffer.from("BM" + "x".repeat(40), "latin1")]) {
		const checked = await checkImages(result(bytes), noResize);
		assert.ok(!checked.content.some((block) => block.type === "image"), "no image goes on");
		assert.match(checked.content.at(-1)!.type === "text" ? (checked.content.at(-1) as { text: string }).text : "", /\[windows_use dropped the screenshot: /);
	}
});

test("an image over 2000 px a side or 4.5 MB is scaled with Pi's resizeImage, with a note to map coordinates back", async () => {
	const asked: unknown[] = [];
	const resize: Resize = async (bytes, mimeType, options) => {
		asked.push([bytes.length > 0, mimeType, options]);
		return { data: "c2NhbGVk", mimeType: "image/jpeg", originalWidth: 3000, originalHeight: 1500, width: 2000, height: 1000, wasResized: true };
	};
	const checked = await checkImages(result(pngClaiming(3000, 1500)), resize);
	assert.deepEqual(asked, [[true, "image/png", { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, maxBytes: MAX_BASE64 }]]);
	assert.deepEqual(checked.content.slice(1), [
		{ type: "image", data: "c2NhbGVk", mimeType: "image/jpeg" },
		{ type: "text", text: "[Image: original 3000x1500, displayed at 2000x1000. Multiply coordinates by 1.50 to map to original image.]" },
	]);
	const heavy = Buffer.concat([pngClaiming(1000, 800), Buffer.alloc(Math.ceil(MAX_BASE64 * 3 / 4))]);
	await checkImages(result(heavy), resize);
	assert.equal(asked.length, 2, "a small picture in a large file is scaled too");
	const failed = await checkImages(result(pngClaiming(3000, 1500)), async () => null);
	assert.ok(!failed.content.some((block) => block.type === "image"));
	assert.match((failed.content.at(-1) as { text: string }).text, /could not be scaled down/);
	const broken = await checkImages(result(pngClaiming(3000, 1500)), async () => { throw new Error("no photon"); });
	assert.match((broken.content.at(-1) as { text: string }).text, /could not be scaled down: no photon/);
});

test("win.snapshot and win.screenshot check their images before a script can emit them", async () => {
	const answers: Record<string, ToolResult> = { Snapshot: result(Buffer.from("<html>")), Screenshot: result(realPng(), "image/jpeg") };
	const guest = (vm: string) => ({ vm, tool: async (name: string) => answers[name]!, forget() {}, recheck() {} }) as unknown as Guest;
	const session = new WinSession({ call: async () => ({}) }, guest);
	const snapshot = await session.call("snapshot", { vm: "A" }, {});
	assert.ok(!snapshot.content.some((block) => block.type === "image"));
	const value = WIN_API.value("snapshot", {}, snapshot, () => ({ type: "screenshot", id: "1" })) as { text: string; screenshot: unknown };
	assert.equal(value.screenshot, null);
	assert.match(value.text, /dropped the screenshot/);
	const screenshot = await session.call("screenshot", { vm: "A" }, {});
	assert.equal(screenshot.content.find((block) => block.type === "image")?.mimeType, "image/png");
});
