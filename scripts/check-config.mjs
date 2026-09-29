import { unstable_readConfig } from "wrangler";

// wrangler.jsonc is local and ignored by Git, so a stale copy can deploy a Worker without its queue,
// cron or Access settings. Refuse to deploy unless it declares everything the example declares.
const example = unstable_readConfig({ config: "wrangler.example.jsonc" });
const local = unstable_readConfig({ config: "wrangler.jsonc" });

const missing = [
  ...example.queues.producers.filter((p) => !local.queues.producers.some((l) => l.binding === p.binding && l.queue === p.queue))
    .map((p) => `queue producer ${p.binding} (${p.queue})`),
  ...example.queues.consumers.filter((c) => !local.queues.consumers.some((l) => l.queue === c.queue))
    .map((c) => `queue consumer for ${c.queue}`),
  ...example.triggers.crons.filter((cron) => !local.triggers.crons?.includes(cron)).map((cron) => `cron "${cron}"`),
  ...Object.keys(example.vars).filter((name) => !local.vars[name]).map((name) => `var ${name}`),
  ...example.compatibility_flags.filter((flag) => !local.compatibility_flags.includes(flag)).map((flag) => `compatibility flag ${flag}`),
];
if (local.workers_dev !== false) missing.push('"workers_dev": false');

if (missing.length) {
  console.error(`wrangler.jsonc is missing settings from wrangler.example.jsonc:\n  - ${missing.join("\n  - ")}`);
  process.exit(1);
}
