/**
 * Headless runs (`pi -p`, `--mode json`) end when main settles, and Pi then
 * disposes the session, so background children would be cut off and their
 * reports lost. At main's settle check this waits until no child is working
 * or until mail that wakes main is waiting (a question, a note, a report).
 * The mail then goes into main's context as boundary entries, with one more
 * turn to read it. A child asking main blocks on main's answer, so mail ends
 * the wait rather than the child.
 */
import type { MainMail } from "./deliver.ts";
import type { Team } from "./team.ts";

// A note to main changes no record, so the wait also looks now and then.
const LOOK_MS = 250;

export type HeadlessMode = "print" | "json";

export const isHeadless = (mode: string | undefined): mode is HeadlessMode => mode === "print" || mode === "json";

/** Mail as Pi appends it at a boundary. */
export interface MailEntry {
	readonly type: "custom_message";
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details: unknown;
}

/** What main is handed once it may settle: the mail to append, and whether it needs a turn to read it. */
export interface Handover {
	readonly entries: readonly MailEntry[];
	readonly wakes: boolean;
}

export function awaitChildren(team: Pick<Team, "live" | "onChange" | "stopping">, mail: Pick<MainMail, "waiting" | "takeAll">): Promise<Handover> {
	return new Promise((resolve) => {
		let stop: (() => void) | undefined;
		let done = false;
		const timer = setInterval(() => check(), LOOK_MS);
		const check = () => {
			// A stopped record is no longer live before its report reaches the mail.
			if (done || ((team.live().length > 0 || team.stopping()) && !mail.waiting())) return;
			done = true;
			stop?.();
			clearInterval(timer);
			const { messages, wakes } = mail.takeAll();
			resolve({ entries: messages.map((message) => ({ type: "custom_message", ...message })), wakes });
		};
		// A record changes before its report is handed to the mail, so look once that has happened.
		stop = team.onChange(() => { setImmediate(check); });
		check();
	});
}
