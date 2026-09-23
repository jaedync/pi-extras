/**
 * Which microphone to record from. The choice is saved by device name, not
 * index: PvRecorder and ffmpeg (used over SSH) number devices differently,
 * but both accept names. A saved mic that is unplugged falls back to the
 * system default rather than failing the dictation.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPvRecorder } from "./capture.ts";

export interface MicList {
	readonly devices: readonly string[];
	/** Name of the system default input, when it can be read. */
	readonly systemDefault?: string;
}

export interface ResolvedMic {
	/** Device to open by name; absent means the system default. */
	readonly device?: string;
	/** Name of the device that will actually record, when known. */
	readonly name?: string;
	/** The saved mic, when it is not connected. */
	readonly missing?: string;
}

export interface MicChoice {
	readonly label: string;
	/** undefined selects the system default. */
	readonly value: string | undefined;
}

const SETTINGS_FILE = "settings.json";

/**
 * Enumerating devices does not open them, so it never triggers a permission
 * prompt. Naming the default takes a probe recorder (~20 ms); skip it on the
 * dictation path when the recorder reports its own device anyway.
 */
export function listMics(withDefault = true): MicList {
	const PvRecorder = loadPvRecorder();
	if (!PvRecorder) return { devices: [] };
	try {
		const devices = PvRecorder.getAvailableDevices();
		if (!withDefault) return { devices };
		const probe = new PvRecorder(512, -1);
		try {
			return { devices, systemDefault: probe.getSelectedDevice() };
		} finally {
			probe.release();
		}
	} catch {
		return { devices: [] };
	}
}

export function resolveMic(saved: string | undefined, list: MicList): ResolvedMic {
	const fallback = list.systemDefault ? { name: list.systemDefault } : {};
	if (!saved) return fallback;
	if (list.devices.includes(saved)) return { device: saved, name: saved };
	return { ...fallback, missing: saved };
}

export function micSummary(saved: string | undefined, list: MicList): string {
	const mic = resolveMic(saved, list);
	if (mic.missing) {
		return `${mic.missing}, not connected (using the system default${mic.name ? `, ${mic.name}` : ""})`;
	}
	if (mic.device) return mic.device;
	return mic.name ? `${mic.name} (system default)` : "system default";
}

export function micChoices(saved: string | undefined, list: MicList): MicChoice[] {
	const mark = (current: boolean) => (current ? "✓ " : "  ");
	const choices: MicChoice[] = [
		{ label: `${mark(!saved)}System default${list.systemDefault ? ` (${list.systemDefault})` : ""}`, value: undefined },
		...list.devices.map((device) => ({ label: `${mark(saved === device)}${device}`, value: device })),
	];
	if (saved && !list.devices.includes(saved)) choices.push({ label: `${mark(true)}${saved} (not connected)`, value: saved });
	return choices;
}

function readSettings(home: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(join(home, SETTINGS_FILE), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function readMicSetting(home: string): string | undefined {
	const mic = readSettings(home).mic;
	return typeof mic === "string" && mic ? mic : undefined;
}

export function writeMicSetting(home: string, mic: string | undefined): void {
	const { mic: _previous, ...rest } = readSettings(home);
	const path = join(home, SETTINGS_FILE);
	writeFileSync(`${path}.tmp`, `${JSON.stringify(mic ? { ...rest, mic } : rest, null, 2)}\n`, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}
