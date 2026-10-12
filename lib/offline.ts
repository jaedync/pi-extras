/**
 * PI_OFFLINE as Pi reads it (pi-coding-agent isOfflineModeEnabled): only 1,
 * true or yes turn offline mode on, so PI_OFFLINE=0 or false stays online.
 */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PI_OFFLINE?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}
