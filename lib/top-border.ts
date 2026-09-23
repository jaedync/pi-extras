/**
 * Who draws in the editor's top border row. Phase-spinner owns it while the
 * agent works or Pi shows a status; voice borrows it while recording
 * otherwise; the spinner's last-run summary returns afterwards.
 *
 * The two extensions can be loaded from different copies of this package
 * (`pi -e` next to an installed one), so they coordinate over pi.events rather
 * than shared module state. Keep the v1 fields stable: an older copy on the
 * other side must still understand every message.
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const TOP_BORDER_CHANNEL = "pi-extras:top-border";

export type TopBorderRole = "phase-spinner" | "voice";

export interface TopBorderMessage {
	readonly v: number;
	readonly from: TopBorderRole;
	/** Spinner: busy with a run or status. Voice: wants the row for a recording. */
	readonly active: boolean;
	/** Asks the other side to announce its state. */
	readonly hello?: boolean;
}

export interface TopBorderBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

const VERSION = 1;
const ROLES: ReadonlySet<string> = new Set<TopBorderRole>(["phase-spinner", "voice"]);

export function parseTopBorderMessage(data: unknown): TopBorderMessage | undefined {
	if (!data || typeof data !== "object") return undefined;
	const message = data as Record<string, unknown>;
	if (typeof message.v !== "number" || message.v < VERSION) return undefined;
	if (typeof message.from !== "string" || !ROLES.has(message.from) || typeof message.active !== "boolean") return undefined;
	return { v: message.v, from: message.from as TopBorderRole, active: message.active, hello: message.hello === true };
}

export class TopBorderLink {
	private readonly bus?: TopBorderBus;
	private readonly role: TopBorderRole;
	private readonly onPeerChange: () => void;
	private readonly unsubscribe: () => void;
	private active = false;
	private peer = false;
	private known = false;

	constructor(bus: TopBorderBus | undefined, role: TopBorderRole, onPeerChange: () => void) {
		this.bus = bus;
		this.role = role;
		this.onPeerChange = onPeerChange;
		this.unsubscribe = bus?.on(TOP_BORDER_CHANNEL, (data) => this.receive(data)) ?? (() => {});
	}

	/** What the other extension last announced; false until it is heard from. */
	get peerActive(): boolean {
		return this.peer;
	}

	/** The other side speaks this protocol. Copies from before it never answer, and never yield the row. */
	get peerKnown(): boolean {
		return this.known;
	}

	set(active: boolean): void {
		if (active === this.active) return;
		this.active = active;
		this.send(false);
	}

	/** Announce this side and ask the other to answer, e.g. after a session starts. */
	hello(): void {
		this.send(true);
	}

	dispose(): void {
		this.set(false);
		this.unsubscribe();
		this.peer = false;
		this.known = false;
	}

	private send(hello: boolean): void {
		const message: TopBorderMessage = hello ? { v: VERSION, from: this.role, active: this.active, hello } : { v: VERSION, from: this.role, active: this.active };
		this.bus?.emit(TOP_BORDER_CHANNEL, message);
	}

	private receive(data: unknown): void {
		const message = parseTopBorderMessage(data);
		if (!message || message.from === this.role) return;
		// Answering without hello keeps the exchange to one round trip.
		if (message.hello) this.send(false);
		const firstContact = !this.known;
		this.known = true;
		if (message.active === this.peer && !firstContact) return;
		this.peer = message.active;
		this.onPeerChange();
	}
}

/** Where the voice row goes: the top border when free, the bottom border otherwise. */
export function voiceRow(state: { spinnerBusy: boolean; piWorking: boolean; topLine: string | undefined; spinnerKnown: boolean }): "top" | "bottom" {
	// Without a spinner that answered the handshake, the top row may be drawn over by one that cannot.
	if (!state.spinnerKnown) return "bottom";
	if (state.spinnerBusy || state.piWorking || state.topLine === undefined) return "bottom";
	// Only replace a border row; anything else belongs to an editor this code does not know.
	return stripTerminalSequences(state.topLine).startsWith("─") ? "top" : "bottom";
}
