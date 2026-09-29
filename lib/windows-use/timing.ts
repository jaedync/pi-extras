/** How long a guest's recovery waits for each thing, and how often it looks. */

export interface Timing {
	/** How long an unlocked verdict holds before the next tool call checks again. */
	readonly lockTtlMs: number;
	/** Wait for the server after signing in: the logon task has to start it. */
	readonly logonWaitMs: number;
	/** Wait for a server that may just be starting on an unlocked desktop. */
	readonly restartWaitMs: number;
	/** Wait for a first install: uv, Python and Windows-MCP download. */
	readonly installWaitMs: number;
	/** Wait for the typed bootstrap to report that it started; past it, typing went astray. */
	readonly bootstrapStartMs: number;
	/** Wait for an administrator's PowerShell to show after UAC, reading the console every `pollMs`. */
	readonly adminShellMs: number;
	/**
	 * Wait after its title shows for PowerShell to take input: keys typed before
	 * its prompt are lost. A read prompt ends the wait sooner.
	 */
	readonly shellReadyMs: number;
	/** Pause after clicking Sign in before looking at the screen again. */
	readonly signInSettleMs: number;
	/** Pause after pressing the Windows key for Start and the taskbar to appear. */
	readonly startMenuMs: number;
	/** Wait for Windows to finish starting: a restart that installs updates takes minutes. */
	readonly bootWaitMs: number;
	/** Windows started this recently: its logon task may still be starting the server. */
	readonly recentBootMs: number;
	/** Wait for Hyper-V to leave a state between two others (shutting down, starting). */
	readonly transitionWaitMs: number;
	readonly pollMs: number;
}

export const TIMING: Timing = {
	lockTtlMs: 30_000,
	logonWaitMs: 90_000,
	restartWaitMs: 15_000,
	installWaitMs: 15 * 60_000,
	bootstrapStartMs: 120_000,
	adminShellMs: 20_000,
	shellReadyMs: 9_000,
	signInSettleMs: 10_000,
	startMenuMs: 1_500,
	bootWaitMs: 15 * 60_000,
	recentBootMs: 5 * 60_000,
	transitionWaitMs: 3 * 60_000,
	pollMs: 3_000,
};
