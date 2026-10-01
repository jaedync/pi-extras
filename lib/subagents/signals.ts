/** Record synchronously before Pi's asynchronous terminal teardown or a host's default exit. */
export function installSignalRecorder(record: (signal: NodeJS.Signals) => void): () => void {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const handlers = signals.map((signal) => {
		const handler = () => {
			record(signal);
			// SDK hosts without their own handler must still terminate normally.
			if (process.listenerCount(signal) === 1) {
				remove();
				process.kill(process.pid, signal);
			}
		};
		process.prependListener(signal, handler);
		return { signal, handler };
	});
	const remove = () => { for (const { signal, handler } of handlers) process.off(signal, handler); };
	return remove;
}
