import { describe, expect, it } from "vitest";
import { CloudflareApiError, RoutingConflictError, createRoutingClient } from "./routing";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeCloudflare(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      method: init?.method || "GET",
      path: `${url.pathname.replace("/client/v4", "")}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

const ok = (result: unknown, resultInfo?: unknown) => ({ body: { success: true, errors: [], result, result_info: resultInfo } });
const input = { domain: "example.com", address: "test@example.com", workerName: "cfmail", zoneId: null };
const workerRule = (id: string, address: string, workerName = "cfmail") => ({
  id,
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: address }],
  actions: [{ type: "worker", value: [workerName] }],
});

describe("Email Routing rule provisioning", () => {
  it("looks up the zone and creates a literal rule for the Worker", async () => {
    const { calls, fetcher } = fakeCloudflare((call) => {
      if (call.path.startsWith("/zones?")) return ok([{ id: "zone-1", name: "example.com" }]);
      if (call.method === "GET") return ok([workerRule("rule-0", "hello@example.com")], { page: 1, total_pages: 1 });
      return ok({ id: "rule-1" });
    });
    const result = await createRoutingClient({ apiToken: "token", fetcher }).ensureWorkerRoute(input);
    expect(result).toEqual({ status: "created", zoneId: "zone-1", ruleId: "rule-1" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /zones?name=example.com",
      "GET /zones/zone-1/email/routing/rules?page=1&per_page=50",
      "POST /zones/zone-1/email/routing/rules",
    ]);
    expect(calls[2].body).toEqual({
      name: "cfmail test@example.com",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "test@example.com" }],
      actions: [{ type: "worker", value: ["cfmail"] }],
    });
  });

  it("reuses a stored zone ID and an existing rule for the Worker", async () => {
    const { calls, fetcher } = fakeCloudflare(() => ok([workerRule("rule-9", "Test@Example.com")], { page: 1, total_pages: 1 }));
    const result = await createRoutingClient({ apiToken: "token", fetcher }).ensureWorkerRoute({ ...input, zoneId: "zone-2" });
    expect(result).toEqual({ status: "existing", zoneId: "zone-2", ruleId: "rule-9" });
    expect(calls).toHaveLength(1);
  });

  it("reads every page of rules before deciding", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => workerRule(`rule-${index}`, `user${index}@example.com`));
    const { calls, fetcher } = fakeCloudflare((call) => {
      if (call.path.includes("page=1&")) return ok(firstPage, { page: 1, total_pages: 2 });
      return ok([workerRule("rule-late", "test@example.com")], { page: 2, total_pages: 2 });
    });
    const result = await createRoutingClient({ apiToken: "token", fetcher }).ensureWorkerRoute({ ...input, zoneId: "zone-1" });
    expect(result.status).toBe("existing");
    expect(calls).toHaveLength(2);
  });

  it("refuses to override a rule that delivers somewhere else", async () => {
    const forward = {
      id: "rule-f",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "test@example.com" }],
      actions: [{ type: "forward", value: ["someone@elsewhere.com"] }],
    };
    const disabled = { ...workerRule("rule-d", "test@example.com"), enabled: false };
    for (const rule of [forward, disabled, workerRule("rule-o", "test@example.com", "other-worker")]) {
      const { calls, fetcher } = fakeCloudflare(() => ok([rule], { page: 1, total_pages: 1 }));
      await expect(
        createRoutingClient({ apiToken: "token", fetcher }).ensureWorkerRoute({ ...input, zoneId: "zone-1" }),
      ).rejects.toBeInstanceOf(RoutingConflictError);
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    }
  });

  it("reports Cloudflare errors and missing zones", async () => {
    const denied = fakeCloudflare(() => ({ status: 403, body: { success: false, errors: [{ message: "Authentication error" }], result: null } }));
    await expect(createRoutingClient({ apiToken: "token", fetcher: denied.fetcher }).ensureWorkerRoute(input))
      .rejects.toThrow(new CloudflareApiError("Cloudflare API error (403): Authentication error"));

    const missing = fakeCloudflare(() => ok([]));
    await expect(createRoutingClient({ apiToken: "token", fetcher: missing.fetcher }).ensureWorkerRoute(input))
      .rejects.toThrow("example.com is not a Cloudflare zone the API token can access");
  });

  it("deletes a rule by ID", async () => {
    const { calls, fetcher } = fakeCloudflare(() => ok({ id: "rule-1" }));
    await createRoutingClient({ apiToken: "token", fetcher }).deleteRule("zone-1", "rule-1");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /zones/zone-1/email/routing/rules/rule-1"]);
  });
});
