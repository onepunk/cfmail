import { api } from "./api";
import { handleIncomingEmail, processIngestJob } from "./inbound";
import { isMailJob, type MailJob } from "./jobs";
import { runLogicalBackup, runMaintenance } from "./maintenance";
import { processSendJob } from "./outbound";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  email: handleIncomingEmail,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (!isMailJob(message.body)) {
        console.error(JSON.stringify({ message: "Discarding invalid mail queue job", queueMessageId: message.id }));
        message.ack();
        continue;
      }
      try {
        if (message.body.type === "ingest") await processIngestJob(message.body.jobId, env);
        else if (message.body.type === "send") await processSendJob(message.body.messageId, env);
        else if (message.body.type === "backup") await runLogicalBackup(env, message.body.requestedAt);
        else await runMaintenance(env);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          message: "Mail queue job failed",
          jobType: message.body.type,
          queueMessageId: message.id,
          attempt: message.attempts,
          error: error instanceof Error ? error.message : "unknown",
        }));
        message.retry({ delaySeconds: Math.min(3_600, 30 * (2 ** Math.min(message.attempts, 7))) });
      }
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const requestedAt = new Date(controller.scheduledTime).toISOString();
    await env.MAIL_QUEUE.sendBatch([
      { body: { type: "backup", requestedAt } satisfies MailJob },
      { body: { type: "maintenance", requestedAt } satisfies MailJob },
    ]);
  },
} satisfies ExportedHandler<Env>;
