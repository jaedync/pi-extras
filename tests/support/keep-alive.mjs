import { after } from "node:test";

// Node 22 ends a test file as soon as its event loop is empty, and cancels every test still pending. Some tests wait
// on code whose timers and child processes are unref'd so that they never hold Pi open (a budget clock, a close bound,
// the microphone probe). Node 24 and later keep the loop alive while a test runs; this gives Node 22 the same rule.
const keepAlive = setInterval(() => {}, 2 ** 30);
after(() => clearInterval(keepAlive));
