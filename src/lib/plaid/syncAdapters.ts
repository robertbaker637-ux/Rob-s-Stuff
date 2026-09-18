// Glue between the pure sync orchestration and the real Plaid SDK
// (rv2.4). This is the ONLY place an access token is read from and used
// — it's captured in this closure and never returned, logged, or stored
// anywhere else. See src/lib/plaid/errors.ts for how failures from these
// calls get sanitized before logging.
//
// Also the one place (rv2.5) allowed to import Plaid's real liability and
// JWK types and translate them into this app's own shapes — every other
// module works only with PlaidLiabilityData/JwkKey, never the raw Plaid
// SDK types.

import type {
  APR,
  CreditCardLiability,
  LiabilitiesGetResponse,
  MortgageLiability,
  StudentLoan,
  Transaction as PlaidApiTransaction,
} from "plaid";
import { plaidClient } from "./client";
import type { FetchSyncPage, PlaidSyncPage } from "./syncOrchestration";
import type { JwkKey } from "./webhookVerification";
import type { PlaidAprEntry, PlaidLiabilityData, PlaidTransactionData, SkippedLiability } from "@/lib/domain/types";

function toPlaidTransactionData(t: PlaidApiTransaction): PlaidTransactionData {
  return {
    transactionId: t.transaction_id,
    pendingTransactionId: t.pending_transaction_id ?? undefined,
    plaidAccountId: t.account_id,
    amount: t.amount,
    date: t.date,
    pending: t.pending,
    merchantName: t.merchant_name ?? undefined,
    name: t.name,
    category: t.category ?? undefined,
  };
}

/** Builds a FetchSyncPage bound to one Item's access token, for
 * fetchCompletePlaidSyncBatch/runPlaidTransactionsSync. The access token
 * lives only in this closure. */
export function createPlaidFetchPage(accessToken: string): FetchSyncPage {
  return async (cursor: string): Promise<PlaidSyncPage> => {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
    });
    const data = response.data;
    return {
      added: data.added.map(toPlaidTransactionData),
      modified: data.modified.map(toPlaidTransactionData),
      removed: data.removed
        .filter((r) => r.transaction_id)
        .map((r) => ({ transactionId: r.transaction_id! })),
      nextCursor: data.next_cursor,
      hasMore: data.has_more,
    };
  };
}

// ============================================================================
// Liability mapping (rv2.5)
// ============================================================================

function mapAprEntry(apr: APR): PlaidAprEntry {
  return {
    aprType: apr.apr_type,
    aprPercentage: apr.apr_percentage,
    balanceSubjectToApr: apr.balance_subject_to_apr ?? undefined,
    interestChargeAmount: apr.interest_charge_amount ?? undefined,
  };
}

function mapCreditCardLiability(
  liability: CreditCardLiability,
  accountNameById: Map<string, string>,
  balanceByAccountId: Map<string, number>
): PlaidLiabilityData {
  const accountId = liability.account_id!; // caller has already filtered out null account_id
  return {
    kind: "credit_card",
    plaidAccountId: accountId,
    currentBalance: balanceByAccountId.get(accountId) ?? 0,
    isOverdue: liability.is_overdue ?? undefined,
    accountName: accountNameById.get(accountId),
    aprs: liability.aprs.map(mapAprEntry),
    minimumPaymentAmount: liability.minimum_payment_amount ?? undefined,
    lastPaymentAmount: liability.last_payment_amount ?? undefined,
    lastPaymentDate: liability.last_payment_date ?? undefined,
  };
}

function mapMortgageLiability(
  liability: MortgageLiability,
  accountNameById: Map<string, string>,
  balanceByAccountId: Map<string, number>
): PlaidLiabilityData {
  // MortgageLiability.account_id is always a non-null string per the
  // Plaid SDK — unlike credit-card/student-loan, there is no null case.
  const accountId = liability.account_id;
  return {
    kind: "mortgage",
    plaidAccountId: accountId,
    currentBalance: balanceByAccountId.get(accountId) ?? 0,
    accountName: accountNameById.get(accountId),
    interestRatePercentage: liability.interest_rate.percentage ?? undefined,
    nextMonthlyPayment: liability.next_monthly_payment ?? undefined,
    nextPaymentDueDate: liability.next_payment_due_date ?? undefined,
    // Plaid has no direct is_overdue field for mortgages — only
    // past_due_amount. isOverdue is derived from it downstream in
    // mapPlaidLiabilityToDebt, never fabricated here.
    pastDueAmount: liability.past_due_amount ?? undefined,
  };
}

function mapStudentLoanLiability(
  liability: StudentLoan,
  accountNameById: Map<string, string>,
  balanceByAccountId: Map<string, number>
): PlaidLiabilityData {
  const accountId = liability.account_id!; // caller has already filtered out null account_id
  return {
    kind: "student_loan",
    plaidAccountId: accountId,
    currentBalance: balanceByAccountId.get(accountId) ?? 0,
    isOverdue: liability.is_overdue ?? undefined,
    accountName: accountNameById.get(accountId),
    interestRatePercentage: liability.interest_rate_percentage,
    minimumPaymentAmount: liability.minimum_payment_amount ?? undefined,
    nextPaymentDueDate: liability.next_payment_due_date ?? undefined,
  };
}

/** Translates a raw /liabilities/get response into this app's own
 * PlaidLiabilityData union. A credit-card or student-loan record with a
 * null account_id is skipped rather than given a synthesized identity —
 * see SkippedLiability. Mortgage liabilities always carry a real
 * account_id per Plaid's SDK, so there's no mortgage skip case. */
export function mapLiabilitiesResponseToLiabilityData(response: LiabilitiesGetResponse): {
  liabilities: PlaidLiabilityData[];
  skipped: SkippedLiability[];
} {
  const accountNameById = new Map(response.accounts.map((a) => [a.account_id, a.name]));
  const balanceByAccountId = new Map(response.accounts.map((a) => [a.account_id, a.balances.current ?? 0]));

  const liabilities: PlaidLiabilityData[] = [];
  const skipped: SkippedLiability[] = [];

  for (const credit of response.liabilities.credit ?? []) {
    if (!credit.account_id) {
      skipped.push({ kind: "credit_card", reason: "missing_account_id" });
      continue;
    }
    liabilities.push(mapCreditCardLiability(credit, accountNameById, balanceByAccountId));
  }

  for (const mortgage of response.liabilities.mortgage ?? []) {
    liabilities.push(mapMortgageLiability(mortgage, accountNameById, balanceByAccountId));
  }

  for (const studentLoan of response.liabilities.student ?? []) {
    if (!studentLoan.account_id) {
      skipped.push({ kind: "student_loan", reason: "missing_account_id" });
      continue;
    }
    liabilities.push(mapStudentLoanLiability(studentLoan, accountNameById, balanceByAccountId));
  }

  return { liabilities, skipped };
}

// ============================================================================
// Webhook JWK fetch (rv2.5)
// ============================================================================

/** The real JwkKey fetcher for createJwkCache — the only place that
 * calls Plaid's /webhook_verification_key/get. A lookup failure (unknown
 * key id, transient error) returns undefined rather than throwing, so
 * verifyPlaidWebhook's "missing key" path handles it uniformly. */
export async function fetchPlaidJwk(keyId: string): Promise<JwkKey | undefined> {
  try {
    const response = await plaidClient.webhookVerificationKeyGet({ key_id: keyId });
    const key = response.data.key;
    return {
      kid: key.kid,
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      y: key.y,
      use: key.use,
      alg: key.alg,
      expired_at: key.expired_at,
    };
  } catch {
    return undefined;
  }
}
