// Plaid webhook JWT verification (rv2.5).
//
// Uses `jose` (audited JWT/JWK library) for protected-header decoding, JWK
// import, ES256 signature verification, algorithm restriction, and
// issued-at/max-age validation. The raw-body SHA-256 check is Plaid's own
// requirement (not something jose knows about) and stays separate and
// explicit, compared in constant time.
//
// Nothing in this module ever logs the JWT, the raw body, or key
// material — only the fixed `reason` string on a failed result is safe to
// log.

import { createHash, timingSafeEqual } from "crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, errors as joseErrors } from "jose";

/** Mirrors Plaid's real WebhookVerificationKeyGetResponse.key shape
 * (JWKPublicKey in the Plaid SDK) — kept as our own type rather than
 * importing the SDK's, so this module (and its tests) don't need a live
 * Plaid client. `use`/`alg` are optional here even though Plaid's SDK
 * types them as always-present, so validateJwkForRequest can still guard
 * a hand-built or third-party JWK that omits them. */
export interface JwkKey {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  y: string;
  use?: string;
  alg?: string;
  /** Unix seconds, or null if the key has never expired. */
  expired_at: number | null;
}

const defaultNow = () => Math.floor(Date.now() / 1000);

/** A JWK is fresh if it has no expiry, or its expiry is still in the
 * future relative to `now` (Unix seconds) — never "expired just because
 * expired_at is non-null." */
export function isJwkFresh(jwk: JwkKey, now: number): boolean {
  return jwk.expired_at === null || now < jwk.expired_at;
}

/** A fetched JWK is only trustworthy for THIS request if it actually
 * matches what we asked for and looks like a Plaid ES256/P-256 signing
 * key. Any mismatch means "don't attempt verification with this key." */
export function validateJwkForRequest(jwk: JwkKey, expectedKid: string): boolean {
  if (jwk.kid !== expectedKid) return false;
  if (jwk.kty !== "EC") return false;
  if (jwk.crv !== "P-256") return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (jwk.alg !== undefined && jwk.alg !== "ES256") return false;
  return true;
}

export interface JwkCache {
  getJwk(kid: string): Promise<JwkKey | undefined>;
}

/** Memoized-by-kid JWK lookup. A cached entry is reused only while it's
 * still fresh (per isJwkFresh); otherwise it's re-fetched. */
export function createJwkCache(
  fetchJwk: (kid: string) => Promise<JwkKey | undefined>,
  now: () => number = defaultNow
): JwkCache {
  const cache = new Map<string, JwkKey>();

  return {
    async getJwk(kid: string): Promise<JwkKey | undefined> {
      const cached = cache.get(kid);
      if (cached && isJwkFresh(cached, now())) {
        return cached;
      }
      const fetched = await fetchJwk(kid);
      if (fetched) {
        cache.set(kid, fetched);
      }
      return fetched;
    },
  };
}

/** Converts two hex digests to equal-length buffers and compares them in
 * constant time. A length mismatch is rejected directly, without calling
 * timingSafeEqual — it throws on mismatched-length buffers rather than
 * returning false. */
function hexDigestsMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface VerifyPlaidWebhookInput {
  jwt: string;
  rawBody: string;
  getJwk: (kid: string) => Promise<JwkKey | undefined>;
  /** Unix seconds. Defaults to the real clock; tests inject their own. */
  now?: () => number;
}

export interface VerifyPlaidWebhookResult {
  valid: boolean;
  reason?: string;
}

export async function verifyPlaidWebhook({
  jwt,
  rawBody,
  getJwk,
  now = defaultNow,
}: VerifyPlaidWebhookInput): Promise<VerifyPlaidWebhookResult> {
  let header;
  try {
    header = decodeProtectedHeader(jwt);
  } catch {
    return { valid: false, reason: "invalid_jwt" };
  }

  if (header.alg !== "ES256") {
    return { valid: false, reason: "unsupported_algorithm" };
  }
  if (!header.kid) {
    return { valid: false, reason: "invalid_jwt" };
  }

  const jwk = await getJwk(header.kid);
  if (!jwk) {
    return { valid: false, reason: "unknown_key" };
  }

  if (!validateJwkForRequest(jwk, header.kid)) {
    return { valid: false, reason: "invalid_key" };
  }

  let requestBodySha256: unknown;
  try {
    const key = await importJWK(jwk, "ES256");
    const { payload } = await jwtVerify(jwt, key, {
      algorithms: ["ES256"],
      maxTokenAge: 300, // Plaid's documented 5-minute issued-at tolerance
      currentDate: new Date(now() * 1000),
    });
    requestBodySha256 = payload.request_body_sha256;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { valid: false, reason: "stale_jwt" };
    }
    return { valid: false, reason: "invalid_signature" };
  }

  if (typeof requestBodySha256 !== "string") {
    return { valid: false, reason: "invalid_jwt" };
  }

  const actualHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
  if (!hexDigestsMatch(requestBodySha256, actualHash)) {
    return { valid: false, reason: "body_hash_mismatch" };
  }

  return { valid: true };
}
