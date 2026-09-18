// Plaid webhook JWT verification tests (rv2.5).
//
// Mints REAL jose-signed JWTs against a real P-256 keypair generated with
// Node's own crypto — no mocking of the crypto itself. Only the network
// fetch (fetchJwk / fetchPlaidJwk) is mocked, since there's no live Plaid
// project to call /webhook_verification_key/get against.

import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "crypto";
import { SignJWT, exportJWK, importJWK } from "jose";
import {
  createJwkCache,
  isJwkFresh,
  verifyPlaidWebhook,
  type JwkKey,
} from "@/lib/plaid/webhookVerification";

// ============================================================================
// Key/JWT fixtures
// ============================================================================

interface RawEcJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
}

async function generateEcKeyPair(): Promise<{ publicJwk: RawEcJwk; privateJwk: RawEcJwk }> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = (await exportJWK(publicKey)) as RawEcJwk;
  const privateJwk = (await exportJWK(privateKey)) as RawEcJwk;
  return { publicJwk, privateJwk };
}

function toJwkKey(publicJwk: RawEcJwk, kid: string, overrides: Partial<JwkKey> = {}): JwkKey {
  return {
    kid,
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
    use: "sig",
    alg: "ES256",
    expired_at: null,
    ...overrides,
  };
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

async function signWebhookJwt(
  privateJwk: RawEcJwk,
  kid: string,
  opts: {
    rawBody: string;
    iatSeconds: number;
    requestBodySha256Override?: string;
  }
): Promise<string> {
  const key = await importJWK(privateJwk, "ES256");
  return new SignJWT({
    request_body_sha256: opts.requestBodySha256Override ?? sha256Hex(opts.rawBody),
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt(opts.iatSeconds)
    .sign(key);
}

const RAW_BODY = JSON.stringify({
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "item-1",
});
const NOW_SECONDS = 1_700_000_000;

// ============================================================================
// isJwkFresh
// ============================================================================

describe("isJwkFresh", () => {
  const base: JwkKey = { kid: "k", kty: "EC", crv: "P-256", x: "x", y: "y", expired_at: null };

  it("a key with expired_at: null is always fresh", () => {
    expect(isJwkFresh(base, 9_999_999_999)).toBe(true);
  });

  it("a key with expired_at in the future is fresh", () => {
    expect(isJwkFresh({ ...base, expired_at: 2000 }, 1000)).toBe(true);
  });

  it("a key with expired_at in the past is NOT fresh — not treated as expired merely because expired_at is non-null", () => {
    // expired_at set but still in the future must stay fresh (see the
    // test above); only once `now` passes it does freshness flip.
    expect(isJwkFresh({ ...base, expired_at: 1000 }, 2000)).toBe(false);
  });
});

// ============================================================================
// createJwkCache
// ============================================================================

describe("createJwkCache", () => {
  it("reuses a fresh cached JWK — the underlying fetch is called once for two lookups of the same kid", async () => {
    const { publicJwk } = await generateEcKeyPair();
    const jwk = toJwkKey(publicJwk, "kid-cache-1", { expired_at: null });
    const fetchJwk = vi.fn().mockResolvedValue(jwk);
    const cache = createJwkCache(fetchJwk, () => 1000);

    await cache.getJwk("kid-cache-1");
    await cache.getJwk("kid-cache-1");

    expect(fetchJwk).toHaveBeenCalledTimes(1);
  });

  it("a JWK with expired_at in the future is still served from cache, not re-fetched", async () => {
    const { publicJwk } = await generateEcKeyPair();
    const jwk = toJwkKey(publicJwk, "kid-cache-2", { expired_at: 5000 });
    const fetchJwk = vi.fn().mockResolvedValue(jwk);
    const cache = createJwkCache(fetchJwk, () => 1000); // now < expired_at

    await cache.getJwk("kid-cache-2");
    await cache.getJwk("kid-cache-2");

    expect(fetchJwk).toHaveBeenCalledTimes(1);
  });

  it("a JWK with expired_at in the past triggers a re-fetch", async () => {
    const { publicJwk } = await generateEcKeyPair();
    const jwk = toJwkKey(publicJwk, "kid-cache-3", { expired_at: 500 });
    const fetchJwk = vi.fn().mockResolvedValue(jwk);
    const cache = createJwkCache(fetchJwk, () => 1000); // now > expired_at

    await cache.getJwk("kid-cache-3");
    await cache.getJwk("kid-cache-3");

    expect(fetchJwk).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// verifyPlaidWebhook
// ============================================================================

describe("verifyPlaidWebhook", () => {
  it("valid JWT + matching body hash -> valid: true", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "kid-valid";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    const jwk = toJwkKey(publicJwk, kid);

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async (k) => (k === kid ? jwk : undefined),
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: true });
  });

  it("alg not ES256 -> unsupported_algorithm, rejected before any key fetch", async () => {
    const kid = "kid-wrong-alg";
    const secret = new TextEncoder().encode("test-only-secret-at-least-32-bytes-long!!");
    const jwt = await new SignJWT({ request_body_sha256: sha256Hex(RAW_BODY) })
      .setProtectedHeader({ alg: "HS256", kid })
      .setIssuedAt(NOW_SECONDS)
      .sign(secret);

    const getJwk = vi.fn().mockRejectedValue(new Error("must not be called"));
    const result = await verifyPlaidWebhook({ jwt, rawBody: RAW_BODY, getJwk, now: () => NOW_SECONDS });

    expect(result).toEqual({ valid: false, reason: "unsupported_algorithm" });
    expect(getJwk).not.toHaveBeenCalled();
  });

  it("signature invalid when the JWT was signed with a different keypair than getJwk returns -> invalid_signature", async () => {
    const { privateJwk } = await generateEcKeyPair();
    const { publicJwk: otherPublicJwk } = await generateEcKeyPair();
    const kid = "kid-bad-sig";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    const wrongJwk = toJwkKey(otherPublicJwk, kid);

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async () => wrongJwk,
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("stale JWT (iat outside the 5-minute maxTokenAge window) -> stale_jwt", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "kid-stale";
    const issuedAt = NOW_SECONDS;
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: issuedAt });
    const jwk = toJwkKey(publicJwk, kid);

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async () => jwk,
      now: () => issuedAt + 301, // just past the 300-second tolerance
    });

    expect(result).toEqual({ valid: false, reason: "stale_jwt" });
  });

  it("body hash mismatch (equal-length digests) -> body_hash_mismatch", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "kid-hash-mismatch";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    const jwk = toJwkKey(publicJwk, kid);
    const differentRawBody = JSON.stringify({ ...JSON.parse(RAW_BODY), item_id: "item-DIFFERENT" });

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: differentRawBody,
      getJwk: async () => jwk,
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: false, reason: "body_hash_mismatch" });
  });

  it("body hash mismatch (differing-length digests) is rejected directly, without calling timingSafeEqual on mismatched lengths", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "kid-hash-length-mismatch";
    // A claimed digest shorter than a real 32-byte SHA-256 hex digest —
    // exercises the length-check branch, which must reject before ever
    // calling timingSafeEqual (timingSafeEqual throws on unequal lengths
    // rather than returning false).
    const jwt = await signWebhookJwt(privateJwk, kid, {
      rawBody: RAW_BODY,
      iatSeconds: NOW_SECONDS,
      requestBodySha256Override: "abcd",
    });
    const jwk = toJwkKey(publicJwk, kid);

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async () => jwk,
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: false, reason: "body_hash_mismatch" });
  });

  it("unknown key id (getJwk returns undefined) -> unknown_key", async () => {
    const { privateJwk } = await generateEcKeyPair();
    const kid = "kid-unknown";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async () => undefined,
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: false, reason: "unknown_key" });
  });

  it("returned JWK has the wrong kid -> invalid_key, no signature verification attempted", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "kid-expected";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    const jwkWithWrongKid = toJwkKey(publicJwk, "kid-different");

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async () => jwkWithWrongKid,
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: false, reason: "invalid_key" });
  });

  it("returned JWK has the wrong crv -> invalid_key", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "kid-wrong-crv";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    const jwk = toJwkKey(publicJwk, kid, { crv: "P-384" });

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async () => jwk,
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: false, reason: "invalid_key" });
  });

  it("returned JWK has use !== 'sig' -> invalid_key", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "kid-wrong-use";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    const jwk = toJwkKey(publicJwk, kid, { use: "enc" });

    const result = await verifyPlaidWebhook({
      jwt,
      rawBody: RAW_BODY,
      getJwk: async () => jwk,
      now: () => NOW_SECONDS,
    });

    expect(result).toEqual({ valid: false, reason: "invalid_key" });
  });
});
