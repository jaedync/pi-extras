// Builds the import graph and finds what the skill asks about: cycles, stable code
// that imports more volatile code, files that change together with no import, and
// the files outside the area that import it (the area's public interface).
import { dirname } from "node:path";
import { listSourceFiles, readSource } from "./files.mjs";
import { ageDays, changeRate, churn, coChangePairs, gitPlace, readHistory, round } from "./history.mjs";
import { localImports } from "./imports.mjs";

/** @param {string} file @param {"file" | "dir"} by */
export function moduleOf(file, by) {
	return by === "dir" ? dirname(file) : file;
}

/** Collapses a file graph to module level and drops edges inside one module. */
export function groupGraph({ files, edges }, by) {
	const modules = [...new Set(files.map((f) => moduleOf(f, by)))].sort();
	const grouped = new Map(modules.map((m) => [m, new Set()]));
	for (const [from, targets] of edges) {
		for (const to of targets) {
			const a = moduleOf(from, by);
			const b = moduleOf(to, by);
			if (a !== b) grouped.get(a).add(b);
		}
	}
	return { modules, edges: new Map([...grouped].map(([m, set]) => [m, [...set].sort()])) };
}

/**
 * Strongly connected components with more than one node (Tarjan). Iterative, so
 * that a long import chain cannot overflow the call stack.
 * @param {string[]} nodes @param {Map<string, string[]>} edges
 */
export function cycles(nodes, edges) {
	const idx = new Map();
	const low = new Map();
	const stack = [];
	const onStack = new Set();
	const out = [];
	let index = 0;
	for (const root of nodes) {
		if (idx.has(root)) continue;
		const work = [{ v: root, next: 0 }];
		idx.set(root, index);
		low.set(root, index++);
		stack.push(root);
		onStack.add(root);
		while (work.length) {
			const frame = work[work.length - 1];
			const targets = edges.get(frame.v) ?? [];
			if (frame.next < targets.length) {
				const w = targets[frame.next++];
				if (!idx.has(w)) {
					idx.set(w, index);
					low.set(w, index++);
					stack.push(w);
					onStack.add(w);
					work.push({ v: w, next: 0 });
				} else if (onStack.has(w)) {
					low.set(frame.v, Math.min(low.get(frame.v), idx.get(w)));
				}
				continue;
			}
			work.pop();
			if (work.length) {
				const parent = work[work.length - 1].v;
				low.set(parent, Math.min(low.get(parent), low.get(frame.v)));
			}
			if (low.get(frame.v) === idx.get(frame.v)) {
				const component = [];
				let w;
				do {
					w = stack.pop();
					onStack.delete(w);
					component.push(w);
				} while (w !== frame.v);
				if (component.length > 1) out.push(component.sort());
			}
		}
	}
	return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** Fan-in, fan-out and Martin's instability I = out / (in + out) for each module. */
export function metrics(modules, edges) {
	const fanIn = new Map(modules.map((m) => [m, 0]));
	for (const targets of edges.values()) for (const t of targets) fanIn.set(t, fanIn.get(t) + 1);
	return new Map(modules.map((m) => {
		const out = edges.get(m)?.length ?? 0;
		const inn = fanIn.get(m);
		return [m, { fanIn: inn, fanOut: out, instability: inn + out === 0 ? 0 : round(out / (inn + out)) }];
	}));
}

/**
 * Edges where the importer changes much less often (per month) than what it
 * imports: the stable piece must follow each change of the volatile one. An
 * importer younger than minAgeDays has too little history to call it stable.
 */
export function volatileImports(edges, { counts, first }, now, { ratio = 2, minChanges = 3, minAgeDays = 60 } = {}) {
	const out = [];
	for (const [from, targets] of edges) {
		if (!first.has(from) || ageDays(first.get(from), now) < minAgeDays) continue;
		const ownRate = changeRate(counts.get(from), first.get(from), now);
		for (const to of targets) {
			const theirs = counts.get(to) ?? 0;
			if (theirs < minChanges) continue;
			const theirRate = changeRate(theirs, first.get(to), now);
			if (theirRate >= ratio * ownRate) {
				out.push({ from, to, changesFrom: counts.get(from), changesTo: theirs, perMonthFrom: round(ownRate), perMonthTo: round(theirRate) });
			}
		}
	}
	return out.sort((a, b) => b.perMonthTo / b.perMonthFrom - a.perMonthTo / a.perMonthFrom || a.from.localeCompare(b.from));
}

/**
 * Reads the area and, inside a git checkout, the rest of the repository, so that
 * imports resolve from the repository root and importers outside the area show.
 */
function readArea(root, includeTests) {
	const place = gitPlace(root);
	const prefix = place?.prefix ?? "";
	const top = place?.top ?? root;
	const area = listSourceFiles(root, { includeTests });
	const all = place ? listSourceFiles(top, { includeTests: true }) : listSourceFiles(root, { includeTests: true });
	const known = new Set(all);
	const inArea = new Set(area.map((f) => prefix + f));
	const edges = new Map(area.map((f) => {
		const targets = localImports(prefix + f, readSource(root, f), known).filter((t) => inArea.has(t));
		return [f, targets.map((t) => t.slice(prefix.length))];
	}));
	// With no prefix the area is the whole repository, so nothing is outside it.
	const outsideFiles = place && prefix ? all.filter((f) => !f.startsWith(prefix)) : [];
	const outside = place
		? outsideFiles.flatMap((file) => localImports(file, readSource(top, file), known)
			.filter((to) => inArea.has(to))
			.map((to) => ({ from: file, to: to.slice(prefix.length) })))
		: null;
	return { place, files: area, edges, outside };
}

/**
 * The full analysis that `untangle graph` prints.
 * @param {string} root
 * @param {{ by?: "file" | "dir", since?: string, includeTests?: boolean, minAgeDays?: number, now?: number }} [options]
 */
export function analyze(root, { by = "file", since = "12 months ago", includeTests = false, minAgeDays = 60, now = Date.now() / 1000 } = {}) {
	const { place, files, edges: fileEdges, outside } = readArea(root, includeTests);
	const { modules, edges } = groupGraph({ files, edges: fileEdges }, by);
	const history = place ? readHistory(root, { since }) : null;
	const inArea = new Set(files);
	const keyOf = (f) => (inArea.has(f) ? moduleOf(f, by) : null);
	const stats = history ? churn(history.commits, keyOf) : { counts: new Map(), first: new Map() };
	const linked = new Set();
	for (const [from, targets] of edges) for (const to of targets) linked.add(`${from}\n${to}`).add(`${to}\n${from}`);
	const hidden = history ? coChangePairs(history.commits, { keyOf }).filter((p) => !linked.has(`${p.a}\n${p.b}`)) : null;
	const m = metrics(modules, edges);
	return {
		root,
		by,
		since,
		head: place?.head ?? null,
		files: files.length,
		modules: modules.length,
		edges: [...edges.values()].reduce((n, t) => n + t.length, 0),
		cycles: cycles(modules, edges),
		volatileImports: history ? volatileImports(edges, stats, now, { minAgeDays }) : null,
		youngModules: history ? modules.filter((name) => !stats.first.has(name) || ageDays(stats.first.get(name), now) < minAgeDays).length : null,
		minAgeDays,
		hiddenLinks: hidden,
		outsideImporters: outside?.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)) ?? null,
		modulesTable: modules.map((name) => ({ name, ...m.get(name), changes: stats.counts.get(name) ?? 0, imports: edges.get(name) })),
	};
}
