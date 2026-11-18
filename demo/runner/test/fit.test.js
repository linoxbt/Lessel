import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { makeVerifier, jiraBase } from "../src/fit.js";

const APP = "11111111-2222-3333-4444-555555555555";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims, { iss = "forge/invocation-token", aud = `ari:cloud:ecosystem::app/${APP}`, exp = "5m" } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(iss).setAudience(aud)
      .setIssuedAt().setExpirationTime(exp).sign(privateKey);
  return { verify: makeVerifier({ appId: APP, keySet }), sign };
}

test("accepts a valid FIT and exposes the cloud id", async () => {
  const { verify, sign } = await setup();
  const fit = await verify(`Bearer ${await sign({ app: { id: APP, installation: { id: "inst" } }, context: { cloudId: "cloud-1" } })}`);
  assert.equal(fit.cloudId, "cloud-1");
  assert.equal(jiraBase(fit), "https://api.atlassian.com/ex/jira/cloud-1");
  assert.equal(jiraBase({ apiBaseUrl: "https://api.atlassian.com/ex/jira/x/" }), "https://api.atlassian.com/ex/jira/x");
});

test("rejects wrong audience, wrong issuer, expired and missing tokens", async () => {
  const { verify, sign } = await setup();
  await assert.rejects(verify(`Bearer ${await sign({}, { aud: "ari:cloud:ecosystem::app/other" })}`));
  await assert.rejects(verify(`Bearer ${await sign({}, { iss: "someone-else" })}`));
  await assert.rejects(verify(`Bearer ${await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })}`));
  await assert.rejects(verify(undefined), /missing bearer token/);
});
