import { dateFormat } from "./date-format.ts";
import { STATUS_TIME_ZONE } from "./status-plus-logic.ts";

export function localTime(epochMs: number, timeZone = STATUS_TIME_ZONE): string {
	return dateFormat("local", timeZone, {
		weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
	}).format(new Date(epochMs));
}
