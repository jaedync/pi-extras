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

	/** The launch's prompt, and it is used: the note, then the message. */
	take(name: string): string | undefined {
		const prompt = this.prompts.get(name);
		this.prompts.delete(name);
		if (!prompt) return undefined;
		if (prompt.message === undefined) return prompt.note;
		return prompt.note ? `${prompt.note.trimEnd()}\n\n${prompt.message}` : prompt.message;
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
