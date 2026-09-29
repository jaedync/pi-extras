/**
 * What windows_use knows about Windows-MCP calls that never answer. A
 * snapshot walks the UI Automation tree of the window in front, and an app
 * that stops answering UI Automation stalls it for good: most often Start and
 * its search, which Windows restarts on demand. Each stalled call holds one of
 * the server's few worker threads, so enough of them leave a server that
 * answers nothing; it is restarted from the console's Run box, which needs no
 * Windows-MCP.
 */

/** Longest a single Windows-MCP call may take; PowerShell calls can set their own timeout below it. */
const TOOL_TIMEOUT_MS = 10 * 60_000;
/** Most tools answer in a second or two; App launches take up to a dozen. */
export const DEFAULT_TOOL_MS = 120_000;
/**
 * Snapshots took 0.4 to 8.5 s across live agent runs, the slowest the first
 * after a pause. One that runs past this is stuck on a window whose UI
 * Automation stopped answering, and each second past it is the agent's.
 */
const CAPTURE_MS = 30_000;
/** On top of a tool's own timeout, for the round trip and PowerShell's start. */
const TOOL_SLACK_MS = 60_000;
/** The lock check and other short PowerShell the guest runs for itself take a second or two. */
export const QUICK_MS = 30_000;
/** After the restart is typed: the old server answers until it's stopped, a few seconds in. */
export const RESTART_SETTLE_MS = 6_000;
export const CAPTURES = new Set(["Snapshot", "Screenshot"]);

/** How long to wait for a Windows-MCP tool before giving up on it. */
export function toolLimit(name: string, args: Record<string, unknown>): number {
	if (CAPTURES.has(name)) return CAPTURE_MS;
	const own = name === "PowerShell" ? 30 : name === "WaitFor" ? 10 : undefined;
	if (own === undefined) return DEFAULT_TOOL_MS;
	const seconds = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : own;
	return Math.min(seconds * 1000 + TOOL_SLACK_MS, TOOL_TIMEOUT_MS);
}

/** The logon task that runs the server; guest-bootstrap.ps1 registers it. */
export const SERVER_TASK = "windows-mcp-server";

/**
 * Typed into the Run box, as the signed-in user: stops the server and its
 * Python, waits for the task to end (it ignores a start while running), and
 * starts it again.
 */
export const RESTART_SERVER = `cmd /c "taskkill /f /t /im windows-mcp.exe & timeout /t 3 /nobreak & schtasks /run /tn ${SERVER_TASK}"`;

/** The Run box's own words, read from the console before anything is typed into it. */
export const RUN_BOX = /Type the name of a program|Windows will open it for you/i;

/**
 * The window in front, from its handle rather than UI Automation, which would
 * stall on it too. Responding asks the window with a five-second timeout.
 */
export const FRONT_WINDOW = [
	"Add-Type -Name Front -Namespace PiWindowsUse -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid); [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);'",
	"$h = [PiWindowsUse.Front]::GetForegroundWindow(); $id = 0; [void][PiWindowsUse.Front]::GetWindowThreadProcessId($h, [ref]$id)",
	"$t = New-Object System.Text.StringBuilder 256; [void][PiWindowsUse.Front]::GetWindowText($h, $t, 256)",
	"$p = Get-Process -Id $id -ErrorAction SilentlyContinue",
	"if ($p) { [pscustomobject]@{ process = $p.ProcessName; title = $t.ToString(); responding = $p.Responding } | ConvertTo-Json -Compress }",
].join("; ");

/** Start and its search: Windows starts them again when next opened, so restarting them loses nothing. */
export const SHELL_UI = /^(?:SearchHost|StartMenuExperienceHost|SearchApp)$/i;
export const RESTART_SHELL_UI = "Stop-Process -Name SearchHost, StartMenuExperienceHost -Force -ErrorAction SilentlyContinue";

export interface FrontWindow {
	readonly process: string;
	readonly title: string;
	readonly responding?: boolean;
}

/** The front window from FRONT_WINDOW's output, or undefined when it names none. */
export function readFront(text: string): FrontWindow | undefined {
	const json = /\{[\s\S]*\}/.exec(text)?.[0];
	if (!json) return undefined;
	try {
		const value = JSON.parse(json) as Record<string, unknown>;
		if (typeof value.process !== "string" || !value.process) return undefined;
		return { process: value.process, title: typeof value.title === "string" ? value.title : "", ...(typeof value.responding === "boolean" ? { responding: value.responding } : {}) };
	} catch {
		return undefined;
	}
}

const describe = (front: FrontWindow) => `"${front.title || "(untitled)"}" (${front.process}${front.responding === false ? ", not responding" : ""})`;

/** A tool that didn't answer in time; it may still run in the guest, so it isn't sent again. */
export function hangMessage(vm: string, name: string, limitMs: number, restarted = false): string {
	const head = `Windows-MCP on ${vm} didn't answer ${name} within ${Math.round(limitMs / 1000)} s`;
	return restarted
		? `${head}, nor anything after it, so it was restarted; ${name} was not repeated, and may or may not have run.`
		: `${head}; it may still be running in the guest, so it was not repeated. The next call reconnects.`;
}

/**
 * A snapshot or screenshot that didn't answer, with the window that stalled it
 * when known, and what gets the agent going again.
 */
export function stallMessage(vm: string, name: string, limitMs: number, front: FrontWindow | undefined, restarted = false): string {
	const where = front ? `UI Automation stalls on the window in front, ${describe(front)}` : "a window whose UI Automation stopped answering stalls the UI tree";
	const server = restarted ? " Windows-MCP answered nothing after it, so it was restarted." : "";
	const vmJson = JSON.stringify(vm);
	return `Windows-MCP on ${vm} didn't answer ${name} within ${Math.round(limitMs / 1000)} s: ${where}.${server} Read the screen with win.console.ocr({ vm: ${vmJson} }) or win.snapshot({ vm: ${vmJson}, use_ui_tree: false }), and get that window out of the way with win.console.* input (win.console.key({ vm: ${vmJson}, keys: "esc" }), or a click elsewhere), or wait for its app, before the next full snapshot.`;
}
