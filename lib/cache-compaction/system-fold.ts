import type { SessionProjection } from "@earendil-works/pi-coding-agent";

type Message = SessionProjection["messages"][number];
type SystemMessage = Extract<Message, { role: "system" }>;

/** Pi's fold is not exported by the coding-agent SDK. Adapt its exact behavior; see THIRD_PARTY.md. */
export function foldSystem(messages: readonly Message[]): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, NonNullable<SystemMessage["toolsAdded"]>[number]>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (message.role !== "system") continue;
		timestamp ??= message.timestamp;
		const text = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		if (text.length) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	if (timestamp === undefined && !tools.size) return undefined;
	return { role: "system", content: content.join("\n\n"), ...(sections.size ? { sections: Object.fromEntries(sections) } : {}), ...(tools.size ? { toolsAdded: [...tools.values()] } : {}), timestamp: timestamp ?? 0 };
}

/** Canonical entry positions survive the fold, so retained conversation boundaries never move. */
export function foldProjection(messages: readonly Message[], request: readonly Message[], hash: (message: Message) => string): { messages: readonly Message[]; indices: readonly number[] } {
	const head = foldSystem(messages);
	if (!head || request[0]?.role !== "system" || request.filter((message) => message.role === "system").length !== 1 || hash(head) !== hash(request[0])) return { messages, indices: messages.map((_, index) => index) };
	let next = 1;
	return { messages: [head, ...messages.filter((message) => message.role !== "system")], indices: messages.map((message) => message.role === "system" ? 0 : next++) };
}
