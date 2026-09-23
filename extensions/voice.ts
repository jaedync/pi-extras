/**
 * Voice dictation. Hold ctrl+space and speak, or tap it to start and tap again
 * to stop; Esc cancels. The transcript is inserted into the editor, never sent.
 *
 * Speech is transcribed in chunks while you talk by one shared background
 * daemon per user. It loads on first use and exits 15 minutes after the last
 * dictation, or once no Pi session is open. Setup (a private uv, Python,
 * speech wheels and models) runs in the background on first start and picks
 * the best backend: MLX on Apple Silicon, otherwise ONNX on the CPU.
 *
 * The indicator is drawn into the editor's top border row while nothing else
 * uses it, and into the bottom border otherwise. `/voice` opens a menu showing the
 * current mic and model; `/voice mic`, `model`, `status`, `setup` and
 * `unload` jump straight to an entry. PI_VOICE=off disables the extension;
 * PI_VOICE_KEY changes the key.
 *
 * Over SSH on a Mac, recording runs as a launchd job in the desktop session,
 * because macOS gives SSH sessions a silent microphone. Allow ffmpeg once on
 * the Mac when prompted.
 */
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { availableParallelism, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type AutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { startCapture, hasAudioInput, type Capture, type CaptureCallbacks } from "../lib/voice/capture.ts";
import { captureRoute, startMacDesktopCapture } from "../lib/voice/desktop-capture.ts";
import { listMics, micChoices, micSummary, readMicSetting, resolveMic, writeMicSetting } from "../lib/voice/mics.ts";
import { alignRows, menuItems, modelChoices, modelSummary, SUBCOMMANDS, tierName, type MenuAction } from "../lib/voice/menu.ts";
import { DaemonClient } from "../lib/voice/client.ts";
import { VoiceController, type DaemonLink } from "../lib/voice/controller.ts";
import {
	blendAnsi,
	overlayVoiceRow,
	renderStatus,
	renderVoiceBorder,
	type IndicatorState,
	type Palette,
} from "../lib/voice/indicator.ts";
import { TopBorderLink, voiceRow } from "../lib/top-border.ts";
import { backendOptions, backendSummary, CUDA_NOTE, type HardwareFacts, type TierId } from "../lib/voice/plan.ts";
import {
	floorReady,
	pruneMissingTiers,
	provision,
	provisioningComplete,
	readTiers,
	voiceHome,
	writeTiers,
	type Progress,
	type Tiers,
} from "../lib/voice/provision.ts";

export const DEFAULT_KEY = "ctrl+space";
const DISABLED = new Set(["0", "off", "false", "none"]);
const STATUS_KEY = "voice";
const FRAME_MS = 100;
const BUSY_POLL_MS = 1000;
const MAX_LOG_BYTES = 1024 * 1024;
const DAEMON = fileURLToPath(new URL("../lib/voice/daemon/voice_daemon.py", import.meta.url));

export function voiceEnabled(env: NodeJS.ProcessEnv): boolean {
	return !DISABLED.has((env.PI_VOICE ?? "").trim().toLowerCase());
}

function hardwareFacts(): HardwareFacts {
	return { platform: process.platform, arch: process.arch, totalMemBytes: totalmem(), cpus: availableParallelism() };
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

interface ThemeLike {
	fg(color: string, text: string): string;
	getFgAnsi?(color: string): string;
}

function paletteOf(theme: ThemeLike): Palette {
	return {
		accent: (s) => theme.fg("accent", s),
		dim: (s) => theme.fg("dim", s),
		warn: (s) => theme.fg("warning", s),
		error: (s) => theme.fg("error", s),
		muted: (s) => theme.fg("muted", s),
		pulse: (s, amount) => {
			const color = theme.getFgAnsi && blendAnsi(theme.getFgAnsi("error"), theme.getFgAnsi("dim"), amount);
			return color ? `${color}${s}\x1b[39m` : theme.fg("error", s);
		},
	};
}

/** Backends this machine has and could have, one line each. */
function backendLines(tiers: Tiers, facts: HardwareFacts): string[] {
	const lines = backendSummary(facts, tiers);
	if (facts.platform === "linux") lines.push(`  ✗ CUDA (${CUDA_NOTE})`);
	return lines;
}

const SUBCOMMAND_NAMES = new Set<string>(SUBCOMMANDS.map((command) => command.value));

export function progressText(progress: Progress): string {
	return progress.fraction === undefined ? progress.label : `${progress.label} ${Math.round(progress.fraction * 100)}%`;
}

/** Owns background setup so dictation can start before it finishes. */
class Setup {
	private readonly home: string;
	private readonly onProgress: (label: string | undefined) => void;
	private readonly onFinish: (failure: string | undefined, refused: readonly string[]) => void;
	private running?: Promise<void>;
	private failure?: string;
	private requested: readonly TierId[] = [];
	/** Upgrades the last run did not attempt, e.g. for lack of disk space. */
	readonly skipped = new Map<TierId, string>();

	constructor(
		home: string,
		onProgress: (label: string | undefined) => void,
		onFinish: (failure: string | undefined, refused: readonly string[]) => void,
	) {
		this.home = home;
		this.onProgress = onProgress;
		this.onFinish = onFinish;
	}

	get busy(): boolean {
		return this.running !== undefined;
	}

	get error(): string | undefined {
		return this.failure;
	}

	start(extraTiers: readonly TierId[] = []): void {
		if (this.running) return;
		this.failure = undefined;
		this.requested = extraTiers;
		this.skipped.clear();
		this.running = this.run(extraTiers).finally(() => (this.running = undefined));
	}

	private async run(extraTiers: readonly TierId[]): Promise<void> {
		try {
			for (;;) {
				const result = await provision({
					home: this.home,
					facts: hardwareFacts(),
					env: process.env,
					homedir: homedir(),
					extraTiers,
					onProgress: (p) => this.onProgress(p && progressText(p)),
					onSkip: (tier, reason) => this.skipped.set(tier, reason),
				});
				if (result === "done") break;
				// Another Pi session is provisioning; wait for it rather than racing it.
				await sleep(BUSY_POLL_MS);
			}
			this.onProgress(undefined);
			// Only a tier the user just asked for is worth interrupting them about.
			this.onFinish(undefined, this.requested.flatMap((tier) => this.skipped.get(tier) ?? []));
		} catch (error) {
			this.failure = (error as Error).message;
			this.onProgress(undefined);
			this.onFinish(this.failure, []);
		}
	}

	/** Resolves with the interpreter to run, once dictation can work. */
	async ready(): Promise<string> {
		for (;;) {
			const tiers = readTiers(this.home);
			if (floorReady(tiers)) return tiers.python!;
			if (!this.running) throw new Error(this.failure ? `voice setup failed: ${this.failure}` : "voice is not set up yet (/voice setup)");
			await Promise.race([this.running, sleep(BUSY_POLL_MS)]);
		}
	}
}

/** What the editor's border row should draw right now. */
interface BorderContent {
	readonly state: IndicatorState;
	readonly setup?: string;
}

class VoiceRuntime {
	readonly controller: VoiceController;
	readonly client: DaemonClient;
	readonly setup: Setup;
	readonly home: string;
	private readonly ctx: ExtensionContext;
	private readonly useBorder: boolean;
	private readonly requestRender: () => void;
	private readonly onShown: (shown: boolean) => void;
	private readonly lease: string;
	private readonly unsubscribe: () => void;
	private pythonPath = "";
	private view?: IndicatorState;
	private setupLabel?: string;
	private loadedModel?: string;
	/** Saved mic already reported as unplugged, so the warning shows once. */
	private warnedMissingMic?: string;
	private shown = false;
	private timer?: ReturnType<typeof setInterval>;

	constructor(ctx: ExtensionContext, useBorder: boolean, requestRender: () => void, onShown: (shown: boolean) => void = () => {}) {
		this.ctx = ctx;
		this.useBorder = useBorder;
		this.requestRender = requestRender;
		this.onShown = onShown;
		this.home = voiceHome(process.env, homedir());
		mkdirSync(join(this.home, "sessions"), { recursive: true, mode: 0o700 });
		this.lease = join(this.home, "sessions", String(process.pid));
		writeFileSync(this.lease, "");
		this.setup = new Setup(
			this.home,
			(label) => {
				this.setupLabel = label;
				this.controller.setSetupMessage(label);
				this.refresh();
			},
			(failure, refused) => this.onSetupFinished(failure, refused),
		);
		this.client = new DaemonClient({ socketPath: join(this.home, "daemon.sock"), spawnDaemon: () => this.spawnDaemon() });
		const link: DaemonLink = {
			onEvent: () => {},
			onClose: () => {},
			connect: async () => {
				this.pythonPath = await this.setup.ready();
				await this.client.connect();
			},
			send: (message) => this.client.send(message),
		};
		this.client.onEvent = (event) => {
			if (event.t === "status" && event.state === "ready" && event.backend) {
				this.loadedModel = [event.backend, event.model].filter(Boolean).join(" ");
			}
			link.onEvent(event);
		};
		// A daemon that exits (unload, crash) must end the dictation now, not after the final timeout.
		this.client.onClose = () => link.onClose();
		this.controller = new VoiceController({
			key: (process.env.PI_VOICE_KEY || DEFAULT_KEY).trim().toLowerCase(),
			now: Date.now,
			link,
			startCapture: (callbacks) => this.startCapture(callbacks),
			ui: {
				show: (view) => {
					this.view = view;
					this.refresh();
				},
				paste: (text) => ctx.ui.pasteToEditor(text),
				getEditorText: () => ctx.ui.getEditorText(),
			},
		});
		this.unsubscribe = ctx.ui.onTerminalInput((data) => this.controller.handleInput(data));
		// Headless hosts never download models; offline sessions use whatever is already installed.
		if (!process.env.PI_OFFLINE && hasAudioInput(process.platform, process.env) && !provisioningComplete(readTiers(this.home), hardwareFacts())) {
			this.setup.start();
		}
	}

	private get desktopRoute(): boolean {
		return captureRoute(process.platform, process.env) === "desktop";
	}

	private startCapture(callbacks: CaptureCallbacks): Capture {
		const saved = readMicSetting(this.home);
		// Locally the recorder names its own device; over SSH the indicator needs the default's name up front.
		const mic = saved || this.desktopRoute ? resolveMic(saved, listMics(this.desktopRoute)) : {};
		if (mic.missing && mic.missing !== this.warnedMissingMic) {
			this.warnedMissingMic = mic.missing;
			this.ctx.ui.notify(`${mic.missing} is not connected, so voice is using the system default. /voice mic changes it.`, "warning");
		}
		return this.desktopRoute ? startMacDesktopCapture(callbacks, this.home, mic) : startCapture(callbacks, mic.device);
	}

	/** Read by the editor border on every render. */
	borderContent(): BorderContent | undefined {
		if (!this.view) return undefined;
		// While connecting, the indicator itself carries the setup label.
		const setup = this.view.phase === "connecting" ? undefined : this.setupLabel;
		return { state: this.view, setup };
	}

	private spawnDaemon(): void {
		const logPath = join(this.home, "daemon.log");
		if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) renameSync(logPath, `${logPath}.old`);
		const log = openSync(logPath, "a", 0o600);
		try {
			spawn(this.pythonPath, [DAEMON, "--home", this.home], {
				detached: true,
				stdio: ["ignore", log, log],
				// Models are provisioned ahead of time; the daemon must never fetch at load.
				env: { ...process.env, HF_HUB_OFFLINE: "1", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
			}).unref();
		} finally {
			closeSync(log);
		}
	}

	/** Keeps the blink animating; the editor border reads state on each render. */
	private refresh(): void {
		const visible = this.view !== undefined;
		if (visible !== this.shown) {
			this.shown = visible;
			// Announced before the repaint so the phase spinner steps aside in the same frame.
			this.onShown(visible);
			if (visible) {
				this.timer = setInterval(() => this.repaint(), FRAME_MS);
				this.timer.unref?.();
			} else {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		}
		this.repaint();
	}

	private repaint(): void {
		if (this.useBorder) {
			// Setup progress lives in the footer only while the border row is idle.
			const footer = this.view ? undefined : this.setupLabel && `voice: ${this.setupLabel}`;
			this.ctx.ui.setStatus(STATUS_KEY, footer);
			this.requestRender();
		} else {
			const setup = this.view?.phase === "connecting" ? undefined : this.setupLabel;
			this.ctx.ui.setStatus(STATUS_KEY, renderStatus(this.view, setup, Date.now(), paletteOf(this.ctx.ui.theme as unknown as ThemeLike)));
		}
	}

	private onSetupFinished(failure: string | undefined, refused: readonly string[]): void {
		if (failure) {
			this.ctx.ui.notify(`Voice setup failed: ${failure}`, "error");
			return;
		}
		if (refused.length > 0) {
			this.ctx.ui.notify(`Not enough disk space: ${refused.join("; ")}. Model: ${modelSummary(readTiers(this.home))}.`, "warning");
			return;
		}
		this.ctx.ui.notify(`Voice is ready. Model: ${modelSummary(readTiers(this.home))}.`, "info");
	}

	/** Plain /voice: every entry shows its current value. */
	async menu(ctx: ExtensionContext): Promise<void> {
		const items = menuItems({
			key: process.env.PI_VOICE_KEY || DEFAULT_KEY,
			mic: micSummary(readMicSetting(this.home), listMics()),
			model: modelSummary(pruneMissingTiers(readTiers(this.home))),
			running: this.client.connected,
		});
		const picked = await ctx.ui.select("Voice", items.map((item) => item.label));
		const item = items.find((candidate) => candidate.label === picked);
		if (item) await this.run(item.action, ctx);
	}

	async run(action: MenuAction, ctx: ExtensionContext): Promise<void> {
		switch (action) {
			case "dictate":
				this.controller.toggle();
				return;
			case "mic":
				return this.chooseMic(ctx);
			case "model":
				return this.chooseModel(ctx);
			case "status":
				return this.status(ctx);
			case "setup":
				return this.repair(ctx);
			case "unload":
				return this.unload(ctx);
		}
	}

	private async chooseMic(ctx: ExtensionContext): Promise<void> {
		const list = listMics();
		if (list.devices.length === 0) {
			ctx.ui.notify("Could not list microphones here, so voice records from the system default.", "warning");
			return;
		}
		const saved = readMicSetting(this.home);
		const choices = micChoices(saved, list);
		const picked = await ctx.ui.select("Microphone", choices.map((choice) => choice.label));
		const choice = choices.find((candidate) => candidate.label === picked);
		if (!choice || choice.value === saved) return;
		writeMicSetting(this.home, choice.value);
		this.warnedMissingMic = undefined;
		ctx.ui.notify(`Microphone: ${micSummary(choice.value, list)}. Takes effect on your next dictation.`, "info");
	}

	private async chooseModel(ctx: ExtensionContext): Promise<void> {
		const facts = hardwareFacts();
		const tiers = pruneMissingTiers(readTiers(this.home));
		const choices = modelChoices(facts, tiers);
		const picked = await ctx.ui.select("Speech model", choices.map((choice) => choice.label));
		const choice = choices.find((candidate) => candidate.label === picked);
		if (!choice || choice.value === (tiers.preferred ?? "auto")) return;
		const updated = { ...tiers, preferred: choice.value };
		writeTiers(this.home, updated);
		const option = backendOptions(facts, tiers).find((candidate) => candidate.tier === choice.value);
		if (option && !option.ready) {
			this.setup.start([option.tier]);
			ctx.ui.notify(
				`Downloading ${tierName(option.tier)} (${option.size}); progress is on the status line. Until it finishes: ${modelSummary(updated)}.`,
				"info",
			);
			return;
		}
		ctx.ui.notify(`Model: ${modelSummary(updated)}. Takes effect on your next dictation.`, "info");
	}

	/** Reports state and repairs anything that was deleted. */
	private async repair(ctx: ExtensionContext): Promise<void> {
		const tiers = pruneMissingTiers(readTiers(this.home));
		writeTiers(this.home, tiers);
		if (provisioningComplete(tiers, hardwareFacts())) {
			ctx.ui.notify(`Voice is installed and working. Model: ${modelSummary(tiers)}.`, "info");
			return;
		}
		this.setup.start();
		ctx.ui.notify("Installing what is missing in the background; progress is on the status line.", "info");
	}

	private unload(ctx: ExtensionContext): void {
		if (!this.client.connected) {
			ctx.ui.notify("The voice model is not loaded.", "info");
			return;
		}
		this.client.send({ t: "unload" });
		this.loadedModel = undefined;
		ctx.ui.notify("Voice model unloaded. The next dictation loads it again.", "info");
	}

	private status(ctx: ExtensionContext): void {
		const facts = hardwareFacts();
		const tiers = readTiers(this.home);
		const mic = micSummary(readMicSetting(this.home), listMics());
		const setup = this.setup.busy
			? `running${this.setupLabel ? `: ${this.setupLabel}` : ""}`
			: this.setup.error
				? `failed: ${this.setup.error} (/voice setup retries)`
				: provisioningComplete(tiers, facts)
					? "complete"
					: this.setup.skipped.size > 0
						? `skipped ${[...this.setup.skipped.values()].join("; ")}`
						: "incomplete (/voice setup installs the rest)";
		const rows: Array<[string, string]> = [
			["key", process.env.PI_VOICE_KEY || DEFAULT_KEY],
			["mic", this.desktopRoute ? `${mic}, recorded through the Mac's desktop session (SSH)` : mic],
			["model", modelSummary(tiers)],
			["daemon", this.client.connected ? `running, ${this.loadedModel ?? "no model"} loaded` : "not running (starts on the next dictation)"],
			["setup", setup],
			["home", this.home],
		];
		ctx.ui.notify([...alignRows(rows), "backends", ...backendLines(tiers, facts)].join("\n"), "info");
	}

	dispose(): void {
		this.controller.dispose();
		this.unsubscribe();
		this.client.close();
		clearInterval(this.timer);
		this.timer = undefined;
		rmSync(this.lease, { force: true });
		this.ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export default function voice(pi: ExtensionAPI): void {
	if (!voiceEnabled(process.env)) return;
	let runtime: VoiceRuntime | undefined;
	let activeTui: TUI | undefined;
	let topBorder: TopBorderLink | undefined;
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let installedEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	pi.on("session_start", (_event, ctx) => {
		runtime?.dispose();
		topBorder?.dispose();
		topBorder = undefined;
		if (!(ctx.hasUI && ctx.mode === "tui")) {
			runtime = undefined;
			return;
		}
		const canWrapEditor = typeof ctx.ui.setEditorComponent === "function" && typeof ctx.ui.getEditorComponent === "function";
		const link = canWrapEditor ? new TopBorderLink(pi.events, "voice", () => activeTui?.requestRender()) : undefined;
		topBorder = link;
		runtime = new VoiceRuntime(ctx, canWrapEditor, () => activeTui?.requestRender(), (shown) => link?.set(shown));
		if (!link) return;

		// Overlay the indicator on the editor's top border when nothing else is
		// using it, otherwise on the bottom border. Chained wrappers each replace
		// their own row; the phase spinner coordinates over pi.events.
		const currentFactory = ctx.ui.getEditorComponent();
		if (currentFactory !== installedEditorFactory) previousEditorFactory = currentFactory;
		const baseFactory = previousEditorFactory;
		const borderContent = () => runtime?.borderContent();

		class VoiceStatusEditor extends CustomEditor {
			private readonly base: EditorComponent;
			/** Pi's own status sits in the top border while set, unless a wrapper draws it. */
			private piWorking = false;
			wantsKeyRelease?: boolean;

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, base: EditorComponent) {
				super(tui, theme, keybindings, { embedWorkingStatus: true });
				this.base = base;
				this.wantsKeyRelease = base.wantsKeyRelease;
				if (base instanceof CustomEditor) this.actionHandlers = base.actionHandlers;
				activeTui = tui;
			}

			/** The working spinner must keep rendering wherever it rendered before. */
			setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
				this.piWorking = indicator !== undefined;
				super.setWorkingStatusIndicator(indicator);
				const forward = this.base as EditorComponent & { setWorkingStatusIndicator?: (indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]) => void };
				forward.setWorkingStatusIndicator?.(indicator);
			}

			private syncBase(): void {
				this.base.onSubmit = this.onSubmit;
				this.base.onChange = this.onChange;
				if (this.base.borderColor !== undefined) this.base.borderColor = this.borderColor;
				const focusable = this.base as EditorComponent & { focused?: boolean };
				if ("focused" in focusable) focusable.focused = this.focused;
				if (!(this.base instanceof CustomEditor)) return;
				this.base.actionHandlers = this.actionHandlers;
				this.base.onEscape = this.onEscape;
				this.base.onCtrlD = this.onCtrlD;
				this.base.onPasteImage = this.onPasteImage;
				this.base.onExtensionShortcut = this.onExtensionShortcut;
			}

			render(width: number): string[] {
				this.syncBase();
				const lines = this.base.render(width);
				const content = borderContent();
				if (!content || lines.length === 0) return lines;
				const row = voiceRow({ spinnerBusy: link.peerActive, piWorking: this.piWorking, topLine: lines[0], spinnerKnown: link.peerKnown });
				return overlayVoiceRow(lines, this.base, row, (overflow) => renderVoiceBorder(
					content.state,
					content.setup,
					Date.now(),
					width,
					paletteOf(ctx.ui.theme as unknown as ThemeLike),
					{
						border: (text) => this.borderColor(text),
						measure: visibleWidth,
						truncate: (text, maxWidth) => truncateToWidth(text, maxWidth, ""),
					},
					overflow,
				));
			}

			invalidate(): void {
				super.invalidate();
				this.base.invalidate();
			}

			handleInput(data: string): void {
				this.syncBase();
				this.base.handleInput(data);
			}

			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				this.syncBase();
				return this.base.handleMouse?.(event);
			}

			getText(): string {
				return this.base.getText();
			}

			getExpandedText(): string {
				return this.base.getExpandedText?.() ?? this.base.getText();
			}

			setText(text: string): void {
				this.syncBase();
				this.base.setText(text);
			}

			addToHistory(text: string): void {
				this.base.addToHistory?.(text);
			}

			insertTextAtCursor(text: string): void {
				this.base.insertTextAtCursor?.(text);
			}

			setAutocompleteProvider(provider: AutocompleteProvider): void {
				this.base.setAutocompleteProvider?.(provider);
			}

			setPaddingX(paddingX: number): void {
				super.setPaddingX(paddingX);
				this.base.setPaddingX?.(paddingX);
			}

			setAutocompleteMaxVisible(max: number): void {
				super.setAutocompleteMaxVisible(max);
				this.base.setAutocompleteMaxVisible?.(max);
			}
		}

		installedEditorFactory = (tui, theme, keybindings) => {
			const base = baseFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return new VoiceStatusEditor(tui, theme, keybindings, base);
		};
		ctx.ui.setEditorComponent(installedEditorFactory);
		link.hello();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		runtime?.dispose();
		runtime = undefined;
		topBorder?.dispose();
		topBorder = undefined;
		activeTui = undefined;
		if (ctx.ui.getEditorComponent?.() === installedEditorFactory) {
			ctx.ui.setEditorComponent(previousEditorFactory);
		}
		installedEditorFactory = undefined;
		previousEditorFactory = undefined;
	});

	pi.registerCommand("voice", {
		description: "Voice dictation: menu, or stop a recording. Also: mic, model, status, setup, unload",
		getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((command) => command.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("Voice needs the interactive terminal UI.", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action === "") {
				// While recording, /voice is the way to stop without the key.
				if (runtime.controller.isRecording) runtime.controller.toggle();
				else await runtime.menu(ctx);
				return;
			}
			if (!SUBCOMMAND_NAMES.has(action)) {
				ctx.ui.notify(`Unknown /voice option "${action}". Try: ${SUBCOMMANDS.map((command) => command.value).join(", ")}.`, "warning");
				return;
			}
			await runtime.run(action as MenuAction, ctx);
		},
	});
}
