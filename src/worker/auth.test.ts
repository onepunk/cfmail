import { describe, expect, it } from "vitest";
import { accessLoginUrl, identityFromPayload, isAllowedAccessEmail, normalizeTeamDomain } from "./auth";

describe("Cloudflare Access authentication", () => {
  it("normalizes only Cloudflare Access team domains", () => {
    expect(normalizeTeamDomain("https://your-team.cloudflareaccess.com/")).toBe("your-team.cloudflareaccess.com");
    expect(normalizeTeamDomain("example.com")).toBeNull();
  });

  it("allows only the configured email address", () => {
    expect(isAllowedAccessEmail("Admin@Example.com", "admin@example.com")).toBe(true);
    expect(isAllowedAccessEmail("someone@example.com", "admin@example.com")).toBe(false);
    expect(identityFromPayload({ email: "admin@example.com", sub: "user-1", exp: 1234 }, "admin@example.com")).toEqual({
      email: "admin@example.com",
      subject: "user-1",
      expiresAt: 1234,
    });
    expect(identityFromPayload({ email: "someone@example.com", sub: "user-2", exp: 1234 }, "admin@example.com")).toBeNull();
  });

  it("builds a same-origin Access login URL", () => {
    expect(accessLoginUrl("https://mail.example.com/inbox?q=hello")).toBe(
      "/cdn-cgi/access/login?redirect_url=https%3A%2F%2Fmail.example.com%2Finbox%3Fq%3Dhello",
    );
  });
});
