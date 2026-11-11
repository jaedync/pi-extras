/**
 * Herdr Tab Name: keeps a Pi session's name and the label of its Herdr tab
 * the same, in both directions. This file is the decision and the loop that
 * applies it; extensions/herdr-tab-name.ts gives it Pi and the `herdr` CLI.
 *
 * The rules, in order:
 * - A tab with more than one pane is left alone: its label is not one
 *   session's to set.
 * - At the first look, a session that has a name puts it on the tab; a
 *   session with no name takes the tab's label, unless the label is one of
 *   Herdr's defaults (empty, or a number).
 * - Later, the side that changed since the two last agreed wins; when both
 *   changed, the session name wins.
 */

/** The longest label put on a tab, in characters: the tab bar is narrow. */
export const LABEL_MAX = 48;
/**
 * Looks in a row before the loop stops until the next request. The rules
 * settle in two (a name taken from the tab, then the check that follows
 * Pi's report of it); the limit is for a Pi or Herdr that does not keep the
 * value it was given, where each look would cause the next one.
 */
export const MAX_LOOKS = 4;

const OFF = new Set(["0", "off", "false", "none"]);
const ON = new Set(["1", "on", "true"]);

/**
 * Whether the sync runs in this process. It needs Herdr's environment.
 * Inside tmux or screen the pane that Herdr knows belongs to the outer
 * program, so a Pi started there would rename a tab that is not its own.
 * `PI_HERDR_TAB_NAME=on` overrides that guard and the settings file.
 */
export function applies(env: NodeJS.ProcessEnv, settings: Record<string, unknown>): boolean {
	const choice = env.PI_HERDR_TAB_NAME?.trim().toLowerCase() ?? "";
	if (OFF.has(choice)) return false;
	if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH) return false;
	if (ON.has(choice)) return true;
	return settings.enabled !== false && !env.TMUX && !env.STY;
}

export interface Tab {
	readonly tabId: string;
	readonly label: string;
	readonly number: number | undefined;
	readonly paneCount: number;
}

/** How this session is known to Herdr: the session that its pane reports, and the pane id it started in. */
export interface Self {
	readonly sessionFile?: string;
	readonly sessionId?: string;
	readonly paneId?: string;
}

/** A session name as a tab label: one line, no control characters, at most LABEL_MAX characters. */
export function labelFor(name: string): string {
	const line = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
	const points = [...line];
	return points.length <= LABEL_MAX ? line : `${points.slice(0, LABEL_MAX - 1).join("").trimEnd()}…`;
}

/** False for the labels Herdr gives a tab itself: none, or a number. */
export function isCustomLabel(tab: Tab): boolean {
	const label = tab.label.trim();
	return label !== "" && !/^\d+$/.test(label);
}

type Json = Record<string, unknown>;

const object = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined);
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.flatMap((item: unknown): Json[] => { const found = object(item); return found ? [found] : []; }) : []);

/**
 * This session's tab in a `herdr api snapshot`. The pane that reports this
 * session (Herdr's Pi integration sends the session file) decides, because
 * the pane id from the environment goes stale when the pane moves. The pane
 * id counts only for a pane that reports no session at all.
 */
export function locateTab(snapshot: unknown, self: Self): Tab | undefined {
	const envelope = object(snapshot);
	const result = object(envelope?.result) ?? envelope;
	const body = object(result?.snapshot) ?? result;
	const panes = objects(body?.panes);
	const reported = (pane: Json): unknown => object(pane.agent_session)?.value;
	const mine = [self.sessionFile, self.sessionId].filter((value): value is string => !!value);
	const pane = panes.find((candidate) => mine.includes(reported(candidate) as string))
		?? panes.find((candidate) => !!self.paneId && candidate.pane_id === self.paneId && reported(candidate) === undefined);
	const tab = pane && objects(body?.tabs).find((candidate) => candidate.tab_id === pane.tab_id);
	if (!tab || typeof tab.tab_id !== "string" || typeof tab.label !== "string" || typeof tab.pane_count !== "number") return undefined;
	return { tabId: tab.tab_id, label: tab.label, number: typeof tab.number === "number" ? tab.number : undefined, paneCount: tab.pane_count };
}

/** The session name and tab label when the two last agreed, or after this sync last wrote one of them. */
export interface Agreed {
	readonly name: string;
	readonly label: string;
}

export type Action =
	| { readonly kind: "none" }
	| { readonly kind: "rename-tab"; readonly tabId: string; readonly label: string }
	| { readonly kind: "name-session"; readonly name: string };

const NONE: Action = { kind: "none" };

/** What one look does. `name` is the session's name, empty when it has none. */
export function decide(agreed: Agreed | undefined, name: string, tab: Tab): Action {
	if (tab.paneCount !== 1) return NONE;
	const want = labelFor(name);
	if (want !== "" && tab.label === want) return NONE;
	const toTab: Action = want === "" ? NONE : { kind: "rename-tab", tabId: tab.tabId, label: want };
	const toName: Action = isCustomLabel(tab) ? { kind: "name-session", name: tab.label.trim() } : NONE;
	if (!agreed) return want === "" ? toName : toTab;
	if (want !== "" && name !== agreed.name) return toTab;
	if (tab.label !== agreed.label && toName.kind !== "none") return toName;
	return toTab;
}

export interface SyncDeps {
	self(): Self;
	/** The session's name now. */
	name(): string | undefined;
	setName(name: string): void;
	/** The parsed output of `herdr api snapshot`. */
	snapshot(): Promise<unknown>;
	renameTab(tabId: string, label: string): Promise<void>;
	onError(error: unknown): void;
}

export interface TabNameSync {
	/** Look once, soon. Requests made while a look runs give one more look. */
	request(): void;
	/** Resolves when no look runs and none is due. */
	idle(): Promise<void>;
	stop(): void;
}

export function tabNameSync(deps: SyncDeps): TabNameSync {
	let agreed: Agreed | undefined;
	let wanted = false;
	let stopped = false;
	let running: Promise<void> | undefined;

	async function look(): Promise<void> {
		const tab = locateTab(await deps.snapshot(), deps.self());
		// Read after the snapshot: a rename that arrived while Herdr answered counts in this look.
		const name = deps.name()?.trim() ?? "";
		if (stopped || !tab) return;
		const action = decide(agreed, name, tab);
		if (action.kind === "rename-tab") {
			await deps.renameTab(action.tabId, action.label);
			agreed = { name, label: action.label };
		} else if (action.kind === "name-session") {
			// Before the call: Pi reports the new name at once, and that report asks for the next look.
			agreed = { name: action.name, label: tab.label };
			deps.setName(action.name);
		} else if (name !== "" && tab.label === labelFor(name)) {
			agreed = { name, label: tab.label };
		}
	}

	async function run(): Promise<void> {
		for (let looks = 0; wanted && !stopped; looks++) {
			wanted = false;
			if (looks === MAX_LOOKS) {
				deps.onError(new Error(`stopped after ${MAX_LOOKS} looks in a row: each one caused the next`));
				break;
			}
			try {
				await look();
			} catch (error) {
				// Fail-open: the names stay as they are, and the next request tries again.
				deps.onError(error);
			}
		}
		running = undefined;
	}

	return {
		request() {
			if (stopped) return;
			wanted = true;
			running ??= run();
		},
		async idle() {
			while (running) await running;
		},
		stop() {
			stopped = true;
		},
	};
}
