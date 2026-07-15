// Entry point: Hono app (rotas /in/* e /api/*) + handler de cron.

import { Hono } from "hono";
import type { Env } from "./util";
import { ingestHandler } from "./ingest";
import { api } from "./api";
import { runRetryCron, runCleanupCron } from "./retry";

const app = new Hono<{ Bindings: Env }>();

app.all("/in/:token", ingestHandler);
app.route("/api", api);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 3 * * *") {
      await runCleanupCron(env);
    } else {
      await runRetryCron(env, ctx);
    }
  },
};
