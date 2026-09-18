import { describe, expect, it } from "vitest";
import {
  applyMerchantMemory,
  correctTransactionCategory,
  normalizeMerchantKey,
} from "@/lib/domain/merchantMemory";
import type { MerchantRule, Transaction } from "@/lib/domain/types";

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    accountId: "acct-checking",
    postedDate: "2026-01-06",
    pending: false,
    amount: 45,
    description: "GROCERY MART #4471",
    isTransfer: false,
    rawDescription: "GROCERY MART #4471",
    rawAmount: 45,
    rawDate: "2026-01-06",
    needsReview: true,
    ...overrides,
  };
}

describe("normalizeMerchantKey", () => {
  it("trims, uppercases, and collapses whitespace", () => {
    expect(normalizeMerchantKey("  grocery   mart  ")).toBe("GROCERY MART");
  });
});

describe("applyMerchantMemory", () => {
  it("auto-categorizes when a rule exists for the merchant's raw-derived key", () => {
    const txn = makeTransaction({ rawMerchantName: "Grocery Mart" });
    const rules: MerchantRule[] = [
      { id: "r1", merchantKey: "GROCERY MART", categoryId: "cat-groceries" },
    ];

    const result = applyMerchantMemory(txn, rules);
    expect(result.categoryId).toBe("cat-groceries");
    expect(result.needsReview).toBe(false);
  });

  it("flags needsReview when no rule matches", () => {
    const txn = makeTransaction({ rawMerchantName: "Unknown Vendor" });
    const result = applyMerchantMemory(txn, []);
    expect(result.categoryId).toBeUndefined();
    expect(result.needsReview).toBe(true);
  });
});

describe("correctTransactionCategory — remembered for future transactions", () => {
  it("a correction is applied via merchant memory to a brand-new transaction from the same merchant", () => {
    const firstVisit = makeTransaction({
      id: "t1",
      rawMerchantName: "Corner Grocer",
      rawDescription: "CORNER GROCER #12",
    });

    const { merchantRules } = correctTransactionCategory(firstVisit, "cat-groceries", []);

    const secondVisit = makeTransaction({
      id: "t2",
      rawMerchantName: "Corner Grocer",
      rawDescription: "CORNER GROCER #12",
      amount: 22,
      rawAmount: 22,
    });

    const categorizedSecondVisit = applyMerchantMemory(secondVisit, merchantRules);
    expect(categorizedSecondVisit.categoryId).toBe("cat-groceries");
    expect(categorizedSecondVisit.needsReview).toBe(false);
  });
});

describe("correctTransactionCategory — does not globally rewrite unrelated merchants", () => {
  it("correcting one merchant leaves another merchant's rule and transactions untouched", () => {
    const existingRules: MerchantRule[] = [
      { id: "r-electric", merchantKey: "ELECTRIC CO", categoryId: "cat-utilities" },
    ];

    const groceryTxn = makeTransaction({
      id: "t-grocery",
      rawMerchantName: "Grocery Mart",
      rawDescription: "GROCERY MART #4471",
    });

    const { merchantRules: rulesAfterCorrection } = correctTransactionCategory(
      groceryTxn,
      "cat-groceries",
      existingRules
    );

    // The unrelated Electric Co rule must be exactly as it was.
    const electricRule = rulesAfterCorrection.find((r) => r.merchantKey === "ELECTRIC CO");
    expect(electricRule).toEqual(existingRules[0]);
    expect(rulesAfterCorrection).toHaveLength(2);

    // An Electric Co transaction still categorizes via its own rule, unaffected.
    const electricTxn = makeTransaction({
      id: "t-electric",
      rawMerchantName: "Electric Co",
      rawDescription: "ELECTRIC CO",
      amount: 50,
      rawAmount: 50,
    });
    const categorized = applyMerchantMemory(electricTxn, rulesAfterCorrection);
    expect(categorized.categoryId).toBe("cat-utilities");
  });

  it("re-teaching one merchant does not retroactively change a DIFFERENT past transaction from that same merchant", () => {
    // Two past visits, both already categorized under the old rule.
    const rules: MerchantRule[] = [
      { id: "r1", merchantKey: "GROCERY MART", categoryId: "cat-groceries" },
    ];
    const pastVisit1 = applyMerchantMemory(
      makeTransaction({ id: "t1", rawMerchantName: "Grocery Mart" }),
      rules
    );
    const pastVisit2 = applyMerchantMemory(
      makeTransaction({ id: "t2", rawMerchantName: "Grocery Mart", amount: 30, rawAmount: 30 }),
      rules
    );

    // Re-teach the merchant via a correction on visit 1 only.
    const { merchantRules: newRules } = correctTransactionCategory(
      pastVisit1,
      "cat-household",
      rules
    );

    // visit2's OWN record is untouched by the correction call (the
    // correction only returns an updated copy of the transaction passed
    // to it) — re-teaching updates future matching, not past records.
    expect(pastVisit2.categoryId).toBe("cat-groceries");
    // The new rule is in place for anything categorized from here on.
    expect(newRules.find((r) => r.merchantKey === "GROCERY MART")?.categoryId).toBe("cat-household");
  });
});

describe("raw source fields are never overwritten", () => {
  it("survives a merchant memory application and a category correction unchanged", () => {
    const original = makeTransaction({
      rawMerchantName: "Grocery Mart",
      rawDescription: "GROCERY MART #4471",
      rawAmount: 45,
      rawDate: "2026-01-06",
      rawCategory: "FOOD_AND_DRINK",
    });

    const afterMemory = applyMerchantMemory(original, [
      { id: "r1", merchantKey: "GROCERY MART", categoryId: "cat-groceries" },
    ]);
    expect(afterMemory.rawMerchantName).toBe("Grocery Mart");
    expect(afterMemory.rawDescription).toBe("GROCERY MART #4471");
    expect(afterMemory.rawAmount).toBe(45);
    expect(afterMemory.rawDate).toBe("2026-01-06");
    expect(afterMemory.rawCategory).toBe("FOOD_AND_DRINK");

    const { transaction: afterCorrection } = correctTransactionCategory(
      afterMemory,
      "cat-household",
      []
    );
    expect(afterCorrection.rawMerchantName).toBe("Grocery Mart");
    expect(afterCorrection.rawDescription).toBe("GROCERY MART #4471");
    expect(afterCorrection.rawAmount).toBe(45);
    expect(afterCorrection.rawDate).toBe("2026-01-06");
    expect(afterCorrection.rawCategory).toBe("FOOD_AND_DRINK");
    // Only the normalized/corrected side changed.
    expect(afterCorrection.categoryId).toBe("cat-household");
  });
});

describe("merchant key derivation ignores display-name corrections", () => {
  it("a later normalizedMerchantName is never used to derive the lookup key", () => {
    const txn = makeTransaction({
      rawMerchantName: "GROCERY MART #4471",
      normalizedMerchantName: "Grocery Mart (renamed by user)",
    });
    const rules: MerchantRule[] = [
      { id: "r1", merchantKey: "GROCERY MART #4471", categoryId: "cat-groceries" },
    ];

    // If the key were derived from normalizedMerchantName, this would
    // fail to match (different normalized string, no rule for it).
    const result = applyMerchantMemory(txn, rules);
    expect(result.categoryId).toBe("cat-groceries");
    expect(result.needsReview).toBe(false);
  });
});
