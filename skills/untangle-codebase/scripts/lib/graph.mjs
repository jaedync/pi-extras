// Builds the import graph and finds what the skill asks about: cycles, stable code
// that imports more volatile code, and files that change together with no import.
import { dirname } from "node:path";
import { listSourceFiles, readSource } from "./files.mjs";
import { churn, coChangePairs, readCommits, round } from "./history.mjs";
import { localImports } from "./imports.mjs";

/**
 * @param {string} root
 * @param {{ includeTests?: boolean }} [options]
 * @returns {{ files: string[], edges: Map<string, string[]> }}
 */
export function fileGraph(root, { includeTests = false } = {}) {
	// Resolve against every source file, so that an import of a test helper is still seen.
	const known = new Set(listSourceFiles(root, { includeTests: true }));
	const files = listSourceFiles(root, { includeTests });
	const kept = new Set(files);
	const edges = new Map(files.map((file) => [file, localImports(file, readSource(root, file), known).filter((t) => kept.has(t))]));
	return { files, edges };
}

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

/** Strongly connected components with more than one node (Tarjan). */
export function cycles(nodes, edges) {
	let index = 0;
	const stack = [];
	const onStack = new Set();
	const idx = new Map();
	const low = new Map();
	const out = [];
	const visit = (v) => {
		idx.set(v, index);
		low.set(v, index);
		index++;
		stack.push(v);
		onStack.add(v);
		for (const w of edges.get(v) ?? []) {
			if (!idx.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v), low.get(w)));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v), idx.get(w)));
			}
		}
		if (low.get(v) === idx.get(v)) {
			const component = [];
			let w;
			do {
				w = stack.pop();
				onStack.delete(w);
				component.push(w);
			} while (w !== v);
			if (component.length > 1) out.push(component.sort());
		}
	};
	for (const v of nodes) if (!idx.has(v)) visit(v);
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
 * Edges where the importer changed much less often than what it imports:
 * the stable piece must follow every change of the volatile one.
 */
export function volatileImports(edges, changes, { ratio = 2, minChanges = 3 } = {}) {
	const out = [];
	for (const [from, targets] of edges) {
		const own = changes.get(from) ?? 0;
		for (const to of targets) {
			const theirs = changes.get(to) ?? 0;
			if (theirs >= minChanges && theirs >= ratio * Math.max(own, 1)) out.push({ from, to, changesFrom: own, changesTo: theirs });
		}
	}
	return out.sort((a, b) => b.changesTo / Math.max(b.changesFrom, 1) - a.changesTo / Math.max(a.changesFrom, 1));
}

/** Sums file-level change counts into module-level counts (commits that touched the module). */
function moduleChanges(commits, files, by) {
	const kept = new Set(files);
	return churn(commits.map((c) => [...new Set(c.filter((f) => kept.has(f)).map((f) => moduleOf(f, by)))]));
}

/**
 * The full analysis that `untangle graph` prints.
 * @param {string} root
 * @param {{ by?: "file" | "dir", since?: string, includeTests?: boolean }} [options]
 */
export function analyze(root, { by = "file", since = "12 months ago", includeTests = false } = {}) {
	const graph = fileGraph(root, { includeTests });
	const { modules, edges } = groupGraph(graph, by);
	const commits = readCommits(root, { since });
	const changes = commits ? moduleChanges(commits, graph.files, by) : new Map();
	const linked = new Set();
	for (const [from, targets] of graph.edges) for (const to of targets) linked.add(`${from}\n${to}`).add(`${to}\n${from}`);
	const hidden = commits
		? coChangePairs(commits, { only: new Set(graph.files) }).filter((p) => !linked.has(`${p.a}\n${p.b}`))
		: null;
	const m = metrics(modules, edges);
	return {
		root,
		by,
		since,
		files: graph.files.length,
		modules: modules.length,
		edges: [...edges.values()].reduce((n, t) => n + t.length, 0),
		cycles: cycles(modules, edges),
		volatileImports: commits ? volatileImports(edges, changes) : null,
		hiddenLinks: hidden,
		modulesTable: modules.map((name) => ({ name, ...m.get(name), changes: changes.get(name) ?? 0, imports: edges.get(name) })),
	};
}
