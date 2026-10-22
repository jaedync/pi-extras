/**
 * sleep-progress: how far a command that waits has got, from the sleeps it
 * really ran (lib/sleep-watch.ts) and the shape of its loop, if it has one.
 *
 * The live sleeps give what the text can't: the length of `sleep $s` once the
 * shell has filled it in, and how many passes a loop has made. The text gives
 * what the processes can't: how many passes a `for` loop will make. Together:
 *
 * - a `for` loop with a known list fills over all its passes: by time when
 *   each pass only sleeps (exact), else by passes made, each as long as the
 *   last one measured (an estimate, so its time left reads `~`);
 * - a `while` or `until` loop, or a `for` loop over a list of unknown size,
 *   has no end to fill toward, so each sleep fills on its own and the rail
 *   counts the checks;
 * - any other sleep fills over its own length.
 */

import { formatWhole } from "./band/band.ts";
import { sleepStepMs, type Progress } from "./shell-jobs-progress.ts";

/** One sleep process a command ran; `index` counts the command's sleeps from 0. */
export interface SeenSleep {
	readonly index: number;
	readonly startedAt: number;
	readonly ms: number;
}

/** What the watch saw of one command's sleeps. */
export interface LiveSleeps {
	readonly count: number;
	/** The first few sleeps, where a loop's first pass is. */
	readonly first: readonly SeenSleep[];
	/** The latest sleeps, oldest first. */
	readonly recent: readonly SeenSleep[];
	/** The sleep running now. */
	readonly running?: SeenSleep;
}

export interface LoopShape {
	readonly kind: "for" | "poll";
	/** Passes a `for` loop makes, when its list can be counted. */
	readonly passes?: number;
	/** Sleeps the command runs before the loop. */
	readonly before: number;
	/** Sleeps in one pass. */
	readonly perPass: number;
	/** How long one pass takes, when it does nothing but sleep. */
	readonly passMs?: number;
}

export interface LiveProgress {
	readonly progress: Progress;
	/** When the wait shown ends, for a check against the timeout; none while a loop's first pass is unmeasured. */
	readonly endsAt?: number;
}

/** Where a word can start a command: the start, after an operator, or after a keyword that opens a list. */
const AT_COMMAND = String.raw`(?:^|[;&|\n(]|\bdo|\bthen|\belse)\s*`;
const SLEEP_WORD = new RegExp(`${AT_COMMAND}sleep\\s`, "g");
const LOOP = new RegExp(`${AT_COMMAND}(for|while|until)\\s`);
/** `do` and `done` as keywords, not inside a word or a name such as `done.flag`. */
const DO_WORD = /(?:^|[;\n)])\s*do(?=\s)/g;
const DONE_WORD = new RegExp(`${AT_COMMAND}done(?=$|[\\s;&|)])`, "g");
const FOR_LIST = /^for\s+[A-Za-z_]\w*\s+in\s+([^;\n]*?)\s*(?:;|\n)\s*do\s/;
const RANGE = /^\{(-?\d+)\.\.(-?\d+)\}$/;
const SEQ = /^\$\(seq\s+(-?\d+)(?:\s+(-?\d+))?(?:\s+(-?\d+))?\s*\)$/;
/** Over this many passes the list is not worth counting word by word. */
const MAX_PASSES = 100_000;

const sleepsIn = (text: string) => text.match(SLEEP_WORD)?.length ?? 0;
const words = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

function countList(list: string): number | undefined {
	const range = RANGE.exec(list);
	if (range) return Math.abs(Number(range[2]) - Number(range[1])) + 1;
	const seq = SEQ.exec(list);
	if (seq) {
		const [first, step, last] = seq[3] !== undefined ? [Number(seq[1]), Number(seq[2]), Number(seq[3])] : seq[2] !== undefined ? [Number(seq[1]), 1, Number(seq[2])] : [1, 1, Number(seq[1])];
		if (step === 0) return undefined;
		const passes = Math.floor((last - first) / step) + 1;
		return passes > 0 && passes <= MAX_PASSES ? passes : undefined;
	}
	const items = list.split(/\s+/).filter(Boolean);
	// A substitution, glob or brace expands to a number of words the text doesn't show.
	return items.length > 0 && items.every((item) => !/[$`*?[{]/.test(item)) ? items.length : undefined;
}

/** A pass's length when every step of it is a plain sleep. */
function sleepOnlyMs(body: string): number | undefined {
	let total = 0;
	for (const step of body.split(/;|&&|\n/).map((part) => part.trim()).filter(Boolean)) {
		const ms = sleepStepMs(step);
		if (ms === undefined) return undefined;
		total += ms;
	}
	return total > 0 ? total : undefined;
}

/** The last command read: a running row asks again on every frame. */
let lastRead: { readonly command: string; readonly shape: LoopShape | undefined } | undefined;

/** The one loop a command runs, read from its text; none when there are several, or nested ones. */
export function loopShape(command: string): LoopShape | undefined {
	if (lastRead?.command !== command) lastRead = { command, shape: readLoop(command) };
	return lastRead.shape;
}

function readLoop(command: string): LoopShape | undefined {
	const loop = LOOP.exec(command);
	if (!loop || words(command, DO_WORD) !== 1 || words(command, DONE_WORD) !== 1) return undefined;
	const start = loop.index + loop[0].length - loop[1]!.length - 1;
	const head = command.slice(start);
	const doAt = new RegExp(DO_WORD.source).exec(head);
	const doneAt = new RegExp(DONE_WORD.source).exec(head);
	if (!doAt || !doneAt || doneAt.index < doAt.index) return undefined;
	const body = head.slice(doAt.index + doAt[0].length, doneAt.index);
	const perPass = sleepsIn(body);
	if (perPass === 0) return undefined;
	const before = sleepsIn(command.slice(0, start));
	if (loop[1] !== "for") return { kind: "poll", before, perPass };
	const list = FOR_LIST.exec(head.trimStart());
	const passes = list ? countList(list[1]!) : undefined;
	const passMs = sleepOnlyMs(body);
	return { kind: "for", ...(passes !== undefined ? { passes } : {}), before, perPass, ...(passMs !== undefined ? { passMs } : {}) };
}

const left = (ms: number, exact: boolean) => `${exact ? "" : "~"}${formatWhole(ms)} left`;

/** The sleep running now, filling over its own length. */
function ownSleep(sleep: SeenSleep | undefined, now: number, label?: string): LiveProgress | undefined {
	if (!sleep || now >= sleep.startedAt + sleep.ms) return undefined;
	const share = Math.max(0, now - sleep.startedAt) / sleep.ms;
	const endsAt = sleep.startedAt + sleep.ms;
	return { progress: { share, parts: [...(label ? [label] : []), left(endsAt - now, true)] }, endsAt };
}

const at = (sleeps: LiveSleeps, index: number) => sleeps.first.find((sleep) => sleep.index === index) ?? sleeps.recent.find((sleep) => sleep.index === index);

/** A `for` loop with a known number of passes, filling over all of them. */
function forLoop(shape: LoopShape & { passes: number }, sleeps: LiveSleeps, now: number): LiveProgress | undefined {
	const { passes, perPass, before } = shape;
	const firstStart = at(sleeps, before)?.startedAt;
	if (firstStart === undefined) return undefined;
	let position: number;
	let passMs = shape.passMs;
	if (passMs !== undefined) {
		// Sleeps alone: time says where the loop is, even if a short sleep went unseen.
		position = (now - firstStart) / passMs;
	} else {
		const made = Math.ceil((sleeps.count - before) / perPass);
		const anchor = at(sleeps, before + (made - 1) * perPass)?.startedAt;
		const previous = made >= 2 ? at(sleeps, before + (made - 2) * perPass)?.startedAt : undefined;
		passMs = anchor !== undefined && previous !== undefined ? anchor - previous : undefined;
		if (anchor === undefined || passMs === undefined || passMs <= 0) {
			return { progress: { share: (made - 1) / passes, parts: [`${made} of ${passes}`] } };
		}
		position = made - 1 + Math.min(0.99, (now - anchor) / passMs);
	}
	position = Math.min(position, passes - 0.01);
	const remaining = (passes - position) * passMs;
	const pass = Math.min(passes, Math.floor(position) + 1);
	return { progress: { share: position / passes, parts: [`${pass} of ${passes}`, left(remaining, shape.passMs !== undefined)] }, endsAt: now + remaining };
}

/** How far a command's wait has got, from the sleeps it ran; none when nothing says. */
export function liveSleepProgress(command: string, sleeps: LiveSleeps, now: number): LiveProgress | undefined {
	const shape = loopShape(command);
	const inLoop = shape ? sleeps.count - shape.before : 0;
	const inside = shape !== undefined && inLoop >= 1 && (shape.passes === undefined || inLoop <= shape.passes * shape.perPass);
	if (!inside) return ownSleep(sleeps.running, now);
	if (shape.kind === "for" && shape.passes !== undefined) return forLoop({ ...shape, passes: shape.passes }, sleeps, now);
	const pass = Math.ceil(inLoop / shape.perPass);
	return ownSleep(sleeps.running, now, `${shape.kind === "for" ? "pass" : "check"} ${pass}`);
}
