// mapLiabilitiesResponseToLiabilityData tests (rv2.5) — the null
// account_id handling correction. Credit-card and student-loan liability
// records can come back from Plaid with account_id: null; such records
// must be skipped (never given a synthesized/fallback identity) while
// valid records in the same response still map normally.

import { describe, expect, it } from "vitest";
import { mapLiabilitiesResponseToLiabilityData } from "@/lib/plaid/syncAdapters";
import type { LiabilitiesGetResponse } from "plaid";

function makeResponse(overrides: {
  accounts?: Array<{ account_id: string; name: string; current: number | null }>;
  credit?: Array<Record<string, unknown>>;
  mortgage?: Array<Record<string, unknown>>;
  student?: Array<Record<string, unknown>>;
}): LiabilitiesGetResponse {
  const accounts = (overrides.accounts ?? []).map((a) => ({
    account_id: a.account_id,
    name: a.name,
    balances: { current: a.current, available: null, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
    mask: null,
    official_name: null,
    type: "credit",
    subtype: null,
  }));

  return {
    accounts,
    item: {},
    liabilities: {
      credit: overrides.credit ?? [],
      mortgage: overrides.mortgage ?? [],
      student: overrides.student ?? [],
    },
    request_id: "req-1",
  } as unknown as LiabilitiesGetResponse;
}

function creditRecord(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "plaid-acct-cc-1",
    aprs: [{ apr_type: "purchase_apr", apr_percentage: 18.5, balance_subject_to_apr: null, interest_charge_amount: null }],
    is_overdue: null,
    last_payment_amount: null,
    last_payment_date: null,
    last_statement_issue_date: null,
    last_statement_balance: null,
    minimum_payment_amount: null,
    next_payment_due_date: null,
    ...overrides,
  };
}

function studentRecord(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "plaid-acct-loan-1",
    interest_rate_percentage: 4.5,
    is_overdue: null,
    minimum_payment_amount: null,
    next_payment_due_date: null,
    ...overrides,
  };
}

function mortgageRecord(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "plaid-acct-mortgage-1",
    interest_rate: { percentage: 6.25, type: "fixed" },
    next_monthly_payment: null,
    next_payment_due_date: null,
    past_due_amount: null,
    ...overrides,
  };
}

describe("mapLiabilitiesResponseToLiabilityData — null account_id handling (rv2.5)", () => {
  it("a credit-card liability with account_id: null is not mapped into a Debt — skipped instead", () => {
    const response = makeResponse({
      accounts: [{ account_id: "plaid-acct-cc-1", name: "Store Card", current: 500 }],
      credit: [creditRecord({ account_id: null })],
    });

    const { liabilities, skipped } = mapLiabilitiesResponseToLiabilityData(response);

    expect(liabilities).toHaveLength(0);
    expect(skipped).toEqual([{ kind: "credit_card", reason: "missing_account_id" }]);
  });

  it("a student-loan liability with account_id: null is not mapped into a Debt — skipped instead", () => {
    const response = makeResponse({
      accounts: [{ account_id: "plaid-acct-loan-1", name: "Federal Loan", current: 15000 }],
      student: [studentRecord({ account_id: null })],
    });

    const { liabilities, skipped } = mapLiabilitiesResponseToLiabilityData(response);

    expect(liabilities).toHaveLength(0);
    expect(skipped).toEqual([{ kind: "student_loan", reason: "missing_account_id" }]);
  });

  it("other valid records in the same response still map normally — one bad record doesn't drop the whole batch", () => {
    const response = makeResponse({
      accounts: [
        { account_id: "plaid-acct-cc-1", name: "Store Card", current: 500 },
        { account_id: "plaid-acct-cc-valid", name: "Valid Card", current: 300 },
        { account_id: "plaid-acct-mortgage-1", name: "Home Mortgage", current: 250000 },
        { account_id: "plaid-acct-loan-valid", name: "Valid Loan", current: 8000 },
      ],
      credit: [creditRecord({ account_id: null }), creditRecord({ account_id: "plaid-acct-cc-valid" })],
      mortgage: [mortgageRecord()],
      student: [studentRecord({ account_id: "plaid-acct-loan-valid" })],
    });

    const { liabilities, skipped } = mapLiabilitiesResponseToLiabilityData(response);

    expect(skipped).toEqual([{ kind: "credit_card", reason: "missing_account_id" }]);
    expect(liabilities).toHaveLength(3);
    expect(liabilities.map((l) => l.plaidAccountId).sort()).toEqual(
      ["plaid-acct-cc-valid", "plaid-acct-loan-valid", "plaid-acct-mortgage-1"].sort()
    );
    // No synthesized/fallback identity ever appears for the skipped
    // credit-card record — its kind is entirely absent from the mapped
    // liabilities, not present with some placeholder id.
    expect(liabilities.filter((l) => l.kind === "credit_card")).toHaveLength(1);
    expect(liabilities.find((l) => l.kind === "credit_card")?.plaidAccountId).toBe("plaid-acct-cc-valid");
  });

  it("mortgage liabilities always have a non-null account_id per the Plaid SDK, so none are ever skipped", () => {
    const response = makeResponse({
      accounts: [{ account_id: "plaid-acct-mortgage-1", name: "Home Mortgage", current: 250000 }],
      mortgage: [mortgageRecord()],
    });

    const { liabilities, skipped } = mapLiabilitiesResponseToLiabilityData(response);

    expect(skipped).toHaveLength(0);
    expect(liabilities).toHaveLength(1);
    expect(liabilities[0].kind).toBe("mortgage");
  });
});
