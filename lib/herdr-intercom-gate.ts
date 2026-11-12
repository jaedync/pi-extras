/**
 * Holds a session rename until pi-intercom has registered this session with
 * its broker.
 *
 * pi-intercom (0.18.1) builds its broker registration from the session name
 * when it starts to connect. A rename that comes before the broker's answer
 * is lost: pi-intercom sends the presence update on a socket that is not yet
 * registered (the client drops it), but records the new name as sent, so its
 * name poll never sends it again. The session then stays listed as
 * `subagent-chat-<id>` until its next turn. Herdr Tab Name renames a session
 * in its first second, inside that window.
 *
 * The gate uses pi-intercom's public extension channel
 * (`intercom:extension-register`, pi-intercom's extension-api.ts): it learns
 * whether pi-intercom is loaded and when the broker registration is done. A
 * rename made after that reaches the broker through pi-intercom's name poll.
 */

export const INTERCOM_REGISTER_EVENT = "intercom:extension-register";
export const NAMESPACE = "pi-extras/herdr-tab-name";
/** How long a rename waits for a pi-intercom that does not connect (a broker that fails, for example). */
export const INTERCOM_WAIT_MS = 10_000;

export interface EventEmitterLike {
	emit(channel: string, data: unknown): void;
}

interface ChannelLike {
	snapshot(): { connected: boolean };
}

export interface GateOptions {
	/** Calls `fn` once after `ms`; the result cancels it. */
	readonly later: (fn: () => void, ms: number) => () => void;
	readonly waitMs?: number;
	readonly onError?: (error: unknown) => void;
}

export interface IntercomNameGate {
	/** Runs `fn` now, or when pi-intercom is registered. Only the last waiting `fn` runs. */
	run(fn: () => void): void;
	/** Drops a waiting `fn` (the session it was for has ended). The gate stays usable. */
	cancel(): void;
}

export function intercomNameGate(events: EventEmitterLike | undefined, options: GateOptions): IntercomNameGate {
	let channel: ChannelLike | undefined;
	let pending: (() => void) | undefined;
	let cancelWait: (() => void) | undefined;
	// Set when a wait ended with no connection (pi-intercom disabled, or no broker): later renames do not wait 10 s each.
	let gaveUp = false;

	const flush = () => {
		cancelWait?.();
		cancelWait = undefined;
		const fn = pending;
		pending = undefined;
		if (!fn) return;
		try {
			fn();
		} catch (error) {
			options.onError?.(error);
		}
	};

	try {
		// pi-intercom calls onReady before emit returns; with no pi-intercom, nothing listens and channel stays unset.
		events?.emit(INTERCOM_REGISTER_EVENT, {
			namespace: NAMESPACE,
			ownerEligible: false,
			onReady: (value: ChannelLike) => { channel = value; },
			onEvent: (event: { type?: unknown; connected?: unknown }) => {
				if (event?.type === "connection" && event.connected === true) {
					gaveUp = false;
					flush();
				}
			},
		});
	} catch (error) {
		// An event bus that throws gives no channel: renames run at once, as without pi-intercom.
		options.onError?.(error);
		channel = undefined;
	}

	const connected = (): boolean => {
		try {
			return channel?.snapshot().connected ?? true;
		} catch (error) {
			// A channel that cannot answer is not one to wait for: report it, and rename at once from now on.
			options.onError?.(error);
			channel = undefined;
			return true;
		}
	};

	return {
		run(fn) {
			pending = fn;
			if (!channel || gaveUp || connected()) {
				flush();
				return;
			}
			cancelWait ??= options.later(() => {
				gaveUp = true;
				flush();
			}, options.waitMs ?? INTERCOM_WAIT_MS);
		},
		cancel() {
			pending = undefined;
			cancelWait?.();
			cancelWait = undefined;
		},
	};
}
