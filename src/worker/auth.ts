import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AccessIdentity {
  email: string;
  subject: string;
  expiresAt: number;
}

const jwksResolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function normalizeTeamDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain)) return null;
  return domain;
}

export function isAllowedAccessEmail(email: unknown, allowedEmail: string): email is string {
  return typeof email === "string" && email.trim().toLowerCase() === allowedEmail.trim().toLowerCase();
}

export async function authenticateAccessRequest(request: Request, env: Env): Promise<AccessIdentity | null> {
  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (!teamDomain || !env.CF_ACCESS_AUD) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  try {
    const issuer = `https://${teamDomain}`;
    let jwks = jwksResolvers.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksResolvers.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: env.CF_ACCESS_AUD,
    });
    return identityFromPayload(payload, env.CFMAIL_ALLOWED_USER);
  } catch (error) {
    console.warn(JSON.stringify({
      message: "Access token validation failed",
      error: error instanceof Error ? error.message : "unknown",
    }));
    return null;
  }
}

export function identityFromPayload(payload: JWTPayload, allowedEmail: string): AccessIdentity | null {
  if (!isAllowedAccessEmail(payload.email, allowedEmail) || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  return {
    email: payload.email.trim().toLowerCase(),
    subject: payload.sub,
    expiresAt: payload.exp,
  };
}

export function accessLoginUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const redirect = `${url.origin}${url.pathname}${url.search}`;
  return `/cdn-cgi/access/login?redirect_url=${encodeURIComponent(redirect)}`;
}
