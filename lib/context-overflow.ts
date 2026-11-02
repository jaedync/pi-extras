/**
 * A full context, in the wording of each provider. Pi compacts on these (pi-ai's
 * isContextOverflow, which pi-extras cannot import at run time), so no other retry or
 * fallback may claim them. The list follows pi-ai's and is wider where a gateway rewords it.
 */
export const CONTEXT_OVERFLOW = new RegExp([
	"context.?length", "context.?window", "maximum context", "prompt (?:is )?too long", "prompt exceeds max length",
	"input is too long", "request_too_large", "too many tokens", "token limit exceeded", "exceeded model token limit",
	"exceeds the available context", "greater than the context length", "maximum prompt length is \\d+",
	"reduce the length of the messages", "input token count.*exceeds the maximum", "exceeds (?:the )?maximum allowed input length",
	"is longer than the model'?s context length", "exceeds the limit of \\d+", "too large for model with \\d+ maximum context length",
	"configured context size is", "range of input length should be",
].join("|"), "i");

export function isContextOverflowText(text: string): boolean {
	return CONTEXT_OVERFLOW.test(text);
}
