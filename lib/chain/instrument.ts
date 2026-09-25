/**
 * Rewrites a split command so each step announces itself as it runs, and
 * removes those announcements from the output again before anyone reads it.
 *
 * Each step is wrapped in a `{ }` group (not a subshell, so `cd` and
 * variables carry over as before) that prints a start mark, restores the
 * previous step's exit status so `$?` reads as it would have, runs the step,
 * then prints an end mark with the step's status and returns it, so `&&` and
 * `||` decide exactly as they would have. A step's text is followed by a
 * newline, never a `;`, so a trailing comment can't swallow the wrapper.
 *
 * Marks are single lines on stdout: a record separator byte, `PI:`, a random
 * nonce and the mark. The stripper recognises only its own nonce, so a
 * program that prints something similar passes through untouched.
 */
import { basename } from "node:path";
import type { Chain } from "./split.ts";

export type Mark =
	| { readonly kind: "start"; readonly step: number }
	| { readonly kind: "end"; readonly step: number; readonly code: number };

const RS = 0x1e;
const NEWLINE = 0x0a;
// A mark body is `s 12` or `e 12 255`; anything longer isn't one.
const MAX_BODY = 32;

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh", "mksh"]);

export function supportedShell(shellPath: string | undefined): boolean {
	if (!shellPath) return false;
	const name = basename(shellPath.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
	return POSIX_SHELLS.has(name);
}

export function instrument(chain: Chain, nonce: string): string {
	const prologue = `__pi_m() { printf '\\036PI:${nonce}:%s\\n' "$*"; }; __pi_r() { return "$1"; }; __pi_s=0`;
	let body = "";
	chain.steps.forEach((step, index) => {
		const n = index + 1;
		const group = `{ __pi_m s ${n}; __pi_r "$__pi_s"; ${step.text}\n__pi_s=$?; __pi_m e ${n} "$__pi_s"; __pi_r "$__pi_s"; }`;
		if (index === 0) body = group;
		else body += step.op === ";" ? `\n${group}` : ` ${step.op} ${group}`;
	});
	return `${prologue}\n${body}`;
}

function parseMark(body: string): Mark | undefined {
	const match = /^(?:s (\d+)|e (\d+) (\d+))$/.exec(body);
	if (!match) return undefined;
	if (match[1] !== undefined) return { kind: "start", step: Number(match[1]) - 1 };
	return { kind: "end", step: Number(match[2]) - 1, code: Number(match[3]) };
}

/** Takes the output stream chunk by chunk; returns output bytes and marks, in order. */
export class MarkStripper {
	private readonly prefix: Buffer;
	private carry: Buffer = Buffer.alloc(0);

	constructor(nonce: string) {
		this.prefix = Buffer.from(`\x1ePI:${nonce}:`);
	}

	push(chunk: Buffer): Array<Buffer | Mark> {
		const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
		this.carry = Buffer.alloc(0);
		const out: Array<Buffer | Mark> = [];
		let pos = 0;
		while (pos < data.length) {
			const at = data.indexOf(RS, pos);
			if (at < 0) {
				out.push(data.subarray(pos));
				break;
			}
			if (at > pos) out.push(data.subarray(pos, at));
			const rest = data.subarray(at);
			const compared = Math.min(rest.length, this.prefix.length);
			if (!rest.subarray(0, compared).equals(this.prefix.subarray(0, compared))) {
				out.push(data.subarray(at, at + 1));
				pos = at + 1;
				continue;
			}
			const end = rest.indexOf(NEWLINE, this.prefix.length);
			if (rest.length < this.prefix.length || (end < 0 && rest.length <= this.prefix.length + MAX_BODY)) {
				// Possibly a mark cut off by the chunk boundary: wait for the rest.
				this.carry = Buffer.from(rest);
				break;
			}
			const mark = end < 0 ? undefined : parseMark(rest.subarray(this.prefix.length, end).toString("latin1"));
			if (!mark) {
				out.push(data.subarray(at, at + 1));
				pos = at + 1;
				continue;
			}
			out.push(mark);
			pos = at + end + 1;
		}
		return out.filter((piece) => !Buffer.isBuffer(piece) || piece.length > 0);
	}

	/** Whatever was held back waiting for a mark that never finished. */
	flush(): Buffer[] {
		const rest = this.carry;
		this.carry = Buffer.alloc(0);
		return rest.length > 0 ? [rest] : [];
	}
}
