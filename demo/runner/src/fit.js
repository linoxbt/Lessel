// Verifies the Forge Invocation Token (FIT) Jira sends as `Authorization: Bearer <FIT>`.
// Issuer "forge/invocation-token", audience "ari:cloud:ecosystem::app/<app id>".
// JWKS URL: Forge's published key set [verify against the "Verifying remote requests" page].

import { createRemoteJWKSet, jwtVerify } from "jose";

export const DEFAULT_JWKS_URL = "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json";

export function makeVerifier({ appId, jwksUrl = DEFAULT_JWKS_URL, keySet = null }) {
  if (!appId) throw new Error("FORGE_APP_ID is required to verify Forge Invocation Tokens");
  const audience = appId.startsWith("ari:") ? appId : `ari:cloud:ecosystem::app/${appId}`;
  const keys = keySet ?? createRemoteJWKSet(new URL(jwksUrl));
  return async function verify(authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!m) throw new Error("missing bearer token");
    const { payload } = await jwtVerify(m[1], keys, { issuer: "forge/invocation-token", audience });
    return {
      appId: payload.app?.id ?? null,
      installationId: payload.app?.installation?.id ?? null,
      cloudId: payload.context?.cloudId ?? payload.app?.installation?.cloudId ?? null,
      apiBaseUrl: payload.app?.apiBaseUrl ?? null,
      claims: payload,
    };
  };
}

/** Jira REST base for callbacks: the FIT's apiBaseUrl, else the cloud-id route on api.atlassian.com. */
export function jiraBase(fit) {
  if (fit?.apiBaseUrl) return fit.apiBaseUrl.replace(/\/$/, "");
  if (fit?.cloudId) return `https://api.atlassian.com/ex/jira/${fit.cloudId}`;
  return null;
}
