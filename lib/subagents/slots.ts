/**
 * The line for the team's maxConcurrent slots (team.ts). A queued spawn or
 * relaunch starts when a slot is free. A child that holds its session and
 * goes on (a message to an idle child, a parent woken from waiting, an asker
 * that got its answer) waits in line too, ahead of those that have not
 * started, since it has work under way. A spawn waiting for its after agents
 * keeps its place but holds no slot. A parent blocked on a subagent it
 * started with wait: true lends that subagent its slot, and a child whose bash
 * call sleeps lends its slot out until the sleep ends.
 */
import { waitingFor } from "./after.ts";
import { ACTIVE_STATES, type AgentRecord, LIVE_STATES } from "./types.ts";

export interface SlotHost {
	readonly maxConcurrent: number;
	closed(): boolean;
	list(): AgentRecord[];
	get(name: string): AgentRecord | undefined;
	/** Whether `name` has lent its slot out while its bash call sleeps (bash-rest.ts). */
	resting(name: string): boolean;
	/** Launches `name`, which waited in line to start. */
	start(name: string): void;
}

interface GoOn {
	go(): void;
	/** It left the line without a slot: a stop or a close. */
	drop(): void;
}

export class Slots {
	private readonly line: string[] = [];
	private readonly goingOn = new Map<string, GoOn>();
	private readonly host: SlotHost;

	constructor(host: SlotHost) {
		this.host = host;
	}

	/** Puts `name`, now queued, in line to start; `first` puts it ahead, as a subagent its blocked parent waits on. */
	enqueue(name: string, first = false): void {
		if (first) this.line.unshift(name);
		else this.line.push(name);
	}

	/** Whether a slot is free now. */
	free(): boolean {
		return !this.host.closed() && this.used() < this.host.maxConcurrent;
	}

	/** `name`, now queued, goes on in the session it holds once a slot is free. */
	goOn(name: string, go: () => void, drop: () => void): void {
		this.goingOn.get(name)?.drop();
		this.goingOn.set(name, { go, drop });
		// Behind subagents their blocked parents wait on, and others going on; ahead of what has not started.
		const at = this.line.findIndex((queued) => !this.goingOn.has(queued) && !this.host.get(queued)?.blocking);
		this.line.splice(at < 0 ? this.line.length : at, 0, name);
	}

	remove(name: string): void {
		const index = this.line.indexOf(name);
		if (index >= 0) this.line.splice(index, 1);
		this.dropGoOn(name);
	}

	clear(): void {
		this.line.splice(0);
		for (const name of [...this.goingOn.keys()]) this.dropGoOn(name);
	}

	/** Who waits in line, in order. */
	queued(): readonly string[] {
		return this.line;
	}

	/** Starts or lets go on what fits in the free slots. */
	pump(): void {
		let active = this.used();
		const held: string[] = [];
		while (!this.host.closed() && active < this.host.maxConcurrent && this.line.length > 0) {
			const name = this.line.shift()!;
			const record = this.host.get(name);
			const going = this.goingOn.get(name);
			if (record?.state !== "queued") { this.dropGoOn(name); continue; }
			if (going) { this.goingOn.delete(name); active++; going.go(); continue; }
			if (waitingFor(record, this.host.get).length > 0) { held.push(name); continue; }
			active++;
			this.host.start(name);
		}
		this.line.unshift(...held);
	}

	/** Slots in use: one for each starting or running child, but a parent blocked on its wait: true subagent shares that subagent's, and a resting child lent its own out. */
	used(): number {
		const records = this.host.list();
		const blocked = new Set(records.filter((record) => record.blocking && LIVE_STATES.has(record.state)).map((record) => record.parent));
		return records.filter((record) => ACTIVE_STATES.has(record.state) && !blocked.has(record.name) && !this.host.resting(record.name)).length;
	}

	private dropGoOn(name: string): void {
		const going = this.goingOn.get(name);
		this.goingOn.delete(name);
		going?.drop();
	}
}
