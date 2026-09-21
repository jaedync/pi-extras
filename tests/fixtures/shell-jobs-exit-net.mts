/** Child of the reload suite: exit with the extension detached and no shutdown hook. */
import { createFakePi, fire, shellJobs } from "../support/shell-jobs-harness.mts";

const app = createFakePi();
shellJobs(app.pi as any);
await fire(app.handlers, "session_start", app.ctx);
const job = await app.tools.get("shell_job_start").execute("start", { command: "sleep 30" }, undefined, undefined, app.ctx);
await fire(app.handlers, "session_shutdown", app.ctx, { reason: "reload" });
process.stdout.write(JSON.stringify({ ...job.details, cwd: app.ctx.cwd }), () => process.exit(0));
