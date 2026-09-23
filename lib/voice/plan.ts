/**
 * Which speech backends a machine can use, which are installed, and which one
 * to prefer. The small CPU model is always provisioned first: it is a 108 MB
 * download that works everywhere, so dictation is usable while larger backends
 * download in the background. MLX is opt-in: it runs the same v3 model as the
 * large CPU tier, only somewhat faster, for five times the download.
 */

export type TierId = "cpu-small" | "cpu-large" | "mlx";
/** "auto" follows TIER_ORDER; anything else pins one backend. */
export type Preference = TierId | "auto";

export interface TierState {
	readonly ready: boolean;
	readonly dir: string;
}

export interface TierMap {
	readonly "cpu-small"?: TierState;
	readonly "cpu-large"?: TierState;
	readonly mlx?: TierState;
	readonly preferred?: Preference;
}

export interface HardwareFacts {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly totalMemBytes: number;
	readonly cpus: number;
}

/** Best first. voice_daemon.py keeps its own copy; change both together. */
export const TIER_ORDER: readonly TierId[] = ["mlx", "cpu-large", "cpu-small"];

const LARGE_MODEL_MIN_BYTES = 8 * 1024 ** 3;
// Measured: 8 threads ran slower than 4 on M1 Pro (efficiency cores) and gained little on an i9.
const MAX_THREADS = 4;

/** Why there is no CUDA backend, stated where users look for it. */
export const CUDA_NOTE =
	"current builds need glibc 2.32+ (Ubuntu 20.04 ships 2.31), and the one that loads was slower than the CPU";

export function isAppleSilicon(facts: HardwareFacts): boolean {
	return facts.platform === "darwin" && facts.arch === "arm64";
}

export function plannedTiers(facts: HardwareFacts): TierId[] {
	return facts.totalMemBytes >= LARGE_MODEL_MIN_BYTES ? ["cpu-small", "cpu-large"] : ["cpu-small"];
}

/**
 * Tiers setup should install: the planned ones, the user's pinned pick (so an
 * interrupted opt-in resumes), and any extra requested now. CPU v3 is skipped
 * when MLX v3 is already installed, since it would add nothing.
 */
export function wantedTiers(facts: HardwareFacts, tiers: TierMap, extra: readonly TierId[] = []): TierId[] {
	const available = new Set(backendOptions(facts, {}).filter((option) => option.available).map((option) => option.tier));
	const planned = tiers.mlx?.ready ? plannedTiers(facts).filter((tier) => tier !== "cpu-large") : plannedTiers(facts);
	const pinned = tiers.preferred && tiers.preferred !== "auto" ? [tiers.preferred] : [];
	return [...new Set([...planned, ...pinned, ...extra])].filter((tier) => available.has(tier));
}

const TIER_NAMES: Record<TierId, string> = {
	mlx: "MLX Parakeet v3",
	"cpu-large": "CPU Parakeet v3",
	"cpu-small": "CPU Parakeet 110M",
};

export function tierName(tier: TierId): string {
	return TIER_NAMES[tier];
}

export function chooseThreads(cpus: number): number {
	return Math.max(1, Math.min(MAX_THREADS, Math.floor(cpus)));
}

export interface BackendOption {
	readonly tier: TierId;
	/** What it runs on and which model it loads. */
	readonly label: string;
	readonly size: string;
	/** The hardware can run it. */
	readonly available: boolean;
	/** The model files are on disk. */
	readonly ready: boolean;
	readonly note?: string;
}

export function backendOptions(facts: HardwareFacts, tiers: TierMap): BackendOption[] {
	const appleSilicon = isAppleSilicon(facts);
	const enoughRam = facts.totalMemBytes >= LARGE_MODEL_MIN_BYTES;
	return [
		{
			tier: "mlx",
			label: "MLX Parakeet v3 on the Apple GPU",
			size: "2.5 GB",
			available: appleSilicon,
			ready: Boolean(tiers.mlx?.ready),
			note: appleSilicon ? undefined : "needs an Apple Silicon Mac",
		},
		{
			tier: "cpu-large",
			label: "CPU Parakeet v3, 25 languages",
			size: "487 MB",
			available: enoughRam,
			ready: Boolean(tiers["cpu-large"]?.ready),
			note: enoughRam ? undefined : "needs 8 GB of RAM",
		},
		{
			tier: "cpu-small",
			label: "CPU Parakeet 110M, English only",
			size: "108 MB",
			available: true,
			ready: Boolean(tiers["cpu-small"]?.ready),
		},
	];
}

export function readyTierIds(tiers: TierMap): TierId[] {
	return TIER_ORDER.filter((tier) => tiers[tier]?.ready);
}

/** The tier the daemon should use: the preferred one when it is ready, else the best ready one. */
export function activeTier(preference: Preference | undefined, ready: readonly TierId[]): TierId | undefined {
	if (preference && preference !== "auto" && ready.includes(preference)) return preference;
	return TIER_ORDER.find((tier) => ready.includes(tier));
}

/** Multi-line report of every backend, for /voice status and post-setup notices. */
export function backendSummary(facts: HardwareFacts, tiers: TierMap): string[] {
	const active = activeTier(tiers.preferred, readyTierIds(tiers));
	return backendOptions(facts, tiers).map((option) => {
		const state = option.ready
			? option.tier === active
				? "selected"
				: "installed"
			: option.available
				? `download ${option.size}`
				: (option.note ?? "unavailable");
		return `  ${option.ready ? "✓" : option.available ? "·" : "✗"} ${option.label} (${state})`;
	});
}

/** One line for the model picker and status output. */
export function describeOption(option: BackendOption): string {
	if (!option.available) return `${option.label} (${option.note})`;
	return `${option.label} (${option.ready ? "installed" : `download ${option.size}`})`;
}
