# cfmail

cfmail is a self-hosted mailbox that runs on Cloudflare. It receives mail through Email Routing, stores message data in D1 and message files in R2, and sends mail through Cloudflare Email Sending. A React web app provides the inbox, calendar, document editor, and spreadsheet editor.

The project is designed for one administrator managing addresses across several domains. Cloudflare Access protects the web app, and the Worker checks the Access JWT and the administrator's exact email address on every API request.

## Features

- Inbox, Sent, Archive, Spam, and Trash folders across multiple domains
- Threaded messages, search, drafts, attachments, signatures, labels, and delayed sending
- Plain-text and sanitized HTML rendering with remote images blocked by default
- Queue-backed message processing with retries and a dead-letter queue
- D1 backups and retention jobs
- Built-in calendar, document editor, and spreadsheet editor

The editors cover common document and spreadsheet workflows. See [docs/DOCUMENTS.md](docs/DOCUMENTS.md), [docs/SPREADSHEETS.md](docs/SPREADSHEETS.md), and [docs/CALENDAR_APP.md](docs/CALENDAR_APP.md) for supported features and file-format limits.

## How it works

```text
Email Routing -> Worker -> Queue -> D1 and R2
                      |
                      +-> Cloudflare Access protected web app
                      |
                      +-> Email Sending
```

D1 stores mailbox metadata, searchable message text, drafts, settings, documents, workbooks, and calendar events. R2 stores raw messages, attachments, and logical database backups.

## Requirements

- Node.js 22 or newer
- A Cloudflare account with Workers, D1, R2, Queues, Email Routing, Email Sending, and Access
- A domain managed by Cloudflare
- Wrangler authenticated with your Cloudflare account

## Set up

Install the dependencies:

```bash
npm install
npm run setup
```

`npm run setup` creates a local `wrangler.jsonc` from
`wrangler.example.jsonc`. The local file is ignored by Git, so account IDs,
hostnames, Access settings, and administrator addresses are not committed.
Running setup again leaves an existing local configuration unchanged.

Create the Cloudflare resources:

```bash
npx wrangler d1 create cfmail-prod
npx wrangler r2 bucket create cfmail-mail
npx wrangler queues create cfmail-jobs
npx wrangler queues create cfmail-jobs-dlq
```

Edit the local `wrangler.jsonc` and replace the example values with:

- the D1 database ID returned by Wrangler
- the hostname where the app will run
- your Cloudflare Access team domain and application audience
- the exact email address allowed to use the mailbox

The checked-in `wrangler.example.jsonc` uses obvious example values and cannot
be deployed unchanged. Keep reusable schema changes in `migrations/`; D1 and R2
contents, local Wrangler state, build output, `.dev.vars`, and `.env` files are
outside version control.

Create a Cloudflare Access self-hosted application for the app hostname. Add an Allow policy for the same email address used by `CFMAIL_ALLOWED_USER`. Keep `workers_dev` and preview URLs disabled so requests only reach the Access-protected hostname.

Apply the database migrations and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

`npm run deploy` first checks that your local `wrangler.jsonc` declares every queue, cron, variable and compatibility flag in `wrangler.example.jsonc`, and that `workers_dev` is off. A stale local copy would otherwise deploy a Worker that stores incoming mail but never processes it.

Enable Email Sending for each domain you will send from:

```bash
npx wrangler email sending enable example.com
npx wrangler email sending dns get example.com
```

For inbound mail, enable Email Routing and create explicit address rules that send messages to the `cfmail` Worker. The included helper can onboard a domain, create one literal routing rule, and add its first identity to D1. It prints a plan unless `--apply` is provided:

```bash
npm run domain:add -- \
  --domain example.com \
  --address hello@example.com \
  --label Example \
  --display-name "Example Mail"
```

Review the output before adding `--apply`. If Email Routing is not enabled, the helper also requires `--replace-mx` before it will change MX records.
If you changed the Worker name from `cfmail`, also pass `--worker your-worker-name`.

Addresses added later from **Settings → Sending identities** can create their own routing rules. Create a Cloudflare API token with **Zone → Zone → Read** and **Zone → Email Routing Rules → Edit**, limited to your mail domains, and store it as a Worker secret:

```bash
npx wrangler secret put CF_API_TOKEN
```

With the token set, adding an identity creates a literal Email Routing rule that sends the address to the Worker. If a rule for that address already sends mail somewhere else, cfmail refuses to add the identity rather than overwrite the rule. Without the token, the identity is still saved, and the settings page warns you to add the routing rule yourself. If you renamed the Worker, set the `CFMAIL_WORKER_NAME` variable to its name. The token does not enable Email Routing or change MX records; use `npm run domain:add` for a new domain.

## Local development

Apply the migrations to a local D1 database, then start the Worker:

```bash
npm run db:migrate:local
npm run dev
```

Authentication fails closed without a valid Cloudflare Access JWT, so the complete signed-in flow is best tested on an Access-protected staging hostname. Sending mail during local development requires a remote email binding and sends real messages; add `"remote": true` to the `EMAIL` binding only when you intend to do that.

Client changes should follow the shared [UI guide](docs/UI_GUIDE.md), including its accessibility and untrusted-message rules.

Run the checks with:

```bash
npm test
npm run check
npm run build
```

## Security

Email content is untrusted input. Please read [SECURITY.md](SECURITY.md) before changing message rendering, authentication, storage, or routing behavior.

## License

Licensed under the [Apache License 2.0](LICENSE).
