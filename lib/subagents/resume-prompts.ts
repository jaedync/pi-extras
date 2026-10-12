/**
 * What a child's next launch is prompted with instead of its task (team.ts
 * `start`): a note from the team (a resume warning, a fallback model, a moved
 * session) and the message that resumed it. When that launch can't go (a
 * stop, a failed launch, a close), the message is not lost: `park` hands it
 * back for the child's inbox, and the note, which only explained that
 * launch, goes.
 */
export interface ResumePrompt {
	readonly note: string;
	readonly message?: string;
}

/**
 * A launch's first prompt: the task when the session has not started it, or
 * the note; then mail that waited in the inbox, oldest first; then the
 * message that resumed it, which is the newest.
 */
export function launchPrompt(parts: { task?: string; after: string; resumed?: ResumePrompt; inbox: readonly string[] }): string {
	const head = [parts.task, parts.resumed?.note.trimEnd()].filter(Boolean).join("\n\n");
	return [`${head}${parts.after}`, ...parts.inbox, parts.resumed?.message].filter(Boolean).join("\n\n");
}

export class ResumePrompts {
	private readonly prompts = new Map<string, ResumePrompt>();

	set(name: string, prompt: ResumePrompt): void {
		this.prompts.set(name, prompt);
	}

	has(name: string): boolean {
		return this.prompts.has(name);
	}

	/** The message a queued launch carries, which a new note keeps. */
	message(name: string): string | undefined {
		return this.prompts.get(name)?.message;
	}

	/** The launch's prompt, which it now uses. */
	take(name: string): ResumePrompt | undefined {
		const prompt = this.prompts.get(name);
		this.prompts.delete(name);
		return prompt;
	}

	/** The launch will not go: its message, if any, for the inbox. */
	park(name: string): string | undefined {
		const message = this.prompts.get(name)?.message;
		this.prompts.delete(name);
		return message;
	}

	names(): string[] {
		return [...this.prompts.keys()];
	}
}
