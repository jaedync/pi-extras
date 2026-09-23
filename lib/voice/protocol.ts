/**
 * Wire format between a Pi session and the voice daemon: one JSON object per
 * line over a private Unix socket. Audio travels as base64 16 kHz mono s16le.
 */

export const MAX_LINE_BYTES = 1024 * 1024;

export type ClientMessage =
	| { t: "hello" }
	| { t: "start"; id: number }
	| { t: "audio"; id: number; pcm: string }
	| { t: "stop"; id: number }
	| { t: "cancel"; id: number }
	| { t: "unload" };

export type ChunkState = "queued" | "decoding" | "done";

export type DaemonEvent =
	| { t: "status"; state: "loading" | "ready"; backend?: string; model?: string }
	| { t: "vad"; id: number; speaking: boolean }
	/** `ms` is the chunk's audio length (on queued); `text` its transcript (on done). */
	| { t: "chunk"; id: number; index: number; state: ChunkState; ms?: number; text?: string }
	| { t: "final"; id: number; text: string }
	| { t: "error"; message: string; id?: number };

export function encodeMessage(message: ClientMessage | Record<string, unknown>): string {
	return `${JSON.stringify(message)}\n`;
}

export function pcmToBase64(frame: Int16Array): string {
	const bytes = Buffer.alloc(frame.length * 2);
	for (let i = 0; i < frame.length; i++) bytes.writeInt16LE(frame[i], i * 2);
	return bytes.toString("base64");
}

/** Splits a byte stream into parsed JSON lines; malformed or oversized lines are dropped. */
export class LineDecoder {
	private pending: Buffer = Buffer.alloc(0);
	private discarding = false;

	push(chunk: Buffer): unknown[] {
		const out: unknown[] = [];
		let buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
			const line = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (this.discarding) {
				this.discarding = false;
				continue;
			}
			try {
				out.push(JSON.parse(line.toString("utf8")));
			} catch {
				// A corrupt line must not take down the session; the next line is independent.
			}
		}
		if (buffer.length > MAX_LINE_BYTES) {
			this.discarding = true;
			buffer = Buffer.alloc(0);
		}
		this.pending = Buffer.from(buffer);
		return out;
	}
}

const CHUNK_STATES = new Set(["queued", "decoding", "done"]);
const isInt = (value: unknown): value is number => Number.isInteger(value);

export function parseDaemonEvent(value: unknown): DaemonEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	const optionalString = (key: string) => (typeof v[key] === "string" ? { [key]: v[key] as string } : {});
	switch (v.t) {
		case "status":
			if (v.state !== "loading" && v.state !== "ready") return undefined;
			return { t: "status", state: v.state, ...optionalString("backend"), ...optionalString("model") };
		case "vad":
			return isInt(v.id) && typeof v.speaking === "boolean" ? { t: "vad", id: v.id, speaking: v.speaking } : undefined;
		case "chunk":
			if (!isInt(v.id) || !isInt(v.index) || !CHUNK_STATES.has(v.state as string)) return undefined;
			return {
				t: "chunk",
				id: v.id,
				index: v.index,
				state: v.state as ChunkState,
				...(typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? { ms: v.ms } : {}),
				...optionalString("text"),
			};
		case "final":
			return isInt(v.id) && typeof v.text === "string" ? { t: "final", id: v.id, text: v.text } : undefined;
		case "error":
			if (typeof v.message !== "string") return undefined;
			return isInt(v.id) ? { t: "error", message: v.message, id: v.id } : { t: "error", message: v.message };
		default:
			return undefined;
	}
}
