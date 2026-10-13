/**
 * Checks the images Windows-MCP sends with win.snapshot and win.screenshot
 * before a script can emit them. The type comes from the bytes, not the label.
 * Then Pi's own resizeImage decodes every image, as Pi's read tool does, and
 * scales one over the read tool's limits (2000 px a side, 4.5 MB of base64).
 * A provider refuses the whole conversation for one bad image, so an image
 * that fails the check is dropped, with a note in its place.
 */
import type { ResizedImage } from "@earendil-works/pi-coding-agent";
import type { ContentBlock, ToolResult } from "../computer-use/session.ts";

type Image = Extract<ContentBlock, { type: "image" }>;
type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
interface Header { readonly mimeType: ImageType; readonly width: number; readonly height: number }
export type Resize = (bytes: Uint8Array, mimeType: string, options: { maxWidth: number; maxHeight: number; maxBytes: number }) => Promise<ResizedImage | null>;

/** resizeImage's defaults, which Pi's read tool uses. */
export const MAX_SIDE = 2000;
export const MAX_BASE64 = 4.5 * 1024 * 1024;
/** Decoding takes 4 bytes a pixel, and a small file can claim any size, so larger claims are never decoded. */
const MAX_DECODE_PIXELS = 50_000_000;

/** Loaded on first use: Pi's package is large to load, and many sessions never take a screenshot. */
const piResize: Resize = async (bytes, mimeType, options) => (await import("@earendil-works/pi-coding-agent")).resizeImage(bytes, mimeType, options);

export async function checkImages(result: ToolResult, resize: Resize = piResize): Promise<ToolResult> {
	if (!result.content.some((block) => block.type === "image")) return result;
	const content = await Promise.all(result.content.map((block) => block.type === "image" ? checkImage(block, resize) : [block]));
	return { ...result, content: content.flat() };
}

const dropped = (reason: string): ContentBlock => ({ type: "text", text: `[windows_use dropped the screenshot: ${reason}]` });

async function checkImage(image: Image, resize: Resize): Promise<ContentBlock[]> {
	const bytes = Buffer.from(image.data, "base64");
	const header = readHeader(bytes);
	if (!header) return [dropped("its bytes are not a JPEG, PNG, GIF or WebP image")];
	if (header.width * header.height > MAX_DECODE_PIXELS) return [dropped(`it claims ${header.width}x${header.height} pixels`)];
	// Decoded every time: a valid header can front a corrupt body, and Pi's own
	// check of tool results keeps an image it can't decode. resizeImage gives back
	// the bytes, encoded again, when the image already fits.
	const failed = `it could not be decoded or scaled down to ${MAX_SIDE} px a side and 4.5 MB of base64`;
	let resized: ResizedImage | null;
	try {
		resized = await resize(bytes, header.mimeType, { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, maxBytes: MAX_BASE64 });
	} catch (error) {
		return [dropped(`${failed}: ${error instanceof Error ? error.message : String(error)}`)];
	}
	if (!resized) return [dropped(failed)];
	const scaled: ContentBlock = { type: "image", data: resized.data, mimeType: resized.mimeType };
	if (!resized.wasResized) return [scaled];
	// Pi's own note for a scaled image, so click coordinates can be mapped back.
	const scale = (resized.originalWidth / resized.width).toFixed(2);
	return [scaled, { type: "text", text: `[Image: original ${resized.originalWidth}x${resized.originalHeight}, displayed at ${resized.width}x${resized.height}. Multiply coordinates by ${scale} to map to original image.]` }];
}

const ascii = (b: Buffer, at: number, text: string) => b.length >= at + text.length && b.toString("latin1", at, at + text.length) === text;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The type and pixel size an image's own header gives; undefined when it is no supported image. */
function readHeader(b: Buffer): Header | undefined {
	const size = b.subarray(0, 8).equals(PNG_SIGNATURE) ? ["image/png", pngSize(b)] as const
		: b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? ["image/jpeg", jpegSize(b)] as const
		: ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a") ? ["image/gif", b.length >= 10 ? [b.readUInt16LE(6), b.readUInt16LE(8)] as const : undefined] as const
		: ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") ? ["image/webp", webpSize(b)] as const
		: undefined;
	const [mimeType, dims] = size ?? [];
	return mimeType && dims && dims[0] > 0 && dims[1] > 0 ? { mimeType, width: dims[0], height: dims[1] } : undefined;
}

/** APNG (an acTL chunk before the first IDAT) is left out, as Pi's read tool leaves it out. */
function pngSize(b: Buffer): readonly [number, number] | undefined {
	if (b.length < 24 || b.readUInt32BE(8) !== 13 || !ascii(b, 12, "IHDR")) return undefined;
	for (let at = 8; at + 8 <= b.length; at += 12 + b.readUInt32BE(at)) {
		if (ascii(b, at + 4, "acTL")) return undefined;
		if (ascii(b, at + 4, "IDAT")) break;
	}
	return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** The size from the first start-of-frame marker; C4, C8 and CC are other markers in that range. */
function jpegSize(b: Buffer): readonly [number, number] | undefined {
	for (let at = 2; at + 4 <= b.length;) {
		if (b[at] !== 0xff) return undefined;
		const marker = b[at + 1]!;
		if (marker === 0xff) { at++; continue; }
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return at + 9 <= b.length ? [b.readUInt16BE(at + 7), b.readUInt16BE(at + 5)] : undefined;
		at += 2 + b.readUInt16BE(at + 2);
	}
	return undefined;
}

function webpSize(b: Buffer): readonly [number, number] | undefined {
	if (ascii(b, 12, "VP8 ") && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
	if (ascii(b, 12, "VP8L") && b.length >= 25 && b[20] === 0x2f) {
		const bits = b.readUInt32LE(21);
		return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
	}
	if (ascii(b, 12, "VP8X") && b.length >= 30) return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
	return undefined;
}
