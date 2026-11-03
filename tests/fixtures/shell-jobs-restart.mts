/**
 * Child of the restart suite: the old Pi. It starts one job, ends its session
 * the way an auto-update restart does (the restart intent, then a "quit"
 * shutdown), and exits. argv: agent dir, session file, command.
 */
import { createFakePi, fire, jiti, shellJobs } from "../support/shell-jobs-harness.mts";

const [agentDir, sessionFile, command] = process.argv.slice(2) as [string, string, string];
process.env.PI_CODING_AGENT_DIR = agentDir;
const { markRestart } = (await jiti.import("../../lib/restart-intent.ts")) as typeof import("../../lib/restart-intent.ts");

const app = createFakePi();
Object.assign(app.ctx.sessionManager, { getSessionFile: () => sessionFile, getSessionId: () => "restart-session" });
shellJobs(app.pi as any);
await fire(app.handlers, "session_start", app.ctx);
const job = await app.tools.get("shell_job_start").execute("start", { command, title: "Restart job" }, undefined, undefined, app.ctx);
markRestart(sessionFile);
await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
process.stdout.write(JSON.stringify({ ...job.details, cwd: app.ctx.cwd }), () => process.exit(0));
