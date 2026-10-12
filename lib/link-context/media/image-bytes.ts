/**
 * The type and pixel size of an image, read from its own bytes. A server's
 * content-type can be wrong (an HTML error page labelled image/jpeg, a WebP
 * labelled JPEG), and a provider refuses the whole request for one image
 * whose bytes do not match its label.
 */

export type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageHeader {
	readonly mimeType: ImageType;
	readonly width: number;
	readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const u32le = (b: Uint8Array, at: number) => (u24le(b, at) | (b[at + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array, at: number, text: string) => b.length >= at + text.length && [...text].every((char, i) => b[at + i] === char.charCodeAt(0));

/** Start-of-frame markers carry the size; C4 (Huffman), C8 (reserved) and CC (arithmetic) do not. */
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(b: Uint8Array): [number, number] | undefined {
	let at = 2;
	while (at + 4 <= b.length) {
		if (b[at] !== 0xff) return undefined;
		const marker = b[at + 1];
		if (marker === 0xff) {
			at++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			at += 2;
			continue;
		}
		if (isFrame(marker)) return at + 9 <= b.length ? [u16be(b, at + 7), u16be(b, at + 5)] : undefined;
		at += 2 + u16be(b, at + 2);
	}
	return undefined;
}

/** APNG (an acTL chunk before the first IDAT) is left out, as Pi's own read tool does. */
function pngSize(b: Uint8Array): [number, number] | undefined {
	if (b.length < 24 || u32be(b, 8) !== 13 || !ascii(b, 12, "IHDR")) return undefined;
	for (let at = 8; at + 8 <= b.length; at += 12 + u32be(b, at)) {
		if (ascii(b, at + 4, "acTL")) return undefined;
		if (ascii(b, at + 4, "IDAT")) break;
	}
	return [u32be(b, 16), u32be(b, 20)];
}

function webpSize(b: Uint8Array): [number, number] | undefined {
	if (ascii(b, 12, "VP8 ") && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
	if (ascii(b, 12, "VP8L") && b.length >= 25 && b[20] === 0x2f) {
		const bits = u32le(b, 21);
		return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
	}
	if (ascii(b, 12, "VP8X") && b.length >= 30) return [u24le(b, 24) + 1, u24le(b, 27) + 1];
	return undefined;
}

function detect(b: Uint8Array): [ImageType, [number, number] | undefined] | undefined {
	// FF D8 FF F7 is JPEG-LS, which no model provider reads.
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] !== 0xf7) return ["image/jpeg", jpegSize(b)];
	if (PNG_SIGNATURE.every((byte, i) => b[i] === byte)) return ["image/png", pngSize(b)];
	if ((ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) && b.length >= 10) return ["image/gif", [u16le(b, 6), u16le(b, 8)]];
	if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return ["image/webp", webpSize(b)];
	return undefined;
}

/** JPEG, PNG, GIF or WebP with a readable, non-zero size; anything else is undefined. */
export function sniffImage(bytes: Uint8Array): ImageHeader | undefined {
	const found = detect(bytes);
	const size = found?.[1];
	if (!found || !size || size[0] < 1 || size[1] < 1) return undefined;
	return { mimeType: found[0], width: size[0], height: size[1] };
}
