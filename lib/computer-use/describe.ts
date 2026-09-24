/** One-line summaries of Computer Use calls for the tool row. Pure, so the renderer and the executor agree. */

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_TEXT = 48;

export interface CallTarget {
	readonly app?: string;
	readonly detail: string;
}

export function clean(value: unknown, max = MAX_TEXT): string {
	if (typeof value !== "string" && typeof value !== "number") return "";
	const text = String(value).replace(/\r?\n/g, "↵").replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const quote = (value: unknown) => `"${clean(value)}"`;
const point = (x: unknown, y: unknown) => typeof x === "number" && typeof y === "number" ? `(${x}, ${y})` : "";
const element = (args: Record<string, unknown>) => {
	const index = clean(args.element_index, 12);
	return index ? `#${index}` : point(args.x, args.y);
};

function detail(method: string, args: Record<string, unknown>): string[] {
	switch (method) {
		case "get_app_state": return [args.disableDiff === true ? "full tree" : ""];
		case "click": return [
			element(args),
			typeof args.mouse_button === "string" && args.mouse_button !== "left" ? clean(args.mouse_button, 8) : "",
			typeof args.click_count === "number" && args.click_count > 1 ? `×${args.click_count}` : "",
		];
		case "perform_secondary_action": return [element(args), clean(args.action, 32)];
		case "set_value": return [element(args), args.value === undefined ? "" : `= ${quote(args.value)}`];
		case "select_text": return [element(args), args.text === undefined ? "" : quote(args.text)];
		case "scroll": {
			const pages = typeof args.pages === "number" ? `${args.pages} page${args.pages === 1 ? "" : "s"}` : "";
			return [element(args), clean(args.direction, 8), pages];
		}
		case "drag": return [`${point(args.from_x, args.from_y)} → ${point(args.to_x, args.to_y)}`];
		case "press_key": return [clean(args.key, 32)];
		case "type_text": return [quote(args.text)];
		default: return [];
	}
}

export function describeCall(method: string, args: Record<string, unknown>): CallTarget {
	const app = typeof args.app === "string" ? clean(args.app, 40) || undefined : undefined;
	return { app, detail: detail(method, args).filter(Boolean).join(" ") };
}

export function formatMs(ms: number): string {
	const value = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (Math.round(value) < 1000) return `${Math.round(value)}ms`;
	if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
	const seconds = Math.floor(value / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
