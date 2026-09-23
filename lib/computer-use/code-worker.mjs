// Runs one computer_use code block in its own V8 context on a worker thread, so
// a runaway loop can be terminated without freezing Pi. It is not a security
// boundary: the agent writing this code can already run shell commands. It only
// keeps Node globals out of reach by accident and bridges `sky` to the parent.
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

const { code, store, methods } = workerData;
const port = parentPort;
const pending = new Map();
let nextId = 1;

port.on("message", (message) => {
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.error !== undefined) waiter.reject(new Error(message.error));
	else waiter.resolve(message.value);
});

const bridge = {
	call: (method, args) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		port.postMessage({ type: "call", id, method, args });
	}),
	emit: (value) => port.postMessage({ type: "emit", value }),
	emitImage: (value) => port.postMessage({ type: "emit_image", value }),
};

const context = vm.createContext({ __bridge: bridge, __store: JSON.stringify(store), __methods: JSON.stringify(methods) }, {
	codeGeneration: { strings: false, wasm: false },
	name: "computer-use",
});

new vm.Script(`(() => {
	const bridge = globalThis.__bridge;
	const methods = JSON.parse(globalThis.__methods);
	globalThis.store = JSON.parse(globalThis.__store);
	delete globalThis.__bridge;
	delete globalThis.__store;
	delete globalThis.__methods;
	const call = async (method, args = {}) => JSON.parse(await bridge.call(method, JSON.stringify(args)));
	globalThis.sky = Object.freeze(Object.fromEntries(methods.map((method) => [method, (args) => call(method, args)])));
	// Functions and symbols have no JSON form; show them as text rather than losing them.
	globalThis.emit = (value) => bridge.emit(JSON.stringify(value === undefined ? null : value) ?? JSON.stringify(String(value)));
	globalThis.emitImage = (screenshot) => {
		if (!screenshot || screenshot.type !== "screenshot") throw new Error("emitImage needs the screenshot from sky.get_app_state");
		bridge.emitImage(JSON.stringify(screenshot));
	};
})()`).runInContext(context);

const storeJson = () => {
	const json = new vm.Script("JSON.stringify(store)").runInContext(context);
	if (typeof json !== "string" || !json.startsWith("{")) throw new Error("store must stay a JSON object");
	return json;
};

port.postMessage({ type: "ready" });
try {
	await new vm.Script(`(async () => {\n${code}\n})()`, { filename: "computer-use.js" }).runInContext(context);
	port.postMessage({ type: "done", store: storeJson() });
} catch (cause) {
	let store;
	try { store = storeJson(); } catch { store = undefined; }
	port.postMessage({ type: "done", store, error: cause instanceof Error ? cause.message : String(cause) });
}
