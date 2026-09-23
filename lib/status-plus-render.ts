/**
 * Small rendering pieces for the status-plus footer. Every function takes a
 * painter (Pi's theme in production, a tagging stub in tests) and, where time
 * matters, an explicit clock value, so output is deterministic.
 */
import { STATUS_TIME_ZONE, formatDuration, type LimitEntry } from "./status-plus-logic.ts";
import { dateFormat } from "./date-format.ts";

export interface Painter {
	fg(tone: string, text: string): string;
}

export interface ProviderStats {
	cost: number;
	airtimeMs: number;
	/** Everything sent to this provider (fresh input plus cache writes and reads) and everything it produced. */
	inputTokens: number;
	outputTokens: number;
}

export const EMPTY_PROVIDER: ProviderStats = { cost: 0, airtimeMs: 0, inputTokens: 0, outputTokens: 0 };

export type { LimitSnapshot } from "./limit-store.ts";

export interface CacheTtl {
	ttlMs: number;
	warnMs: number;
}

export interface CacheState {
	kind: "none" | "new-ctx" | "warm" | "cooling" | "cold";
	tone: "dim" | "warning" | "error";
	label: string;
}

type Rgb = readonly [number, number, number];

/**
 * Shared OKLCH footprint for every truecolor the footer paints itself. Hue
 * carries identity; lightness and chroma stay muted so these fixed colours sit
 * at the same visual weight as a quiet theme instead of glowing over it.
 */
const FIXED_L_BRIGHT = 0.72;
const PROVIDER_CHROMA = 0.09;

function mutedRgb(hue: number, chroma = PROVIDER_CHROMA, lightness = FIXED_L_BRIGHT): Rgb {
	const { r, g, b } = oklchToRgb(lightness, chroma, hue);
	return [r, g, b];
}

/** Truecolor keeps provider identities distinct regardless of the active theme; only the hue differs per provider. */
export const PROVIDERS: Record<string, { label: string; color: Rgb }> = {
	anthropic: { label: "Ant", color: mutedRgb(50) }, // orange
	"openai-codex": { label: "Cdx", color: mutedRgb(260) }, // blue
	openrouter: { label: "Ort", color: mutedRgb(305) }, // purple
	"opencode-go": { label: "Go", color: mutedRgb(195) }, // teal
	opencode: { label: "Zen", color: mutedRgb(150) }, // green
};

const PROVIDER_ORDER = Object.keys(PROVIDERS);
const WARN_PCT = 70;
const CRITICAL_PCT = 90;
const BAR_CELLS = 20;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const DAY_MS = 86_400_000;

/** Keep spend and limit rows in the same stable provider order. */
export function compareProviderIds(left: string, right: string): number {
	const leftRank = PROVIDER_ORDER.indexOf(left);
	const rightRank = PROVIDER_ORDER.indexOf(right);
	if (leftRank >= 0 && rightRank >= 0) return leftRank - rightRank;
	if (leftRank >= 0) return -1;
	if (rightRank >= 0) return 1;
	return left.localeCompare(right);
}

export function rgb(text: string, color: Rgb): string {
	return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}\x1b[39m`;
}

const SGR_TRUECOLOR = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const SGR_INDEXED = /\x1b\[38;5;(\d+)m/;

/** xterm 256-colour index to RGB: the 16 ANSI colours, the 6x6x6 cube, then the grey ramp. */
function indexedRgb(index: number): Rgb | undefined {
	if (index < 16) return undefined; // terminal-defined; not knowable here
	if (index >= 232) {
		const grey = 8 + (index - 232) * 10;
		return [grey, grey, grey];
	}
	const cube = index - 16;
	const step = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
	return [step(Math.floor(cube / 36)), step(Math.floor(cube / 6) % 6), step(cube % 6)];
}

/**
 * Recover the RGB a painter uses for a tone by painting a probe and reading
 * the escape back. Themes never expose raw colours, so this is the only way to
 * blend between two tokens. Undefined for stub painters or default-colour tones.
 */
export function toneRgb(paint: Painter, tone: string): Rgb | undefined {
	const probe = paint.fg(tone, "x");
	const truecolor = SGR_TRUECOLOR.exec(probe);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const indexed = SGR_INDEXED.exec(probe);
	return indexed ? indexedRgb(Number(indexed[1])) : undefined;
}

const toLinear = (c: number): number => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (l: number): number => {
	const s = l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
	return Math.round(Math.min(1, Math.max(0, s)) * 255);
};

/** Mix two colours in linear light so the midpoint is not muddy. `t` is the share of `to`. */
export function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
	const k = Math.min(1, Math.max(0, t));
	return [0, 1, 2].map((i) => fromLinear(toLinear(from[i]) * (1 - k) + toLinear(to[i]) * k)) as unknown as Rgb;
}

/**
 * Paint `text` somewhere between two tones: `t` of 1 is fully `hot`, 0 is
 * fully `rest`. Painters that do not expose colours fall back to a step at
 * the halfway point, so tests and odd terminals still get a sane result.
 */
export function fadeFg(paint: Painter, hot: string, rest: string, t: number, text: string): string {
	if (t <= 0) return paint.fg(rest, text);
	if (t >= 1) return paint.fg(hot, text);
	const a = toneRgb(paint, hot);
	const b = toneRgb(paint, rest);
	if (!a || !b) return paint.fg(t >= 0.5 ? hot : rest, text);
	return rgb(text, mixRgb(b, a, t));
}

/** The provider's identity colour, for anything that should read as "belongs to this provider". */
export function providerColor(id: string | undefined): Rgb | undefined {
	return id ? PROVIDERS[id]?.color : undefined;
}

/** Pi's own thinking-level theme token for a level string, so the effort reads in the theme's ramp. */
export function thinkingTone(level: string | undefined): string {
	const known = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const key = (level ?? "").toLowerCase();
	if (!known.includes(key)) return "dim";
	return `thinking${key[0].toUpperCase()}${key.slice(1)}`;
}

export function providerTag(paint: Painter, id: string): string {
	const known = PROVIDERS[id];
	return known ? rgb(known.label, known.color) : paint.fg("dim", id);
}

export function toneForPct(pct: number): "dim" | "warning" | "error" {
	if (pct >= CRITICAL_PCT) return "error";
	if (pct >= WARN_PCT) return "warning";
	return "dim";
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Cache warmth from the last completed call. After compaction (or a branch
 * summary) the old prefix cache is unreachable, so nothing is warm until the
 * next request writes a new cache.
 */
export function cacheState(
	lastApiEndMs: number | undefined,
	lastContextResetMs: number | undefined,
	now: number,
	cache: CacheTtl,
): CacheState {
	if (lastContextResetMs && (!lastApiEndMs || lastContextResetMs > lastApiEndMs)) {
		return { kind: "new-ctx", tone: "dim", label: "new ctx" };
	}
	if (!lastApiEndMs) return { kind: "none", tone: "dim", label: "no calls yet" };
	const age = formatDuration(now - lastApiEndMs, false);
	if (now - lastApiEndMs >= cache.ttlMs) return { kind: "cold", tone: "error", label: `${age} cold` };
	if (now - lastApiEndMs >= cache.warnMs) return { kind: "cooling", tone: "warning", label: `${age} cooling` };
	return { kind: "warm", tone: "dim", label: `${age} warm` };
}

/**
 * Model ids from aggregators run long ("google/gemini-3.8-flash"). The cell
 * keeps the thinking level whole, drops the vendor prefix first, and only then
 * cuts the middle of the id, so the distinguishing tail survives.
 */
export function modelParts(name: string, level: string | undefined, max: number): { id: string; level: string } {
	const suffix = level ? ` ${level}` : "";
	const budget = Math.max(3, max - suffix.length);
	let id = name;
	if (id.length > budget && id.includes("/")) id = id.slice(id.indexOf("/") + 1);
	if (id.length > budget) {
		const head = Math.ceil((budget - 1) / 2);
		const tail = budget - 1 - head;
		id = `${id.slice(0, head)}…${id.slice(id.length - tail)}`;
	}
	return { id, level: level ?? "" };
}

export function modelLabel(name: string, level: string | undefined, max: number): string {
	const parts = modelParts(name, level, max);
	return parts.level ? `${parts.id} ${parts.level}` : parts.id;
}

/** Bar colours as a named triple; `Rgb` above is the provider-tag tuple. */
export interface BarRgb {
	r: number;
	g: number;
	b: number;
}

/** OKLCH (L, C, hue in degrees) to 8-bit sRGB, clipped. Same math as the statusline's awk. */
function oklchToRgb(L: number, C: number, hueDeg: number): BarRgb {
	const h = (hueDeg * Math.PI) / 180;
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l3 = l_ ** 3;
	const m3 = m_ ** 3;
	const s3 = s_ ** 3;
	const linear = [
		4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
		-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
		-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
	].map((v) => {
		const c = Math.max(0, v);
		const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
		return Math.round(Math.min(1, Math.max(0, s)) * 255);
	});
	return { r: linear[0], g: linear[1], b: linear[2] };
}

// The bar is a gauge, not a label: it needs more chroma than the provider
// tags so the fill reads at a glance, and a lighter empty track so the
// unfilled span is visible rather than a black gap.
const BAR_L_BRIGHT = 0.76;
const BAR_L_DIM = 0.4;
const BAR_CHROMA = 0.15;
/** Empty cells stay in gamut at lower chroma; the hue still reads. */
const BAR_DIM_CHROMA = 0.1;
const BAR_HUE_START = 142; // green
const BAR_HUE_END = 29; // red

/**
 * Per-cell colours for the context bar: a perceptual green-to-red sweep in
 * OKLCH, with a bright variant for filled cells and a dim one (same hue,
 * lower lightness) for empty cells, so the bar reads good-to-bad before
 * any figure does. Same hue sweep as the Claude Code statusline bar, toned
 * down from it but kept livelier than the provider tags.
 */
export function barGradient(n: number): { bright: BarRgb; dim: BarRgb }[] {
	const out: { bright: BarRgb; dim: BarRgb }[] = [];
	for (let i = 0; i < n; i++) {
		const t = n > 1 ? i / (n - 1) : 0;
		const hue = BAR_HUE_START + t * (BAR_HUE_END - BAR_HUE_START);
		out.push({ bright: oklchToRgb(BAR_L_BRIGHT, BAR_CHROMA, hue), dim: oklchToRgb(BAR_L_DIM, BAR_DIM_CHROMA, hue) });
	}
	return out;
}

const BAR_COLORS = barGradient(BAR_CELLS);
const truecolor = ({ r, g, b }: BarRgb): string => `\x1b[38;2;${r};${g};${b}m`;
/** Foreground back to the theme's default; never a full reset, which would drop the line's other attributes. */
const FG_RESET = "\x1b[39m";

/**
 * Twenty-cell context bar with eighth-block precision, coloured by the
 * gradient above (the statusline's bar). The painter is unused now that
 * every cell carries its own truecolor; kept so callers and tests share one
 * signature with the rest of the render helpers.
 */
export function contextBar(_paint: Painter, percent: number): string {
	const cells = Math.max(0, Math.min(BAR_CELLS, (percent / 100) * BAR_CELLS));
	let full = Math.floor(cells);
	let partial = Math.round((cells - full) * 8);
	if (partial === 8) {
		full += 1;
		partial = 0;
	}
	let bar = "";
	for (let i = 0; i < BAR_CELLS; i++) {
		const colors = BAR_COLORS[i];
		if (i < full) bar += truecolor(colors.bright) + "█";
		else if (i === full && partial > 0) bar += truecolor(colors.bright) + EIGHTHS[partial];
		else bar += truecolor(colors.dim) + "░";
	}
	return bar + FG_RESET;
}

/** One limit entry as text: "5h 47%", "$87/$100 left", toned by pressure. */
export function limitText(paint: Painter, entry: LimitEntry, now: number, inlineCountdown = false): string {
	let text = entry.label ? `${entry.label} ` : "";
	if (entry.usedPct !== undefined) {
		text += `${Math.round(entry.usedPct)}%`;
		if (entry.remainingText) text += ` (${entry.remainingText})`;
		else if (inlineCountdown && entry.usedPct >= WARN_PCT && entry.resetMs && entry.resetMs > now) {
			text += ` ${formatDuration(entry.resetMs - now, false)}`;
		}
		return paint.fg(toneForPct(entry.usedPct), text);
	}
	if (!entry.remainingText) return "";
	text += entry.remainingText;
	if (!text.endsWith("left")) text += " left";
	return paint.fg("dim", text);
}

interface DateParts { day: string; weekday: string; month: string; hour: string; minute: string; period: string }

// Parts have minute resolution, and every frame asks for the same few minutes.
const MINUTE_MS = 60_000;
const MAX_CACHED_PARTS = 256;
const partsCache = new Map<string, DateParts>();

function dateParts(ms: number, timeZone: string): DateParts {
	const key = `${timeZone}\u0000${Math.floor(ms / MINUTE_MS)}`;
	let parts = partsCache.get(key);
	if (!parts) {
		if (partsCache.size >= MAX_CACHED_PARTS) partsCache.clear();
		parts = formatParts(ms, timeZone);
		partsCache.set(key, parts);
	}
	return parts;
}

function formatParts(ms: number, timeZone: string): DateParts {
	const parts = dateFormat("parts", timeZone, {
		weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
	}).formatToParts(new Date(ms));
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return { day: get("day"), weekday: get("weekday"), month: get("month"), hour: get("hour"), minute: get("minute"), period: get("dayPeriod").toLowerCase() };
}

/** Reset moments stay compact nearby; distant resets include their exact date and time. */
export function resetLabel(resetMs: number, now: number, approx = false, timeZone = STATUS_TIME_ZONE): string {
	const target = dateParts(resetMs, timeZone);
	const today = dateParts(now, timeZone);
	const clock = target.minute === "00" ? `${target.hour}${target.period}` : `${target.hour}:${target.minute}${target.period}`;
	const exactClock = `${target.hour}:${target.minute}${target.period}`;
	const prefix = approx ? "~" : "";
	if (target.day === today.day && target.month === today.month && resetMs - now < DAY_MS) return prefix + clock;
	if (resetMs - now < 7 * DAY_MS) return `${prefix}${target.weekday} ${clock}`;
	return `${prefix}${target.month}/${target.day} ${exactClock}`;
}
