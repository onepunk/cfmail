export type MailJob =
  | { type: "ingest"; jobId: string }
  | { type: "send"; messageId: string }
  | { type: "backup"; requestedAt: string }
  | { type: "maintenance"; requestedAt: string };

export function isMailJob(value: unknown): value is MailJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<MailJob>;
  if (job.type === "ingest") return typeof job.jobId === "string";
  if (job.type === "send") return typeof job.messageId === "string";
  if (job.type === "backup" || job.type === "maintenance") return typeof job.requestedAt === "string";
  return false;
}
