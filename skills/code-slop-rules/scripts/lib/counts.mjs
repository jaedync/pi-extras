// Pure count logic of the ratchet: no files, no processes, so the tests can drive every order of events.

/** @typedef {{ count: number, files: Record<string, number> }} RuleCount */
/** @typedef {Record<string, RuleCount>} Counts */

/** @param {Record<string, number>} map */
const sortedKeys = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Counts findings per rule and per file. Every rule in `ruleIds` appears, also at zero, so that a rule with no
 * sites still gets a baseline of 0 and its first site fails the check.
 * @param {{ ruleId: string, file: string }[]} findings
 * @param {string[]} ruleIds
 * @returns {Counts}
 */
export function countFindings(findings, ruleIds) {
	/** @type {Record<string, Record<string, number>>} */
	const files = {};
	for (const id of ruleIds) files[id] = {};
	for (const { ruleId, file } of findings) {
		const perFile = (files[ruleId] ??= {});
		perFile[file] = (perFile[file] ?? 0) + 1;
	}
	return Object.fromEntries(Object.keys(files).sort().map((id) => {
		const perFile = sortedKeys(files[id]);
		return [id, { count: Object.values(perFile).reduce((sum, n) => sum + n, 0), files: perFile }];
	}));
}

/**
 * Rules whose text differs from the text the baseline recorded. A rule set change can hide sites (a narrower
 * `files`, a removed glob in sgconfig.yml), so it needs the same explicit acceptance as a higher count.
 * @param {Record<string, string>} recorded
 * @param {Record<string, string>} now
 */
export function changedRules(recorded, now) {
	return [...new Set([...Object.keys(recorded), ...Object.keys(now)])]
		.filter((key) => key in recorded && key in now && recorded[key] !== now[key]).sort();
}

/**
 * @param {Counts} baseline
 * @param {Counts} current
 * @param {string[]} [changed] from changedRules
 */
export function compareCounts(baseline, current, changed = []) {
	/** @type {{ rule: string, before: number, now: number, files: { file: string, before: number, now: number }[] }[]} */
	const rose = [];
	/** @type {{ rule: string, before: number, now: number }[]} */
	const fell = [];
	/** @type {string[]} */
	const unrecorded = [];
	for (const [rule, now] of Object.entries(current)) {
		const before = baseline[rule];
		if (!before) { unrecorded.push(rule); continue; }
		if (now.count > before.count) {
			const files = Object.entries(now.files)
				.filter(([file, n]) => n > (before.files[file] ?? 0))
				.map(([file, n]) => ({ file, before: before.files[file] ?? 0, now: n }));
			rose.push({ rule, before: before.count, now: now.count, files });
		} else if (now.count < before.count) fell.push({ rule, before: before.count, now: now.count });
	}
	// A rule that is gone (deleted, renamed, severity off) no longer guards its sites: that is a failure, not a note.
	const removed = Object.keys(baseline).filter((rule) => !(rule in current));
	return { ok: !rose.length && !unrecorded.length && !removed.length && !changed.length, rose, fell, unrecorded, removed, changed };
}

/**
 * The baseline that `--update` writes. A higher count, a removed rule and a changed rule are refused unless the
 * increase is allowed, so an update cannot quietly accept new sites or a weaker rule set; the person who allows it
 * says so in the command and the diff shows it.
 * @param {Counts} baseline
 * @param {Counts} current
 * @param {{ allowIncrease: boolean, changed?: string[] }} options
 */
export function nextBaseline(baseline, current, { allowIncrease, changed = [] }) {
	const rose = Object.entries(current)
		.filter(([rule, now]) => baseline[rule] && now.count > baseline[rule].count)
		.map(([rule]) => rule);
	const removed = Object.keys(baseline).filter((rule) => !(rule in current));
	const refused = [...new Set([...rose, ...removed, ...changed])].sort();
	if (refused.length && !allowIncrease) return { ok: false, baseline, refused, rose, removedOrChanged: [...removed, ...changed].sort() };
	return { ok: true, baseline: current, refused: [], rose: [], removedOrChanged: [] };
}

/**
 * Files with the most sites over all rules: the follow-up list for a cleanup.
 * @param {Counts} counts
 * @param {number} limit
 */
export function worstFiles(counts, limit) {
	/** @type {Map<string, Record<string, number>>} */
	const byFile = new Map();
	for (const [rule, { files }] of Object.entries(counts)) {
		for (const [file, n] of Object.entries(files)) byFile.set(file, { ...byFile.get(file), [rule]: n });
	}
	return [...byFile]
		.map(([file, rules]) => ({ file, count: Object.values(rules).reduce((sum, n) => sum + n, 0), rules }))
		.sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : 1))
		.slice(0, limit);
}
