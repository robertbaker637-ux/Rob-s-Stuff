import { describe, expect, it } from "vitest";
import { Products } from "plaid";
import { buildLinkTokenRequest } from "@/lib/plaid/linkToken";

describe("buildLinkTokenRequest", () => {
  it("requests the full ~24 months of transaction history instead of Plaid's 90-day default", () => {
    const request = buildLinkTokenRequest({ userId: "user-1" });
    expect(request.transactions?.days_requested).toBe(730);
  });

  it("includes transactions in the requested products", () => {
    const request = buildLinkTokenRequest({ userId: "user-1" });
    expect(request.products).toContain(Products.Transactions);
  });
});
