import { lowerMedian } from "./stats.mjs";

/**
 * Longest-processing-time packing: sort files by recorded seconds (longest first, then by path), and put each on the
 * shard with the least total so far (the lowest index on a tie). Every shard computes the same plan from the same
 * inputs, so each one can pick its own files without a coordinator. A file with no recorded time gets the median.
 * @param {string[]} files
 * @param {Record<string, number>} timings
 * @param {number} count
 */
export function planShards(files, timings, count) {
	const known = files.map((file) => timings[file]).filter((value) => typeof value === "number");
	const fill = lowerMedian(known, 1);
	const cost = (file) => (typeof timings[file] === "number" ? timings[file] : fill);
	const order = [...new Set(files)].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
	const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, seconds: 0, files: /** @type {string[]} */ ([]) }));
	for (const file of order) {
		const target = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
		target.files.push(file);
		target.seconds += cost(file);
	}
	return shards.map((shard) => ({ ...shard, seconds: Math.round(shard.seconds * 1000) / 1000, files: [...shard.files].sort() }));
}
