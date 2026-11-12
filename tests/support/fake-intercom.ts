import { INTERCOM_REGISTER_EVENT } from "../../lib/herdr-intercom-gate.ts";

export interface Registration {
	namespace: string;
	ownerEligible: boolean;
	onReady(channel: { snapshot(): { connected: boolean } }): void;
	onEvent(event: unknown): void;
}

/** pi-intercom's side of the extension channel, as far as the gate uses it (pi-intercom 0.18.1, index.ts registerLocalExtension). */
export function fakeIntercom(connected = false) {
	const state = { connected, registrations: [] as Registration[] };
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const events = {
		emit: (channel: string, data: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(data); },
		on: (channel: string, fn: (data: unknown) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), fn]); return () => {}; },
	};
	events.on(INTERCOM_REGISTER_EVENT, (data) => {
		const registration = data as Registration;
		if (state.registrations.some((r) => r.namespace === registration.namespace)) throw new Error("namespace already registered");
		state.registrations.push(registration);
		registration.onReady({ snapshot: () => ({ connected: state.connected }) });
		if (state.connected) registration.onEvent({ type: "connection", connected: true, supported: true });
	});
	const connect = (value: boolean) => {
		state.connected = value;
		for (const r of state.registrations) r.onEvent({ type: "connection", connected: value, supported: value });
	};
	return { events, state, connect };
}

