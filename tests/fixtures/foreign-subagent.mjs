// Stands in for another subagent extension that owns the `subagent` tool name.
export default function (pi) {
	pi.registerTool({
		name: "subagent", label: "Other subagent", description: "Another extension's subagent tool.",
		parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: "other" }], details: undefined }; },
	});
}
