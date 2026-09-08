import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const values = new Map();
const flags = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) continue;
  const key = argument.slice(2);
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) flags.add(key);
  else {
    values.set(key, next);
    index += 1;
  }
}

const domain = (values.get("domain") || "").toLowerCase();
const address = (values.get("address") || "").toLowerCase();
const label = values.get("label") || domain;
const displayName = values.get("display-name") || label;
const workerName = values.get("worker") || "cfmail";
const apply = flags.has("apply");
const replaceMx = flags.has("replace-mx");

if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  throw new Error("Pass a valid --domain, for example example.com.");
}
if (!new RegExp(`^[^@\\s]+@${domain.replaceAll(".", "\\.")}$`, "i").test(address)) {
  throw new Error("--address must belong to --domain.");
}
if (!apply) {
  console.log("Dry run only. This command will:");
  console.log(`1. Confirm Email Routing for ${domain}.`);
  console.log(`2. Onboard ${domain} for Email Sending.`);
  console.log(`3. Route only ${address} to the ${workerName} Worker.`);
  console.log("4. Add the domain and identity to cfmail's D1 database.");
  console.log("Run again with --apply after reviewing the plan.");
  if (!replaceMx) console.log("If Email Routing is disabled, also pass --replace-mx to authorize changing MX records.");
  process.exit(0);
}

function wrangler(args, capture = false) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

let routingSettings = "";
try {
  routingSettings = wrangler(["email", "routing", "settings", domain], true);
} catch {
  routingSettings = "";
}
if (!/enabled:\s*(?:true|yes)/i.test(routingSettings)) {
  if (!replaceMx) {
    throw new Error(`Email Routing is not enabled for ${domain}. Re-run with --replace-mx only if cfmail should replace its current MX provider.`);
  }
  wrangler(["email", "routing", "enable", domain]);
}

const sendingDomains = wrangler(["email", "sending", "list"], true);
const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sendingEnabled = sendingDomains
  .replace(/\u001b\[[0-9;]*m/g, "")
  .split(/\r?\n/)
  .some((line) => new RegExp(`${escapedDomain}.*\\byes\\b`, "i").test(line));
if (!sendingEnabled) {
  wrangler(["email", "sending", "enable", domain]);
}

const rules = wrangler(["email", "routing", "rules", "list", domain], true);
const escapedAddress = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (new RegExp(`to:${escapedAddress}`, "i").test(rules)) {
  throw new Error(`A routing rule already exists for ${address}. Resolve it explicitly instead of overwriting it.`);
}
wrangler([
  "email", "routing", "rules", "create", domain,
  "--name", `cfmail ${address}`,
  "--match-type", "literal",
  "--match-field", "to",
  "--match-value", address,
  "--action-type", "worker",
  "--action-value", workerName,
]);

const domainId = randomUUID();
const identityId = randomUUID();
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const sql = `
  INSERT INTO domains (id, name, label, status, inbound_enabled, outbound_enabled, created_at, updated_at)
  VALUES (${quote(domainId)}, ${quote(domain)}, ${quote(label)}, 'active', 1, 1, datetime('now'), datetime('now'))
  ON CONFLICT(name) DO UPDATE SET label=excluded.label, status='active', inbound_enabled=1, outbound_enabled=1, updated_at=datetime('now');
  INSERT INTO identities (id, domain_id, email, display_name, is_default, created_at, updated_at)
  VALUES (${quote(identityId)}, (SELECT id FROM domains WHERE name=${quote(domain)}), ${quote(address)}, ${quote(displayName)}, 0, datetime('now'), datetime('now'))
  ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name, updated_at=datetime('now');
`.replace(/\s+/g, " ").trim();
wrangler(["d1", "execute", "DB", "--remote", "--command", sql]);

console.log(`Configured ${address} for cfmail.`);
