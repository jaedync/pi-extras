/**
 * Ties the voice key, microphone, daemon and indicator together for one Pi
 * session. Everything external is injected so the flow is testable without a
 * terminal, microphone or daemon.
 */
import { isKeyRelease, isKeyRepeat, matchesKey, parseKey, type KeyId } from "@earendil-works/pi-tui";
import type { Capture, CaptureCallbacks } from "./capture.ts";
import type { IndicatorState } from "./indicator.ts";
import { leadFor, splitForPaste } from "./insert.ts";
import { initialKeyState, reduceKey, type KeyState } from "./keys.ts";
import type { ClientMessage, DaemonEvent } from "./protocol.ts";
import { DictationSession } from "./session.ts";
import { TranscriptStream, type StreamOptions } from "./stream.ts";

export interface DaemonLink {
	onEvent: (event: DaemonEvent) => void;
	onClose: () => void;
	connect(): Promise<void>;
	send(message: ClientMessage): void;
}

export interface VoiceUi {
	/** Render the indicator, or hide it with undefined. */
	show(view: IndicatorState | undefined): void;
	paste(text: string): void;
	getEditorText(): string;
}

export interface ControllerOptions {
	readonly key: string;
	readonly now: () => number;
	readonly ui: VoiceUi;
	readonly link: DaemonLink;
	readonly startCapture: (callbacks: CaptureCallbacks) => Capture;
	/** How long the final state stays visible. */
	readonly lingerMs?: number;
	/** How long a recorder may take to deliver its first frame. */
	readonly noAudioTimeoutMs?: number;
	/** Timer for the insert stream; injectable so tests control time. */
	readonly schedule?: StreamOptions["schedule"];
}

type InputResult = { consume: true } | undefined;

const defaultSchedule: StreamOptions["schedule"] = (fn, ms) => {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
};
const CONSUME: InputResult = { consume: true };
// A real microphone is never bit-exact silent; all-zero frames mean the OS is withholding audio.
const SILENT_FRAMES_BEFORE_WARNING = 15;
const DEFAULT_LINGER_MS = 1500;
const ERROR_LINGER_MS = 4000;
// Recorders start in well under a second; longer usually means a permission prompt nobody can see.
const DEFAULT_NO_AUDIO_MS = 3000;
const NO_AUDIO = "the microphone is not delivering audio: check the input device";
const MIC_BLOCKED =
	process.platform === "darwin"
		? "microphone is silent: allow your terminal in System Settings › Privacy & Security › Microphone"
		: "microphone is silent: check the input device";
const BUFFER_FULL = "recording stopped at 5 minutes; it is transcribed once setup finishes";
const KEPT = ", kept what was transcribed";

export class VoiceController {
	private readonly options: ControllerOptions;
	private keyState: KeyState = initialKeyState;
	private recording?: DictationSession;
	private readonly finishing = new Set<DictationSession>();
	private readonly streams = new Map<DictationSession, TranscriptStream>();
	private displayed?: DictationSession;
	private capture?: Capture;
	private heardSignal = false;
	private silentFrames = 0;
	private stallTimer?: ReturnType<typeof setTimeout>;
	private nextId = 1;
	private hideTimer?: ReturnType<typeof setTimeout>;
	private setupMessage?: string;

	constructor(options: ControllerOptions) {
		this.options = options;
		options.link.onEvent = (event) => {
			for (const session of this.sessions()) session.handleEvent(event);
		};
		options.link.onClose = () => this.onDaemonClosed();
	}

	get isRecording(): boolean {
		return this.recording !== undefined;
	}

	get active(): boolean {
		return this.recording !== undefined || this.finishing.size > 0 || this.streams.size > 0;
	}

	/** Shown in place of "starting voice" while models are still downloading. */
	setSetupMessage(message: string | undefined): void {
		this.setupMessage = message;
		if (this.displayed?.view.phase === "connecting") this.render(this.displayed);
	}

	handleInput(data: string): InputResult {
		const key = this.options.key as KeyId;
		if (matchesKey(data, key) || parseKey(data) === key) {
			const kind = isKeyRelease(data) ? "release" : isKeyRepeat(data) ? "repeat" : "press";
			const { state, action } = reduceKey(this.keyState, kind, this.options.now());
			this.keyState = state;
			if (action === "start") this.start();
			else if (action === "stop") this.stop();
			return CONSUME;
		}
		if (this.active && matchesKey(data, "escape")) {
			this.cancel();
			return CONSUME;
		}
		return undefined;
	}

	toggle(): void {
		if (this.recording) {
			this.keyState = initialKeyState;
			this.stop();
			return;
		}
		// Behave like a tap, so the voice key can also end a /voice-started recording.
		this.keyState = { recording: true, mode: "toggle", pressedAt: this.options.now(), lastPressAt: -Infinity };
		this.start();
	}

	cancel(): void {
		this.stopCapture();
		for (const session of this.sessions()) session.cancel();
		for (const stream of this.streams.values()) stream.cancel();
		this.streams.clear();
		this.recording = undefined;
		this.finishing.clear();
		this.keyState = initialKeyState;
	}

	onDaemonClosed(): void {
		for (const session of this.sessions()) session.fail("voice daemon disconnected");
		// Release the mic and hand what was already transcribed to the insert path.
		if (this.recording) this.stopByItself();
	}

	dispose(): void {
		this.cancel();
		clearTimeout(this.hideTimer);
		this.options.ui.show(undefined);
	}

	private sessions(): DictationSession[] {
		return [...(this.recording ? [this.recording] : []), ...this.finishing];
	}

	private start(): void {
		clearTimeout(this.hideTimer);
		const session: DictationSession = new DictationSession({
			id: this.nextId++,
			now: this.options.now,
			onChange: () => {
				this.streams.get(session)?.offer(session.readyText());
				this.render(session);
			},
		});
		this.recording = session;
		this.displayed = session;
		this.heardSignal = false;
		this.silentFrames = 0;
		this.render(session);
		try {
			this.capture = this.options.startCapture({
				onFrame: (frame) => this.onFrame(session, frame),
				onError: (error) => this.abort(session, error.message),
			});
		} catch (error) {
			this.abort(session, (error as Error).message);
			return;
		}
		if (this.capture?.device) session.setDevice(this.capture.device);
		const hint = this.capture?.blockedHint ?? NO_AUDIO;
		this.stallTimer = setTimeout(() => {
			if (session === this.recording) this.abort(session, hint);
		}, this.options.noAudioTimeoutMs ?? DEFAULT_NO_AUDIO_MS);
		this.stallTimer.unref?.();
		this.options.link.connect().then(
			() => session.attach(this.options.link),
			(error: Error) => session.fail(error.message),
		);
	}

	private onFrame(session: DictationSession, frame: Int16Array): void {
		if (session !== this.recording) return;
		clearTimeout(this.stallTimer);
		if (!this.heardSignal) {
			this.heardSignal = frame.some((sample) => sample !== 0);
			if (!this.heardSignal && ++this.silentFrames >= SILENT_FRAMES_BEFORE_WARNING) {
				this.abort(session, this.silentHint());
				return;
			}
		}
		session.pushFrame(frame);
		if (session.bufferFull) {
			this.stopByItself();
			session.note(BUFFER_FULL);
		}
	}

	/** All-zero audio is either a withheld permission or a virtual mic with no source behind it. */
	private silentHint(): string {
		const hint = this.capture?.blockedHint ?? MIC_BLOCKED;
		const device = this.capture?.device;
		return device ? `no sound from ${device}: pick another with /voice mic, or ${hint}` : hint;
	}

	private stopByItself(): void {
		this.keyState = initialKeyState;
		this.stop();
	}

	private abort(session: DictationSession, message: string): void {
		if (session === this.recording) {
			this.stopCapture();
			this.recording = undefined;
			this.keyState = initialKeyState;
		}
		session.fail(message);
	}

	private stop(): void {
		const session = this.recording;
		if (!session) return;
		this.stopCapture();
		this.recording = undefined;
		this.finishing.add(session);
		const final = session.stop();
		const stream = this.startStream(session);
		final.then(
			(text) => stream.finish(text),
			(error: Error) => this.salvage(session, stream, error),
		).finally(() => this.finishing.delete(session));
	}

	/** A crash or timeout after minutes of dictation should not cost the chunks already transcribed. */
	private salvage(session: DictationSession, stream: TranscriptStream, error: Error): void {
		if (!this.streams.has(session)) return; // cancelled: the user asked to discard it
		const partial = session.readyText();
		if (!partial) {
			stream.cancel();
			this.streams.delete(session);
			return;
		}
		session.note(`${error.message}${KEPT}`);
		stream.finish(partial);
	}

	/** Chunks already transcribed start typing in now, while the last one decodes. */
	private startStream(session: DictationSession): TranscriptStream {
		const stream: TranscriptStream = new TranscriptStream(
			{
				now: this.options.now,
				schedule: this.options.schedule ?? defaultSchedule,
				emit: (text) => {
					for (const piece of splitForPaste(text)) this.options.ui.paste(piece);
				},
				onDone: () => this.streamDone(session, stream),
			},
			leadFor(this.options.ui.getEditorText()),
			session.readyText(),
			session.estimateWaitMs(),
		);
		this.streams.set(session, stream);
		return stream;
	}

	private streamDone(session: DictationSession, stream: TranscriptStream): void {
		this.streams.delete(session);
		if (session.view.phase === "error") {
			this.render(session);
			return;
		}
		if (!stream.inserted) {
			session.view = { ...session.view, phase: "cancelled", message: "no speech heard" };
			this.render(session);
			return;
		}
		if (this.displayed !== session) return;
		clearTimeout(this.hideTimer);
		this.displayed = undefined;
		this.options.ui.show(undefined);
	}

	private stopCapture(): void {
		clearTimeout(this.stallTimer);
		this.capture?.stop();
		this.capture = undefined;
	}

	private render(session: DictationSession): void {
		if (session !== this.displayed) return;
		const view = session.view;
		const message = view.phase === "connecting" ? (this.setupMessage ?? view.message) : view.message;
		this.options.ui.show(message === view.message ? view : { ...view, message });
		// Inserted text is its own confirmation; the row hides when the stream ends.
		if (!session.active && view.phase !== "inserted") {
			this.scheduleHide(session, view.phase === "error" ? ERROR_LINGER_MS : (this.options.lingerMs ?? DEFAULT_LINGER_MS));
		}
	}

	private scheduleHide(session: DictationSession, delay: number): void {
		clearTimeout(this.hideTimer);
		this.hideTimer = setTimeout(() => {
			if (this.displayed !== session) return;
			this.displayed = undefined;
			this.options.ui.show(undefined);
		}, delay);
		this.hideTimer.unref?.();
	}
}
