/**
 * When main's question resumes an idle child, and the child answers it with
 * only a `message` call, the answer can stand in for that run's report, which
 * then need not wake main (team.ts, deliver.ts). Any work after the answer
 * is news main has not heard, so it ends that.
 */
export class MainAnswers {
	/** Children main resumed from idle with a question: only that answer can stand in for the run's report. */
	private readonly resumed = new Set<string>();
	/** Tool calls a child had finished when it gave that answer. */
	private readonly answeredAt = new Map<string, number>();

	/** Main's question resumed `name` from idle. */
	resumedToAnswer(name: string): void {
		this.resumed.add(name);
	}

	/** `name` answers main now, after `toolCalls` calls; true when that answer can stand in for its run's report. */
	answers(name: string, toolCalls: number, onlyMessageCall: () => boolean): boolean {
		if (!this.resumed.delete(name) || !onlyMessageCall()) return false;
		this.answeredAt.set(name, toolCalls);
		return true;
	}

	/** The call that carried the answer ends right after it; any call after that is work main has not heard about. */
	workedSince(name: string, toolCalls: number | undefined): boolean {
		const at = this.answeredAt.get(name);
		if (at === undefined || toolCalls === undefined || toolCalls <= at + 1) return false;
		this.answeredAt.delete(name);
		return true;
	}

	forget(name: string): void {
		this.resumed.delete(name);
		this.answeredAt.delete(name);
	}
}
