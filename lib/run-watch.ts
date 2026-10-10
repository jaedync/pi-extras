/**
 * What the agent is doing, from Pi's events: whether a run is going, and
 * whether the model is streaming a reply. A call row built while a reply
 * streams is being written now; one built otherwise was rebuilt from history,
 * such as a call a resumed session never got the result of.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RunWatch {
	/** The model is streaming a reply. */
	readonly streaming: () => boolean;
	/** An agent run is going, so a call may be running. */
	readonly busy: () => boolean;
	/**
	 * The model has written this call of the reply it streams. Pi completes a
	 * reply's calls only at message_end, so an earlier call would otherwise
	 * read as written while the model writes the next.
	 */
	readonly written: (toolCallId: string) => boolean;
}

const fromAssistant = (event: { message?: unknown }) => (event.message as { role?: unknown } | undefined)?.role === "assistant";

export function watchRun(pi: Pick<ExtensionAPI, "on">): RunWatch {
	let streaming = false;
	let busy = false;
	let written = new Set<string>();
	pi.on("session_start", () => {
		streaming = false;
		busy = false;
		written = new Set();
	});
	pi.on("agent_start", () => { busy = true; });
	pi.on("message_start", (event) => {
		if (!fromAssistant(event)) return;
		streaming = true;
		written = new Set();
	});
	pi.on("message_update", (event) => {
		const update = (event as { assistantMessageEvent?: { type?: unknown; toolCall?: { id?: unknown } } }).assistantMessageEvent;
		const id = update?.toolCall?.id;
		if (update?.type === "toolcall_end" && typeof id === "string") written = new Set(written).add(id);
	});
	pi.on("message_end", (event) => { if (fromAssistant(event)) streaming = false; });
	pi.on("agent_end", () => {
		// An aborted or failed reply may never end its message.
		streaming = false;
		busy = false;
	});
	return { streaming: () => streaming, busy: () => busy, written: (id) => written.has(id) };
}
