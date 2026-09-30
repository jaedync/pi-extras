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
}

const fromAssistant = (event: { message?: unknown }) => (event.message as { role?: unknown } | undefined)?.role === "assistant";

export function watchRun(pi: Pick<ExtensionAPI, "on">): RunWatch {
	let streaming = false;
	let busy = false;
	pi.on("session_start", () => {
		streaming = false;
		busy = false;
	});
	pi.on("agent_start", () => { busy = true; });
	pi.on("message_start", (event) => { if (fromAssistant(event)) streaming = true; });
	pi.on("message_end", (event) => { if (fromAssistant(event)) streaming = false; });
	pi.on("agent_end", () => {
		// An aborted or failed reply may never end its message.
		streaming = false;
		busy = false;
	});
	return { streaming: () => streaming, busy: () => busy };
}
