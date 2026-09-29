// Optional settings that are not in wrangler.example.jsonc, so `npm run types` does not generate them.
interface Env {
  /** Cloudflare API token with Zone:Read and Email Routing Rules:Edit, set with `wrangler secret put`. */
  CF_API_TOKEN?: string;
  /** Worker that routing rules deliver to. Defaults to "cfmail". */
  CFMAIL_WORKER_NAME?: string;
}
