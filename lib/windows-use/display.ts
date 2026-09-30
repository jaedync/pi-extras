/** Session-aware images. A remote capture never falls back to the unrelated console. */
import type { ToolResult } from "../computer-use/session.ts";
import type { Guest, HostCalls } from "./guest.ts";
import { isDark, readFrame, toPng, type Frame } from "./frame.ts";
import { ocrItems, ocrText, readOcr, seamOf, type Region } from "./ocr.ts";
import { OCR_TIMEOUT_MS, Screen } from "./screen.ts";
import { textOf, textResult } from "./result.ts";

const MAX_PNG_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Bound compressed and decoded sizes before handing untrusted guest image bytes to WPF. */
export function screenshotPng(result: ToolResult): { data: Buffer; width: number; height: number } {
	const image = result.content.find((part) => part.type === "image");
	if (result.isError || image?.type !== "image" || image.mimeType !== "image/png") throw new Error(`Windows-MCP returned no PNG screenshot: ${textOf(result).slice(0, 300)}`);
	if (image.data.length > Math.ceil(MAX_PNG_BYTES / 3) * 4) throw new Error("Windows-MCP screenshot exceeds the 16 MiB PNG limit");
	const data = Buffer.from(image.data, "base64");
	if (data.length > MAX_PNG_BYTES) throw new Error("Windows-MCP screenshot exceeds the 16 MiB PNG limit");
	if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") throw new Error("Windows-MCP returned an invalid PNG screenshot");
	const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
	if (width < 2 || height < 2 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error("Windows-MCP screenshot dimensions exceed the supported bounds");
	return { data, width, height };
}

export interface ScreenshotGeometry extends Region { readonly scaleX: number; readonly scaleY: number }

/** Windows-MCP caps images at 1920x1080; its text retains the actual desktop geometry. */
export function screenshotGeometry(result: ToolResult, image: { width: number; height: number }): ScreenshotGeometry {
	const raw = textOf(result);
	const listed: unknown = raw.trimStart().startsWith("[") ? JSON.parse(raw) : raw;
	const text = (Array.isArray(listed) ? listed.filter((line) => typeof line === "string").join("\n") : raw).split(/\n\s*Active Desktop:/)[0]!;
	const size = /^\s*Screenshot (?:Original )?Size:\s*\((\d+),\s*(\d+)\)/m.exec(text);
	const boxes = [...(/^\s*Screenshot Region:\s*(.+)$/m.exec(text)?.[1] ?? /^\s*Visible Displays:\s*(.+)$/m.exec(text)?.[1] ?? "")
		.matchAll(/\((-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/g)].map((box) => box.slice(1).map(Number));
	if (!size || !boxes.length) throw new Error("Windows-MCP screenshot lacks desktop geometry; refusing to guess clickable coordinates. Use win.screenshot to inspect its metadata.");
	const width = Number(size[1]), height = Number(size[2]);
	const x = Math.min(...boxes.map((box) => box[0]!)), y = Math.min(...boxes.map((box) => box[1]!));
	const right = Math.max(...boxes.map((box) => box[2]!)), bottom = Math.max(...boxes.map((box) => box[3]!));
	if (width < image.width || height < image.height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS
		|| boxes.some((box) => box.some((v) => !Number.isSafeInteger(v) || Math.abs(v) > 0x7fffffff) || box[2]! <= box[0]! || box[3]! <= box[1]!)
		|| right - x !== width || bottom - y !== height) throw new Error("Windows-MCP screenshot geometry is inconsistent; refusing to guess clickable coordinates");
	return { x, y, width, height, scaleX: width / image.width, scaleY: height / image.height };
}

interface DisplayOptions {
	readonly host: HostCalls;
	readonly guest: Guest;
	readonly capture: () => Promise<ToolResult>;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly note: (text: string) => void;
}

export class Display {
	private readonly options: DisplayOptions;
	constructor(options: DisplayOptions) { this.options = options; }

	async read(method: "console.screenshot" | "console.ocr", area?: Region, signal?: AbortSignal): Promise<ToolResult> {
		const { guest, host, capture } = this.options;
		const state = await guest.inspect(signal);
		if (guest.where() === "remote") {
			const result = await capture();
			const png = screenshotPng(result);
			const geometry = screenshotGeometry(result, png);
			if (method === "console.screenshot") return this.image(png, { source: "guest", session: state?.id,
				x: geometry.x, y: geometry.y, screenWidth: geometry.width, screenHeight: geometry.height, scaleX: geometry.scaleX, scaleY: geometry.scaleY });
			const ocr = readOcr(await host.call("ocrImage", { vm: guest.vm, png: [...png.data] }, { signal, timeoutMs: OCR_TIMEOUT_MS }));
			if (ocr.width !== png.width || ocr.height !== png.height) throw new Error("Windows OCR dimensions do not match the captured screenshot");
			return this.text(ocr, area, geometry);
		}
		const mayWake = state?.where === "console" && state.active;
		if (method === "console.screenshot") {
			let frame = readFrame(await host.call("frame", { vm: guest.vm }, { signal }));
			if (mayWake && isDark(frame) && await this.wake(signal, frame)) frame = readFrame(await host.call("frame", { vm: guest.vm }, { signal }));
			return this.image({ ...frame, data: toPng(frame) });
		}
		const read = async () => readOcr(await host.call("ocr", { vm: guest.vm }, { signal, timeoutMs: OCR_TIMEOUT_MS }));
		let ocr = await read();
		if (mayWake && ocr.lines.length === 0 && await this.wake(signal)) ocr = await read();
		return this.text(ocr, area);
	}

	private image(png: { data: Buffer; width: number; height: number }, extra = {}): ToolResult {
		return { content: [{ type: "text", text: JSON.stringify({ width: png.width, height: png.height, ...extra }) }, { type: "image", data: png.data.toString("base64"), mimeType: "image/png" }], isError: false };
	}

	private text(ocr: ReturnType<typeof readOcr>, area?: Region, geometry?: ScreenshotGeometry): ToolResult {
		const points = ocrItems(ocr.lines, undefined, seamOf(ocr.width)).map((item) => geometry
			? { ...item, x: Math.round(geometry.x + item.x * geometry.scaleX), y: Math.round(geometry.y + item.y * geometry.scaleY) } : item);
		const items = points.filter((item) => !area || item.x >= area.x && item.x < area.x + area.width && item.y >= area.y && item.y < area.y + area.height);
		return textResult(JSON.stringify({ width: geometry?.width ?? ocr.width, height: geometry?.height ?? ocr.height, text: ocrText(items), items }));
	}

	private async wake(signal?: AbortSignal, seen?: Frame): Promise<boolean> {
		const { guest, host, sleep, note } = this.options;
		await guest.assertConsole(signal);
		const woke = await new Screen({ host, vm: guest.vm, sleep, settleMs: 1500 }).wake(signal, seen);
		if (woke) note(`${guest.vm}: woke the display, which had gone dark`);
		return woke;
	}
}
