# Security policy

cfmail processes untrusted email content and stores private messages. Changes must preserve these boundaries:

- Never render unsanitized email HTML in the application origin.
- Never expose R2 buckets publicly. Downloads must pass through authenticated API routes.
- Never put Cloudflare tokens, Access credentials, production resource IDs, message content, or personal information in repository files or logs.
- Keep sending identities allow-listed in D1 and require confirmation when a reply changes domains.
- Keep Cloudflare Access in front of every public route, validate its JWT in the Worker, and keep the exact-email allow-list fail closed.
- Do not change MX records or existing Email Routing rules implicitly.

Report vulnerabilities with GitHub's private vulnerability reporting. If it is not available, open an issue that asks for a private contact channel and do not include sensitive details.
