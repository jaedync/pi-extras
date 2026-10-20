/**
 * How long a SIGCONT listener added after install waits. /subagents takeover sends SIGTERM and SIGCONT together,
 * and either can come first; this gives SIGTERM time to arrive. A person who runs `fg` does not see it.
 */
const SIGCONT_DELAY_MS = 100;
/** Shared by every loaded copy of this module, so no copy wraps a listener twice. */
const DEFERRED = Symbol.for("pi-extras.deferredSigcontListener");

type Listener = (...args: unknown[]) => void;

/** Record synchronously before Pi's asynchronous terminal teardown or a host's default exit. */
export function installSignalRecorder(record: (signal: NodeJS.Signals) => void, options: { readonly sigcontDelayMs?: number } = {}): () => void {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	let ending = false;
	const handlers = signals.map((signal) => {
		const handler = () => {
			ending = true;
			// Pi's Ctrl-Z leaves a SIGCONT listener that restarts its TUI. /subagents takeover sends SIGCONT
			// with this signal, and raw mode set from the background stops Pi again (SIGTTOU) before its
			// shutdown lets the lease go. Pi is quitting, so nothing needs the TUI back.
			process.removeAllListeners("SIGCONT");
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
	const delayMs = options.sigcontDelayMs ?? SIGCONT_DELAY_MS;
	// When SIGCONT comes first, removing listeners at SIGTERM is too late: Pi's restart already ran. Pi adds that
	// listener in its Ctrl-Z handler, just before it stops, so a microtask wraps it before Node emits the SIGCONT
	// that ends the stop.
	const watch = (event: string | symbol, listener: Listener) => {
		if (event === "SIGCONT" && !(DEFERRED in listener)) queueMicrotask(() => defer(listener));
	};
	const defer = (listener: Listener) => {
		const raw = process.rawListeners("SIGCONT").find((entry) => entry === listener || (entry as { listener?: unknown }).listener === listener);
		if (!raw) return;
		const later: Listener = Object.assign((...args: unknown[]) => {
			setTimeout(() => { if (!ending) listener.apply(process, args); }, delayMs);
		}, { [DEFERRED]: true });
		// Add before remove: with no SIGCONT listener left, Node closes the signal handle, and the SIGCONT that
		// libuv caught as Pi ran again, before this microtask, is lost. Then fg would not bring the TUI back.
		if (raw === listener) process.on("SIGCONT", later);
		else process.once("SIGCONT", later);
		process.removeListener("SIGCONT", listener);
	};
	if (process.platform !== "win32") process.on("newListener", watch);
	const remove = () => {
		for (const { signal, handler } of handlers) process.off(signal, handler);
		process.off("newListener", watch);
	};
	return remove;
}
