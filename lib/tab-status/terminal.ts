export type TerminalFamily = "iterm2" | "wezterm" | "ghostty" | "windows-terminal";

export function terminalFamily(env: NodeJS.ProcessEnv): TerminalFamily | undefined {
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	const multiplexed = !program || program === "tmux" || program === "screen";
	const name = multiplexed ? (env.LC_TERMINAL ?? "").toLowerCase() : program;
	if (name === "iterm.app" || name === "iterm2") return "iterm2";
	if (name === "wezterm" || (!name && !!env.WEZTERM_PANE)) return "wezterm";
	if (name === "ghostty" || (!name && !!env.GHOSTTY_RESOURCES_DIR)) return "ghostty";
	if (env.WT_SESSION && (!name || ["windows_terminal", "windowsterminal"].includes(name))) return "windows-terminal";
	return undefined;
}

function terminalVersion(env: NodeJS.ProcessEnv): string | undefined {
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	return !program || program === "tmux" || program === "screen"
		? env.LC_TERMINAL_VERSION
		: env.TERM_PROGRAM_VERSION;
}

function atLeast(version: string | undefined, minimum: readonly number[]): boolean {
	const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(version ?? "");
	if (!match) return false;
	const parts = match.slice(1).map((value) => Number(value ?? 0));
	for (const [index, wanted] of minimum.entries()) {
		if (parts[index] !== wanted) return parts[index]! > wanted;
	}
	return true;
}

export function terminalSupport(env: NodeJS.ProcessEnv): { sessionStatus: boolean; progress: boolean } {
	const family = terminalFamily(env), version = terminalVersion(env);
	// Some older OSC 9 implementations post notifications, so unknown versions normally stay off.
	// iTerm2: https://iterm2.com/downloads/stable/iTerm2-3_6_6.changelog (progress)
	// and https://iterm2.com/downloads/stable/iTerm2-3_7_0.changelog (Session Status).
	// 3.6.7 advertises P; 3.6.6's normal feature list suppresses auto progress.
	// https://iterm2.com/downloads/stable/iTerm2-3_6_7.changelog
	const sessionStatus = family === "iterm2" && atLeast(version, [3, 7, 0]);
	if (!family) return { sessionStatus: false, progress: false };
	// Windows Terminal does not report a version, and pre-1.6 silently ignores OSC 9.
	// https://github.com/microsoft/terminal/blob/v1.5.10411.0/src/terminal/parser/OutputStateMachineEngine.cpp
	if (family === "windows-terminal") return { sessionStatus: false, progress: true };
	// WezTerm has no supporting stable release. First implementation: 44866cc1,
	// whose own git-derived version is 20250209-182623-44866cc1 (commit date -0700).
	// https://github.com/wezterm/wezterm/commit/44866cc137e336d8c00b23f5e0d7d1f03983b591
	// https://wezterm.org/config/lua/pane/get_progress.html (nightly only; no state 4).
	const wezterm = /^(\d{8}-\d{6})-[a-f\d]+$/i.exec(version ?? "");
	const progress = family === "iterm2" ? atLeast(version, [3, 6, 6])
		: family === "wezterm" ? !!wezterm && wezterm[1]! >= "20250209-182623"
		// https://ghostty.org/docs/install/release-notes/1-2-0 (OSC 9;4 added).
		: atLeast(version, [1, 2, 0]);
	// P is a complete boolean feature token, not a substring of another token.
	// https://iterm2.com/feature-reporting/ (PROGRESS P; absence means not advertised).
	// Known old versions win over contradictory features inherited from a parent shell.
	const knownVersion = family === "wezterm" ? !!wezterm : /^\d+\.\d+(?:\.\d+)?(?:\.\d+)?$/.test(version ?? "");
	// The spec reserves everything after the first non-alphanumeric character.
	const prefix = env.TERM_FEATURES?.match(/^[A-Za-z0-9]*/)?.[0] ?? "";
	const features = prefix.match(/[A-Z][a-z]*(?:\d+)?/g) ?? [];
	const advertised = features.join("") === prefix && features.some((feature) => feature === "P");
	return { sessionStatus, progress: env.TERM_FEATURES === undefined ? progress : advertised && (!knownVersion || progress) };
}
