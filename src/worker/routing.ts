const API_BASE = "https://api.cloudflare.com/client/v4";
const RULES_PER_PAGE = 50;
const MAX_RULE_PAGES = 20;

export interface RoutingClientOptions {
  apiToken: string;
  fetcher?: typeof fetch;
}

export interface EnsureRouteInput {
  domain: string;
  address: string;
  workerName: string;
  zoneId: string | null;
}

export type EnsureRouteResult =
  | { status: "created"; zoneId: string; ruleId: string }
  | { status: "existing"; zoneId: string; ruleId: string };

interface RoutingRule {
  id: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

interface ApiEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

/** Cloudflare rejected a request or could not be reached. */
export class CloudflareApiError extends Error {}

/** A routing rule already exists for the address but does not deliver to this Worker. */
export class RoutingConflictError extends Error {}

export function routingRuleName(address: string): string {
  return `cfmail ${address}`;
}

export function createRoutingClient({ apiToken, fetcher = fetch }: RoutingClientOptions) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
    let response: Response;
    try {
      response = await fetcher(`${API_BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      });
    } catch {
      throw new CloudflareApiError("Cloudflare could not be reached");
    }
    let body: ApiEnvelope<T> | null = null;
    try {
      body = await response.json<ApiEnvelope<T>>();
    } catch {
      body = null;
    }
    if (!response.ok || !body?.success) {
      const detail = body?.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new CloudflareApiError(`Cloudflare API error (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return body;
  }

  async function findZoneId(domain: string): Promise<string> {
    const body = await call<Array<{ id: string; name: string }>>(`/zones?name=${encodeURIComponent(domain)}`);
    const zone = body.result.find((candidate) => candidate.name.toLowerCase() === domain);
    if (!zone) throw new CloudflareApiError(`${domain} is not a Cloudflare zone the API token can access`);
    return zone.id;
  }

  async function listRules(zoneId: string): Promise<RoutingRule[]> {
    const rules: RoutingRule[] = [];
    for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
      const body = await call<RoutingRule[]>(
        `/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${RULES_PER_PAGE}`,
      );
      rules.push(...body.result);
      const totalPages = body.result_info?.total_pages ?? 1;
      if (page >= totalPages || body.result.length < RULES_PER_PAGE) break;
    }
    return rules;
  }

  async function ensureWorkerRoute(input: EnsureRouteInput): Promise<EnsureRouteResult> {
    const zoneId = input.zoneId || await findZoneId(input.domain);
    const existing = (await listRules(zoneId)).filter((rule) => matchesAddress(rule, input.address));
    const ours = existing.find((rule) => rule.enabled !== false && deliversToWorker(rule, input.workerName));
    if (ours) return { status: "existing", zoneId, ruleId: ours.id };
    if (existing.length) {
      throw new RoutingConflictError(
        `Cloudflare already has a routing rule for ${input.address} that does not deliver to the ${input.workerName} Worker. ` +
          "Update or remove it in Email Routing first.",
      );
    }
    const body = await call<RoutingRule>(`/zones/${zoneId}/email/routing/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: routingRuleName(input.address),
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: input.address }],
        actions: [{ type: "worker", value: [input.workerName] }],
      }),
    });
    return { status: "created", zoneId, ruleId: body.result.id };
  }

  async function deleteRule(zoneId: string, ruleId: string): Promise<void> {
    await call<unknown>(`/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: "DELETE" });
  }

  return { ensureWorkerRoute, deleteRule };
}

function matchesAddress(rule: RoutingRule, address: string): boolean {
  return (rule.matchers || []).some(
    (matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value?.toLowerCase() === address,
  );
}

function deliversToWorker(rule: RoutingRule, workerName: string): boolean {
  return (rule.actions || []).some((action) => action.type === "worker" && (action.value || []).includes(workerName));
}
