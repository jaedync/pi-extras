/**
 * Connection to the shared voice daemon. If nothing is listening, starts the
 * daemon once and retries with backoff; callers keep buffering audio meanwhile.
 */
import { connect as netConnect, type Socket } from "node:net";
import { LineDecoder, encodeMessage, parseDaemonEvent, type ClientMessage, type DaemonEvent } from "./protocol.ts";

export interface DaemonClientOptions {
	readonly socketPath: string;
	/** Starts a daemon in the background. Called at most once per connect(). */
	readonly spawnDaemon: () => void;
	readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const RETRY_START_MS = 50;
const RETRY_MAX_MS = 500;
const RETRYABLE = new Set(["ENOENT", "ECONNREFUSED", "EAGAIN"]);

function attempt(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = netConnect(path);
		socket.once("connect", () => {
			socket.removeListener("error", reject);
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

export class DaemonClient {
	onEvent: (event: DaemonEvent) => void = () => {};
	onClose: () => void = () => {};
	private socket?: Socket;
	private connecting?: Promise<void>;
	private readonly options: DaemonClientOptions;

	constructor(options: DaemonClientOptions) {
		this.options = options;
	}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	/** Concurrent callers share one attempt, so a second dictation cannot open a second socket. */
	connect(): Promise<void> {
		if (this.connected) return Promise.resolve();
		this.connecting ??= this.dial().finally(() => (this.connecting = undefined));
		return this.connecting;
	}

	private async dial(): Promise<void> {
		const deadline = Date.now() + (this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		let spawned = false;
		let delay = RETRY_START_MS;
		for (;;) {
			try {
				this.adopt(await attempt(this.options.socketPath));
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				if (!RETRYABLE.has(code)) throw error;
				if (Date.now() >= deadline) throw new Error(`voice daemon did not start (${code})`);
				if (!spawned) {
					spawned = true;
					this.options.spawnDaemon();
				}
				await new Promise((done) => setTimeout(done, delay));
				delay = Math.min(RETRY_MAX_MS, delay * 2);
			}
		}
	}

	send(message: ClientMessage): void {
		if (this.connected) this.socket!.write(encodeMessage(message));
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
	}

	private adopt(socket: Socket): void {
		const decoder = new LineDecoder();
		this.socket = socket;
		socket.on("data", (data: Buffer) => {
			for (const value of decoder.push(data)) {
				const event = parseDaemonEvent(value);
				if (event) this.onEvent(event);
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			if (this.socket === socket) this.socket = undefined;
			this.onClose();
		});
		this.send({ t: "hello" });
	}
}
