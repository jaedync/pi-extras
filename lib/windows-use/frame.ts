/**
 * Console frames from Hyper-V: raw RGB565 pixels, as GetVirtualSystemThumbnailImage
 * returns them. Pixel work happens here rather than in host.ps1 because
 * antivirus holds up PowerShell scripts that copy image memory by pointer for
 * many seconds before they start.
 */
import { crc32, deflateSync } from "node:zlib";

export interface Frame {
	readonly width: number;
	readonly height: number;
	/** Little-endian RGB565, row after row, no padding. */
	readonly data: Buffer;
}

/** The host's `frame` answer: { width, height, data: base64 RGB565 }. */
export function readFrame(value: unknown): Frame {
	const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
	if (typeof raw.width !== "number" || typeof raw.height !== "number" || typeof raw.data !== "string") throw new Error("the host sent a malformed frame");
	const data = Buffer.from(raw.data, "base64");
	// Hyper-V appends 4 zero bytes after the pixels.
	const size = raw.width * raw.height * 2;
	if (data.length < size) throw new Error(`frame data is ${data.length} bytes, expected ${size}`);
	return { width: raw.width, height: raw.height, data: data.subarray(0, size) };
}

function check(frame: Frame): void {
	if (frame.data.length !== frame.width * frame.height * 2) throw new Error(`frame data is ${frame.data.length} bytes, expected ${frame.width * frame.height * 2}`);
}

const expand5 = (v: number) => (v * 527 + 23) >> 6;
const expand6 = (v: number) => (v * 259 + 33) >> 6;

function rgb(frame: Frame, x: number, y: number): [number, number, number] {
	const p = frame.data.readUInt16LE((y * frame.width + x) * 2);
	return [expand5((p >> 11) & 31), expand6((p >> 5) & 63), expand5(p & 31)];
}

function chunk(type: string, body: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
	return Buffer.concat([head, body, crc]);
}

export function toPng(frame: Frame): Buffer {
	check(frame);
	const { width, height } = frame;
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		const row = y * (1 + width * 3);
		for (let x = 0; x < width; x++) {
			const [r, g, b] = rgb(frame, x, y);
			const at = row + 1 + x * 3;
			raw[at] = r; raw[at + 1] = g; raw[at + 2] = b;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;   // bit depth
	header[9] = 2;   // truecolor RGB
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** One RGB565 step per channel: Hyper-V's scaler shifts flat areas by about that much. */
const STEP: readonly [number, number, number] = [8, 4, 8];
/** Share of a row near the band color that makes it one of the band's flat margin rows. */
const MARGIN = 0.85;
/** Share that icon, search box and widget rows still keep. Measured at 0.46 and up. */
const ICON_ROW = 0.25;
/** The taskbar is 48 px at 100% scale on 768 px: roughly 3.5-9% of the height across scales. */
const MIN_BAND = 0.035;
const MAX_BAND = 0.09;

interface Row {
	/** The row's most common exact color, as a packed RGB565 value. */
	readonly dominant: number;
	/** Share of the row within one step of the band color. */
	readonly near: number;
}

function row(frame: Frame, y: number, band: number): Row {
	const counts = new Map<number, number>();
	const [br, bg, bb] = unpack(band);
	let near = 0;
	for (let x = 0; x < frame.width; x++) {
		const p = frame.data.readUInt16LE((y * frame.width + x) * 2);
		counts.set(p, (counts.get(p) ?? 0) + 1);
		const [r, g, b] = unpack(p);
		if (Math.abs(r - br) <= STEP[0] && Math.abs(g - bg) <= STEP[1] && Math.abs(b - bb) <= STEP[2]) near++;
	}
	let dominant = band;
	let most = -1;
	for (const [color, count] of counts) if (count > most) { dominant = color; most = count; }
	return { dominant, near: near / frame.width };
}

const unpack = (p: number): [number, number, number] => [expand5((p >> 11) & 31), expand6((p >> 5) & 63), expand5(p & 31)];

/**
 * Whether the Windows taskbar is on screen: a band along the bottom edge, of
 * taskbar height, whose rows are all dominated by one exact color (icon rows
 * keep at least a quarter of it), with flat margin rows at its bottom and top
 * and a row of another color above it. Whole rows are measured, so neither
 * the weather widget's text nor a left-aligned taskbar gets in the way, and a
 * full-screen app one shade off the taskbar color still ends the band. Lock,
 * sign-in, UAC and black screens have no such band. A full-screen app or a
 * hidden taskbar has none either, so callers take "no taskbar" as "maybe
 * locked", never as proof.
 */
export function hasTaskbar(frame: Frame): boolean {
	check(frame);
	const { height } = frame;
	const color = row(frame, height - 1, frame.data.readUInt16LE((height - 1) * frame.width * 2)).dominant;
	const rows: Row[] = [];
	for (let y = height - 1; y > Math.floor(height * 0.8); y--) rows.push(row(frame, y, color));
	if (rows[0]!.near < MARGIN) return false;
	let band = 0;
	while (band < rows.length && rows[band]!.dominant === color && rows[band]!.near >= ICON_ROW) band++;
	if (band === rows.length) return false;
	const top = Math.max(...rows.slice(Math.max(0, band - 3), band).map((r) => r.near));
	const share = band / height;
	return top >= MARGIN && share >= MIN_BAND && share <= MAX_BAND;
}

/** A pixel this close to black (every channel below it) counts as dark. */
const DARK_LEVEL = 32;
/** Busy screens measured 99% dark; lock screens at most 37%, desktops about 0%. */
const DARK_SHARE = 0.9;

/**
 * Whether the screen is nearly all black: Windows starting, restarting or
 * installing updates (white text and a spinner on black), or a display that
 * is asleep. Lock and sign-in screens show a picture, so they never are.
 */
export function isDark(frame: Frame): boolean {
	check(frame);
	let dark = 0;
	for (let i = 0; i < frame.data.length; i += 2) {
		const p = frame.data.readUInt16LE(i);
		if (expand5((p >> 11) & 31) < DARK_LEVEL && expand6((p >> 5) & 63) < DARK_LEVEL && expand5(p & 31) < DARK_LEVEL) dark++;
	}
	return dark / (frame.width * frame.height) >= DARK_SHARE;
}
