import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { hasTaskbar, isDark, readFrame, toPng, type Frame } from "../lib/windows-use/frame.ts";

const rgb565 = (r: number, g: number, b: number) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

/** A synthetic console frame: `pixel(x, y)` gives [r, g, b]. */
function frame(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Frame {
	const data = Buffer.alloc(width * height * 2);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.writeUInt16LE(rgb565(...pixel(x, y)), (y * width + x) * 2);
	return { width, height, data };
}

// Deterministic "photo" texture: busy enough to never read as a flat band.
const noise = (x: number, y: number): [number, number, number] => {
	const v = ((x * 73 + y * 151) ^ (x * y)) % 200;
	return [v, (v * 3) % 256, (v * 7) % 256];
};

test("a desktop with a flat taskbar band above the bottom edge is recognized", () => {
	const light = frame(320, 240, (x, y) => (y >= 226 ? [239, 239, 239] : noise(x, y)));
	const dark = frame(320, 240, (x, y) => (y >= 226 ? [32, 32, 32] : noise(x, y)));
	assert.equal(hasTaskbar(light), true);
	assert.equal(hasTaskbar(dark), true);
});

/**
 * A Windows 11 taskbar 15 rows tall, like Hyper-V's 320-wide frames: flat
 * margins, then rows of icons, a search box, widget text and the tray, which
 * cover about half of each row. `items(x)` says where those sit.
 */
function taskbar(above: (x: number, y: number) => [number, number, number], items: (x: number) => boolean): Frame {
	const band: [number, number, number] = [232, 236, 232];
	return frame(320, 240, (x, y) => {
		if (y < 225) return above(x, y);
		const iconRow = y >= 228 && y <= 236;
		return iconRow && items(x) && (x + y) % 2 === 0 ? [40, 90, 200] : band;
	});
}

test("the taskbar is found whatever sits on it: the weather widget's text, or icons packed to the left", () => {
	// Centered icons with the widget's "94°F Mostly sunny" at the left end, where a narrow sample once looked.
	const widget = (x: number) => (x >= 8 && x <= 38) || (x >= 80 && x <= 240 && x % 14 < 10) || (x >= 260 && x <= 310);
	assert.equal(hasTaskbar(taskbar(noise, widget)), true);
	const leftAligned = (x: number) => x >= 4 && x <= 200 && x % 14 < 10;
	assert.equal(hasTaskbar(taskbar(noise, leftAligned)), true);
});

test("Start's taskbar over a full-screen page one shade off the taskbar color is still found", () => {
	// example.com's #f0f0f2 is one RGB565 step from the light taskbar: the band ends where the dominant color changes.
	const page = (): [number, number, number] => [240, 240, 242];
	const centered = (x: number) => x >= 80 && x <= 240 && x % 14 < 10;
	assert.equal(hasTaskbar(taskbar(page, centered)), true);
	assert.equal(hasTaskbar(frame(320, 240, page)), false, "the page alone");
});

test("lock, sign-in, black and solid screens are not taken for a desktop", () => {
	assert.equal(hasTaskbar(frame(320, 240, noise)), false, "photo lock screen");
	assert.equal(hasTaskbar(frame(320, 240, () => [0, 0, 0])), false, "black screen");
	assert.equal(hasTaskbar(frame(320, 240, () => [0, 90, 160])), false, "solid color: a band with no edge above it");
	assert.equal(hasTaskbar(frame(320, 240, (x, y) => (y >= 120 ? [30, 30, 30] : noise(x, y)))), false, "dimmed half, like UAC: far too tall");
	assert.equal(hasTaskbar(frame(320, 240, (x, y) => (y >= 237 ? [239, 239, 239] : noise(x, y)))), false, "a sliver too thin to be a taskbar");
});

test("frames encode to a valid PNG with the right size and colors", () => {
	const f = frame(4, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [0, 0, 255]));
	const png = toPng(f);
	assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.equal(png.readUInt32BE(16), 4);
	assert.equal(png.readUInt32BE(20), 2);
	const idat = png.indexOf("IDAT");
	const length = png.readUInt32BE(idat - 4);
	const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
	assert.equal(raw.length, 2 * (1 + 4 * 3));
	assert.deepEqual([...raw.subarray(0, 7)], [0, 255, 0, 0, 0, 0, 255]);
	assert.equal(png.subarray(-8, -4).toString(), "IEND");
});

test("a frame whose data doesn't match its size is refused", () => {
	assert.throws(() => toPng({ width: 10, height: 10, data: Buffer.alloc(10) }), /frame data/);
});

test("the host's frames are read with Hyper-V's trailing padding trimmed", () => {
	const pixels = Buffer.alloc(2 * 2 * 2, 0xab);
	const frame = readFrame({ width: 2, height: 2, data: Buffer.concat([pixels, Buffer.alloc(4)]).toString("base64") });
	assert.deepEqual(frame.data, pixels);
	assert.throws(() => readFrame({ width: 2, height: 2, data: Buffer.alloc(6).toString("base64") }), /expected 8/);
	assert.throws(() => readFrame({ width: 2 }), /malformed/);
});

test("a busy screen (boot, restart, updates: black with a little text) reads as dark; lock screens and desktops don't", () => {
	const text = (x: number, y: number) => y > 110 && y < 130 && x > 100 && x < 220 && (x + y) % 3 === 0;
	assert.equal(isDark(frame(320, 240, (x, y) => text(x, y) ? [255, 255, 255] : [0, 0, 0])), true);
	assert.equal(isDark(frame(320, 240, () => [8, 10, 12])), true, "a sleeping display is black too");
	assert.equal(isDark(frame(320, 240, noise)), false, "a lock-screen photo");
	// A night photo: mostly dark, yet well short of a busy screen's near-total black.
	assert.equal(isDark(frame(320, 240, (x, y) => y < 170 ? [10, 12, 20] : noise(x, y))), false);
});
