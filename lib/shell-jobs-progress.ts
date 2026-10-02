/**
 * shell-jobs-progress: how far along a background job is, when that can be known.
 *
 * Two sources. A command that starts by sleeping (`sleep 30; echo done`) is
 * as far along as the time it has slept. Otherwise the newest output line may
 * be a meter a tool draws into a log: curl, wget (its dots), rsync
 * (`--info=progress2`), git (`--progress`), tqdm, ninja, and pip or cargo
 * when they draw one. Each is read for its share and the few facts worth
 * showing beside it: time left, size, speed. A bare percentage in other
 * output is believed only while it climbs, so a line like `coverage 85%`
 * never fakes a bar.
 */

import { formatWhole } from "./band/band.ts";

export interface Progress {
	/**
	 * 0 to 1, below 1. None when it can't be known (a download of unknown size)
	 * or a meter has filled: a full meter is a finished step, and a full bar
	 * would say the whole job is done while it runs on.
	 */
	readonly share?: number;
	/** What else the meter said, most useful first so a short line keeps it: time left, size, speed. */
	readonly parts: readonly string[];
}

/** A reading from one output line; `trusted` when the line is plainly a meter, not a percentage in passing. */
export interface Reading extends Progress {
	readonly trusted: boolean;
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };
const SLEEP_STEP = /^sleep((?:\s+\d+(?:\.\d+)?[smhd]?)+)$/;

/**
 * The length of the sleeps a command starts with, in ms. Only plain steps
 * joined by `;`, `&&` or a newline count: a sleep in a pipe, a loop or the
 * background says nothing about how long the whole will take.
 */
export function leadingSleepMs(command: string): number | undefined {
	let seconds = 0;
	for (const step of command.split(/;|&&|\n/)) {
		const match = SLEEP_STEP.exec(step.trim());
		if (!match) break;
		for (const arg of match[1]!.trim().split(/\s+/)) seconds += Number.parseFloat(arg) * (UNIT_SECONDS[arg.at(-1)!] ?? 1);
	}
	return seconds > 0 ? Math.round(seconds * 1_000) : undefined;
}

/**
 * A tool's time left in ms, from however it writes it: `0:00:32` (curl,
 * rsync, pip), `04:12` (tqdm), `1m 5s` (wget). Unknown for `--:--:--` or `?`.
 */
export function parseEta(text: string | undefined): number | undefined {
	const eta = text?.trim() ?? "";
	const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(eta);
	if (clock) return ((Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1_000;
	const units = /^(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/.exec(eta);
	if (!units || eta === "") return undefined;
	const [d, h, m, s] = units.slice(1).map((part) => Number(part ?? 0));
	return (((d! * 24 + h!) * 60 + m!) * 60 + s!) * 1_000;
}

/** How far a leading sleep has got; unknown once it is over, when whatever follows runs. */
export function sleepProgress(command: string, elapsedMs: number): Progress | undefined {
	const total = leadingSleepMs(command);
	if (total === undefined || elapsedMs >= total) return undefined;
	return { share: Math.max(0, elapsedMs) / total, parts: [`${formatWhole(total - elapsedMs)} left`] };
}

type Reader = (line: string) => Reading | undefined;

const percent = (text: string): number | undefined => {
	const value = Number.parseFloat(text);
	return Number.isFinite(value) && value >= 0 && value <= 100 ? value / 100 : undefined;
};
const fraction = (done: string, total: string): number | undefined => {
	const [a, b] = [Number.parseFloat(done), Number.parseFloat(total)];
	return Number.isFinite(a) && Number.isFinite(b) && b > 0 && a >= 0 && a <= b ? a / b : undefined;
};
const meter = (share: number | undefined, parts: Array<string | undefined>, trusted = true): Reading | undefined =>
	share === undefined ? undefined : { share, parts: parts.filter((part): part is string => !!part), trusted };
/** Time left, written one way whatever the tool: `32s left`, `4m 12s left`. None when nothing is left or it isn't known. */
const left = (eta: string | undefined) => {
	const ms = parseEta(eta);
	return ms ? `${formatWhole(ms)} left` : undefined;
};

const CURL_TIME = /^(\d+:\d{2}:\d{2}|--:--:--)$/;
/** curl's meter: `% Total Total % Received Received % Xferd Xferd Dload Upload Time Time Time Current`. */
const curl: Reader = (line) => {
	const cols = line.trim().split(/\s+/);
	if (cols.length !== 12 || ![0, 2, 4].every((i) => /^\d{1,3}$/.test(cols[i]!)) || ![8, 9, 10].every((i) => CURL_TIME.test(cols[i]!))) return undefined;
	// A download of unknown size has a total of 0: how much and how fast, but no share.
	if (cols[1] === "0") return { parts: [cols[3]!, `${cols[11]}/s`], trusted: true };
	return meter(percent(cols[0]!), [left(cols[10]), `${cols[3]}/${cols[1]}`, `${cols[11]}/s`]);
};

const wget: Reader = (line) => {
	const match = /(\d{1,3})%\[[^\]]*\]\s+(\S+)\s+(\S+)(?:\s+(?:eta\s+(.+?)|in\s+\S+))?\s*$/.exec(line);
	if (match) return meter(percent(match[1]!), [left(match[4]), match[2], match[3]]);
	// Into a log wget draws dots, not its bar: `5450K .......... 45% 5.20M 1m14s`.
	const dots = /^\s*\d+[KMG]\s+[. ]+\s(\d{1,3})%\s+(\S+)\s+(\S+)\s*$/.exec(line);
	if (dots) return meter(percent(dots[1]!), [left(dots[3]), `${dots[2]}/s`]);
	// No length known: a bouncing `<=>` instead of a bar.
	const unsized = /\[\s*<=>\s*\]\s+(\S+)\s+(\S+\/s)\s*$/.exec(line);
	return unsized ? { parts: [unsized[1]!, unsized[2]!], trusted: true } : undefined;
};

const rsync: Reader = (line) => {
	const match = /^\s*[\d,.]+[KMGTP]?\s+(\d{1,3})%\s+(\S+\/s)\s+(\d+:\d{2}:\d{2})/.exec(line);
	return match ? meter(percent(match[1]!), [left(match[3]), match[2]]) : undefined;
};

const git: Reader = (line) => {
	const match = /^(?:remote:\s+)?([A-Z][a-z]+(?: [a-z]+)*):\s+(\d{1,3})%\s+\(\d+\/\d+\)/.exec(line);
	if (!match) return undefined;
	return meter(percent(match[2]!), [match[1]!.toLowerCase(), /\|\s*([\d.]+ ?\S+\/s)/.exec(line)?.[1]]);
};

/** pip's rich bar: `━━━━╺━━━ 412.3/790.1 MB 12.1 MB/s eta 0:00:31`. */
const pip: Reader = (line) => {
	if (!/[━╸╺]/.test(line)) return undefined;
	const match = /([\d.]+)\/([\d.]+)\s+(\S*B)\b(?:\s+([\d.]+\s+\S*B\/s))?(?:\s+eta\s+(\S+))?/.exec(line);
	return match ? meter(fraction(match[1]!, match[2]!), [left(match[5]), `${match[1]}/${match[2]} ${match[3]}`, match[4]]) : undefined;
};

/** tqdm: `Epoch 3:  34%|███▍      | 340/1000 [02:08<04:12,  2.65it/s]`. */
const tqdm: Reader = (line) => {
	const match = /(\d{1,3})%\|[^|]*\|\s*([\d.]+[kMGT]?)\/([\d.]+[kMGT]?)\s*\[[^<\]]*<([^,\]]+)/.exec(line);
	return match ? meter(percent(match[1]!), [left(match[4]!.trim()), `${match[2]}/${match[3]}`]) : undefined;
};

/** ninja and its kin: `[45/120] Compiling src/foo.c`. */
const ninja: Reader = (line) => {
	const match = /^\[(\d+)\/(\d+)\]\s/.exec(line);
	return match ? meter(fraction(match[1]!, match[2]!), [`${match[1]}/${match[2]}`]) : undefined;
};

/** cargo: `Building [=======>     ] 120/304: serde, syn`. */
const cargo: Reader = (line) => {
	const match = /\[[=> -]{3,}\]\s+(\d+)\/(\d+)/.exec(line);
	return match ? meter(fraction(match[1]!, match[2]!), [`${match[1]}/${match[2]}`]) : undefined;
};

const PERCENT = /(?<![\d.])(\d{1,3}(?:\.\d+)?)%/g;
/** A drawn bar: a long run of bar characters, so a `=== heading ===` is not one. */
const BAR = /[#=█━■▇▆▉▊▋▌▍▎▏▓]{5,}/;

/** The last percentage on a line, trusted when a bar is drawn beside it (curl -#, most others). */
const bare: Reader = (line) => {
	const last = [...line.matchAll(PERCENT)].at(-1);
	return last ? meter(percent(last[1]!), [], BAR.test(line)) : undefined;
};

const READERS: readonly Reader[] = [curl, wget, rsync, git, pip, tqdm, ninja, cargo, bare];

/** What one output line says about progress, if anything. */
export function readProgress(line: string): Reading | undefined {
	for (const reader of READERS) {
		const reading = reader(line);
		if (reading) return reading;
	}
	return undefined;
}

/** How long a bar outlasts its meter line: through lines printed between updates, not through a silent next step. */
export const METER_HOLD_MS = 3_000;

/**
 * What a job's output has shown so far: the last bar, when its meter was
 * read and since when other lines have followed it, and the last bare
 * percentage, to tell a climb from a mention.
 */
export interface ProgressState {
	readonly shown?: Progress;
	readonly seenAt?: number;
	readonly staleSince?: number;
	readonly bare?: number;
	readonly rose?: boolean;
}

/**
 * A reading as it shows. A full meter is a finished step, so it keeps its
 * facts but loses its share and any time left (rsync prints the time taken
 * there); one with nothing left to say shows nothing.
 */
function shownOf(reading: Reading, now: number): Pick<ProgressState, "shown" | "seenAt"> {
	if (reading.share !== undefined && reading.share < 1) return { shown: { share: reading.share, parts: reading.parts }, seenAt: now };
	const parts = reading.parts.filter((part) => !part.endsWith(" left"));
	return parts.length > 0 ? { shown: { parts }, seenAt: now } : {};
}

/**
 * The state after a new latest line. A meter shows at once. A bare
 * percentage shows once it has risen past the one before, and stops at the
 * first fall (per-file coverage, a CPU monitor), until it climbs again.
 * Other output leaves the last bar held, stale from that line on.
 */
export function nextProgress(state: ProgressState, line: string | undefined, now: number): ProgressState {
	const reading = line === undefined ? undefined : readProgress(line);
	const held = (memory: ProgressState): ProgressState => (state.shown
		? { ...memory, shown: state.shown, ...(state.seenAt !== undefined ? { seenAt: state.seenAt } : {}), staleSince: state.staleSince ?? now }
		: memory);
	const climb: ProgressState = { ...(state.bare !== undefined ? { bare: state.bare } : {}), ...(state.rose ? { rose: true } : {}) };
	if (!reading) return held(climb);
	if (reading.trusted) return { ...climb, ...shownOf(reading, now) };
	// A bare percentage always has a share; only meters go without one.
	const share = reading.share ?? 0;
	const fell = state.bare !== undefined && share < state.bare;
	const rose = (state.bare !== undefined && share > state.bare) || (state.rose === true && !fell);
	const memory: ProgressState = { bare: share, ...(rose ? { rose: true } : {}) };
	if (rose) return { ...memory, ...shownOf(reading, now) };
	return fell ? memory : held(memory);
}

/** The bar to show now: held a moment past its meter line, and facts with no share only while the meter writes them. */
export function progressNow(state: ProgressState, now: number): Progress | undefined {
	const { shown } = state;
	if (!shown) return undefined;
	if (state.staleSince !== undefined) return now - state.staleSince < METER_HOLD_MS ? shown : undefined;
	if (shown.share === undefined) return now - (state.seenAt ?? now) < METER_HOLD_MS ? shown : undefined;
	return shown;
}
