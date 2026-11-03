/**
 * Child of the restart suite: the new Pi. It adopts the session's hand-over
 * and exits with no shutdown hook, so only the process exit net acts.
 * argv: agent dir, session file. Prints the adopted job ids.
 */
import { createFakePi, fire, shellJobs, __testing } from "../support/shell-jobs-harness.mts";

const [agentDir, sessionFile] = process.argv.slice(2) as [string, string];
process.env.PI_CODING_AGENT_DIR = agentDir;
const app = createFakePi();
Object.assign(app.ctx.sessionManager, { getSessionFile: () => sessionFile, getSessionId: () => "restart-session" });
shellJobs(app.pi as any);
await fire(app.handlers, "session_start", app.ctx);
const ids = [...__testing.getRuntimes()].flatMap((runtime) => [...runtime.jobs.keys()]);
process.stdout.write(JSON.stringify(ids), () => process.exit(0));
