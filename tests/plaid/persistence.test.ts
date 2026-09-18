// toTransactionRow/fromTransactionRow are pure mapping functions (no
// Supabase client is instantiated at module scope in persistence.ts —
// createServiceRoleClient() is only ever called inside the other
// functions), so this round trip is directly unit-testable without a
// live database. Exported specifically for this purpose — see the
// rv2.6 planning doc's §1.
import { describe, expect, it } from "vitest";
import { fromTransactionRow, toTransactionRow } from "@/lib/plaid/persistence";
import type { Transaction } from "@/lib/domain/types";

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn-1",
    accountId: "acct-checking",
    postedDate: "2026-01-05",
    pending: false,
    amount: 42.5,
    description: "Coffee Shop",
    isTransfer: false,
    rawDescription: "COFFEE SHOP #4",
    rawAmount: 42.5,
    rawDate: "2026-01-05",
    needsReview: false,
    ...overrides,
  };
}

describe("toTransactionRow / fromTransactionRow — firstSeenAt/firstPostedAt round-trip", () => {
  it("a posted transaction with both fields set survives the round trip exactly", () => {
    const t = transaction({
      firstSeenAt: "2026-01-05T09:00:00.000Z",
      firstPostedAt: "2026-01-05T09:00:00.000Z",
    });
    const row = toTransactionRow("user-1", t);
    expect(row.first_seen_at).toBe("2026-01-05T09:00:00.000Z");
    expect(row.first_posted_at).toBe("2026-01-05T09:00:00.000Z");

    const roundTripped = fromTransactionRow(row as unknown as Record<string, unknown>);
    expect(roundTripped.firstSeenAt).toBe(t.firstSeenAt);
    expect(roundTripped.firstPostedAt).toBe(t.firstPostedAt);
  });

  it("a still-pending transaction has firstSeenAt but no firstPostedAt, and that absence survives the round trip", () => {
    const t = transaction({ pending: true, firstSeenAt: "2026-01-05T09:00:00.000Z", firstPostedAt: undefined });
    const row = toTransactionRow("user-1", t);
    expect(row.first_seen_at).toBe("2026-01-05T09:00:00.000Z");
    expect(row.first_posted_at).toBeNull();

    const roundTripped = fromTransactionRow(row as unknown as Record<string, unknown>);
    expect(roundTripped.firstSeenAt).toBe("2026-01-05T09:00:00.000Z");
    expect(roundTripped.firstPostedAt).toBeUndefined();
  });

  it("a legacy transaction with neither field maps to null in the row and undefined on read-back — never fabricated", () => {
    const t = transaction({ firstSeenAt: undefined, firstPostedAt: undefined });
    const row = toTransactionRow("user-1", t);
    expect(row.first_seen_at).toBeNull();
    expect(row.first_posted_at).toBeNull();

    const roundTripped = fromTransactionRow(row as unknown as Record<string, unknown>);
    expect(roundTripped.firstSeenAt).toBeUndefined();
    expect(roundTripped.firstPostedAt).toBeUndefined();
  });
});
