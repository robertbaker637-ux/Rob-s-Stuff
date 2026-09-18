// Route-level test for the /api/plaid/webhook POST handler (rv2.5).
//
// Proves the "zero downstream calls on verification failure" security
// property structurally: every existing persistence dependency
// (getItemByPlaidItemId, runSync's inputs, markHistoricalPullComplete)
// must never be invoked when webhook verification fails, for any of the
// failure reasons covered unit-by-unit in webhookVerification.test.ts.
//
// Only the network-touching pieces are mocked (persistence.ts's Supabase
// calls, syncAdapters.ts's fetchPlaidJwk/createPlaidFetchPage) — the real
// verifyPlaidWebhook/jose signature verification runs unmodified.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "crypto";
import { SignJWT, exportJWK, importJWK } from "jose";
import { NextRequest } from "next/server";
import type { JwkKey } from "@/lib/plaid/webhookVerification";

vi.mock("@/lib/plaid/syncAdapters", () => ({
  createPlaidFetchPage: vi.fn(),
  fetchPlaidJwk: vi.fn(),
  mapLiabilitiesResponseToLiabilityData: vi.fn(),
}));

vi.mock("@/lib/plaid/persistence", () => ({
  getItemByPlaidItemId: vi.fn(),
  getPlaidItemAccessToken: vi.fn(),
  loadAccountIdByPlaidAccountId: vi.fn(),
  loadMerchantRules: vi.fn(),
  loadUserTransactions: vi.fn(),
  markHistoricalPullComplete: vi.fn(),
  persistTransactions: vi.fn(),
  updateItemCursor: vi.fn(),
  insertPlaidItem: vi.fn(),
  persistAccounts: vi.fn(),
  persistDebts: vi.fn(),
}));

const { POST } = await import("@/app/api/plaid/webhook/route");
const persistence = await import("@/lib/plaid/persistence");
const syncAdapters = await import("@/lib/plaid/syncAdapters");

function assertNoDownstreamCalls() {
  expect(persistence.getItemByPlaidItemId).not.toHaveBeenCalled();
  expect(persistence.getPlaidItemAccessToken).not.toHaveBeenCalled();
  expect(persistence.loadAccountIdByPlaidAccountId).not.toHaveBeenCalled();
  expect(persistence.loadMerchantRules).not.toHaveBeenCalled();
  expect(persistence.loadUserTransactions).not.toHaveBeenCalled();
  expect(persistence.markHistoricalPullComplete).not.toHaveBeenCalled();
  expect(persistence.persistTransactions).not.toHaveBeenCalled();
  expect(persistence.updateItemCursor).not.toHaveBeenCalled();
}

function makeRequest(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/plaid/webhook", {
    method: "POST",
    body,
    headers,
  });
}

interface RawEcJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
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
  opts: { rawBody: string; iatSeconds: number }
): Promise<string> {
  const key = await importJWK(privateJwk, "ES256");
  return new SignJWT({ request_body_sha256: sha256Hex(opts.rawBody) })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt(opts.iatSeconds)
    .sign(key);
}

const RAW_BODY = JSON.stringify({
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "item-1",
});
// The route (unlike the injectable-clock unit tests in
// webhookVerification.test.ts) always verifies against the real clock —
// it never passes a `now` override to verifyPlaidWebhook. So JWTs here
// must be issued against the actual current time, not an arbitrary fixed
// timestamp, or they'd appear stale regardless of what's being tested.
const NOW_SECONDS = Math.floor(Date.now() / 1000);

describe("POST /api/plaid/webhook — zero downstream calls on verification failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("missing Plaid-Verification header -> 401, zero downstream calls", async () => {
    const response = await POST(makeRequest(RAW_BODY));

    expect(response.status).toBe(401);
    assertNoDownstreamCalls();
  });

  it("unknown key id -> 401, zero downstream calls", async () => {
    vi.mocked(syncAdapters.fetchPlaidJwk).mockResolvedValueOnce(undefined);
    const { privateJwk } = await generateEcKeyPair();
    const kid = "route-kid-unknown";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });

    const response = await POST(makeRequest(RAW_BODY, { "Plaid-Verification": jwt }));

    expect(response.status).toBe(401);
    assertNoDownstreamCalls();
  });

  it("invalid signature (JWK returned doesn't match the signing key) -> 401, zero downstream calls", async () => {
    const { privateJwk } = await generateEcKeyPair();
    const { publicJwk: otherPublicJwk } = await generateEcKeyPair();
    const kid = "route-kid-bad-sig";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    vi.mocked(syncAdapters.fetchPlaidJwk).mockResolvedValueOnce(toJwkKey(otherPublicJwk, kid));

    const response = await POST(makeRequest(RAW_BODY, { "Plaid-Verification": jwt }));

    expect(response.status).toBe(401);
    assertNoDownstreamCalls();
  });

  it("stale JWT -> 401, zero downstream calls", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "route-kid-stale";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS - 1000 });
    vi.mocked(syncAdapters.fetchPlaidJwk).mockResolvedValueOnce(toJwkKey(publicJwk, kid));

    const response = await POST(makeRequest(RAW_BODY, { "Plaid-Verification": jwt }));

    expect(response.status).toBe(401);
    assertNoDownstreamCalls();
  });

  it("body hash mismatch (tampered body after signing) -> 401, zero downstream calls", async () => {
    const { publicJwk, privateJwk } = await generateEcKeyPair();
    const kid = "route-kid-tampered";
    const jwt = await signWebhookJwt(privateJwk, kid, { rawBody: RAW_BODY, iatSeconds: NOW_SECONDS });
    vi.mocked(syncAdapters.fetchPlaidJwk).mockResolvedValueOnce(toJwkKey(publicJwk, kid));
    const tamperedBody = JSON.stringify({ ...JSON.parse(RAW_BODY), item_id: "item-TAMPERED" });

    const response = await POST(makeRequest(tamperedBody, { "Plaid-Verification": jwt }));

    expect(response.status).toBe(401);
    assertNoDownstreamCalls();
  });

  it("wrong alg (HS256) -> 401, zero downstream calls, and the key fetch is never even attempted", async () => {
    const kid = "route-kid-wrong-alg";
    const secret = new TextEncoder().encode("test-only-secret-at-least-32-bytes-long!!");
    const jwt = await new SignJWT({ request_body_sha256: sha256Hex(RAW_BODY) })
      .setProtectedHeader({ alg: "HS256", kid })
      .setIssuedAt(NOW_SECONDS)
      .sign(secret);

    const response = await POST(makeRequest(RAW_BODY, { "Plaid-Verification": jwt }));

    expect(response.status).toBe(401);
    expect(syncAdapters.fetchPlaidJwk).not.toHaveBeenCalled();
    assertNoDownstreamCalls();
  });
});
