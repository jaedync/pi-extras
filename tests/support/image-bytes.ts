/** Small, valid images built in memory, for tests that check image bytes. */
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}

/** A black 8-bit grey PNG of the given size. */
export function png(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 0, 0, 0, 0], 8);
	const rows = Buffer.alloc((width + 1) * height);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A 1x1 PNG whose header claims another size (the CRC no longer matches; only the header is read). */
export function pngClaiming(width: number, height: number): Buffer {
	const copy = png(1, 1);
	copy.writeUInt32BE(width, 16);
	copy.writeUInt32BE(height, 20);
	return copy;
}

/** The smallest headers of the other types, enough for the sniffer. */
export const jpegHeader = (width: number, height: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
export const gifHeader = (width: number, height: number) => Buffer.concat([Buffer.from("GIF89a"), Buffer.from([width & 0xff, width >> 8, height & 0xff, height >> 8])]);
export function webpHeader(width: number, height: number): Buffer {
	const b = Buffer.alloc(30);
	b.write("RIFF", 0);
	b.write("WEBPVP8X", 8);
	b.writeUIntLE(width - 1, 24, 3);
	b.writeUIntLE(height - 1, 27, 3);
	return b;
}
