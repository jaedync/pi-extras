/**
 * remote-pi publishes its footer through Pi's shared status slots, three of
 * them, each of which the built-in footer prints on its own line:
 *
 *   remote-pi:session      📡 <session> (<peer count>)
 *   remote-pi:relay        🟢 relay | 🟡 relay waiting for pairing
 *   remote-pi:peer-active  📱 <device short id>
 *
 * This file folds those into one MeshState so the grid can show them as a
 * single toned cell, and hands every other extension's status back untouched.
 * Parsing is by slot key, so remote-pi's emoji and wording can change without
 * breaking the cell; anything unrecognised falls through as a plain line.
 */
import type { Painter } from "./status-plus-render.ts";

export interface MeshState {
	session?: string;
	peerCount?: number;
	relay?: "paired" | "unpaired";
	device?: string;
}

export const MESH_KEY_PREFIX = "remote-pi:";
const SESSION_RE = /^(.+?)\s*\((\d+)\)$/u;

/** Strip a leading emoji or symbol token so the words survive any icon change. */
function words(text: string): string {
	return text.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function parseSlot(mesh: MeshState, key: string, text: string): MeshState {
	const slot = key.slice(MESH_KEY_PREFIX.length);
	const plain = words(text);
	if (slot === "session") {
		const match = SESSION_RE.exec(plain);
		if (match) return { ...mesh, session: match[1], peerCount: Number(match[2]) };
		return { ...mesh, session: plain };
	}
	if (slot === "relay") return { ...mesh, relay: /waiting|unpaired|pairing/i.test(plain) ? "unpaired" : "paired" };
	if (slot === "peer-active") return { ...mesh, device: plain };
	return mesh;
}

/**
 * Split Pi's status map into the mesh cell and the remaining plain lines.
 * `mesh` is undefined when remote-pi has nothing to show, so the footer
 * costs nothing on machines without it.
 */
export function splitMeshStatuses(entries: Iterable<[string, unknown]>): { mesh?: MeshState; others: string[] } {
	let mesh: MeshState | undefined;
	const others: string[] = [];
	const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
	for (const [key, value] of sorted) {
		const text = typeof value === "string" ? value : "";
		if (!key.startsWith(MESH_KEY_PREFIX)) {
			others.push(text);
			continue;
		}
		if (!text.trim()) continue;
		mesh = parseSlot(mesh ?? {}, key, text);
	}
	return { mesh, others };
}

/**
 * One cell: `backend (2) · relay · ab12`. Session name reads as text, peer
 * count dim, relay green when a device is paired and warning until then, the
 * attached device in the accent. Nothing renders for an empty state.
 */
export function meshText(paint: Painter, mesh: MeshState | undefined, compact: boolean): string {
	if (!mesh) return "";
	const sep = compact ? " " : " · ";
	const parts: string[] = [];
	if (mesh.session) {
		const count = mesh.peerCount !== undefined ? paint.fg("dim", ` (${mesh.peerCount})`) : "";
		parts.push(`${paint.fg("text", mesh.session)}${count}`);
	}
	if (mesh.relay === "paired") parts.push(paint.fg("success", "relay"));
	else if (mesh.relay === "unpaired") parts.push(paint.fg("warning", compact ? "relay ?" : "relay unpaired"));
	if (mesh.device) parts.push(paint.fg("accent", mesh.device));
	return parts.join(paint.fg("dim", sep));
}
