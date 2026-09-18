# BASELINE Changelog

## v2 rv2.3 — 2026-09-18

Step 4 of the build sequence: the transaction model. Local/seeded data
only — no Plaid integration yet (that's Step 5). Canonical-window
computation, income projection/reconciliation, category-budget
allocation, and the sweep formula are unchanged — every rv2.1/rv2.2 test
still passes verbatim (62 tests total now, 28 new).

- **Raw/normalized field separation.** `Transaction` now carries
  `rawDescription`/`rawMerchantName`/`rawCategory`/`rawAmount`/`rawDate`
  (immutable once set) separately from `categoryId`/`normalizedMerchantName`
  (what corrections change). Canonical-window assignment continues to
  read `postedDate` only — `rawDate` has no influence on it, proven by a
  new regression test.
- **Merchant normalization + memory** (`src/lib/domain/merchantMemory.ts`).
  `normalizeMerchantKey` + `applyMerchantMemory` auto-categorize a
  transaction from a `MerchantRule` matched on its raw merchant identity.
  `correctTransactionCategory` re-teaches one merchant without touching
  other merchants' rules or other transactions' past records. The rule
  lookup key is always derived from raw fields — `normalizedMerchantName`
  is display-only and can never change which rule applies.
- **Split transactions** (`src/lib/domain/transactionSplits.ts`).
  `validateSplitAllocations` enforces splits summing exactly to the
  parent amount. `computeSplitAwareCategoryBalanceForWindow` is a new,
  additive function — `categoryAllocation.ts`'s existing single-category
  functions are untouched, and a non-split transaction is proven to
  produce byte-identical results through either path.
- **Confidence-based transfer detection** (`src/lib/domain/transferDetection.ts`).
  `scoreTransferCandidate` enforces its own candidacy prerequisites
  (different accounts, opposite directions) before scoring, so no caller
  can bypass them. Exact-amount/same-day pairs score high (auto-link
  eligible via `confirmTransferLink`); near-amount/nearby-date pairs
  score low (need one-tap confirmation); a confirmed account pair's
  history raises the confidence of future matches on that same pair.
  Linked transfers stay excluded from category totals via the existing
  `isTransfer` filter, unchanged.
- **Bill linking field.** `Transaction.billId` added for a manual link to
  a Bill/Subscription record. Auto-matching by amount+date+merchant is
  explicitly Step 7, not built here.
- Supabase migration amended in place: `transactions` extended, plus new
  `transaction_splits`, `merchant_rules`, and `transfer_pair_history`
  tables (still nothing deployed to a live project).
- Seed fixture extended additively (`txn-9` onward) with one
  merchant-memory example, one split transaction, one confirmed transfer
  pair, and one unconfirmed transfer candidate — `txn-1`..`txn-8` and
  every existing paycheck/bill are byte-identical to rv2.2.

No new UI page this pass (Dashboard/Budget don't need transaction-level
detail to keep working) — validated entirely through the test suite and
the extended seed fixture, same as rv2.2's reconciliation logic was
before any UI touched it.

## v2 rv2.2 — 2026-09-16

Correction/validation pass following a manual review of rv2.1's seeded
walkthrough. No transaction categorization/merchant-memory/splits/transfer-
detection work yet — that's still step 4, untouched here. Fixes four issues
the walkthrough surfaced:

- **Dashboard payday semantics.** "Next Payday" previously picked the
  earliest non-actual paycheck across *all* income sources, which could
  (and did, in the seeded scenario) surface Church's projected paycheck
  instead of Circle K's. Split into two cards: **Next Circle K Payday
  (canonical)**, derived directly from `computeCanonicalWindow(schedule,
  today).end` — independent of whether any paycheck row exists — and
  **Next Expected Income (any source)**, a separate cross-source lookup.
  These are two different concepts and are named separately in both the
  domain layer and the UI.
- **Paycheck model restructured for projected/actual reconciliation.**
  `Paycheck` no longer has a single `payDate`/`net`/`expectedPerPaycheck`;
  it now carries `projectedPayDate`/`projectedAmount` and
  `actualPayDate`/`actualAmount` separately, with `isActual` as the
  reconciliation status. Reconciling a paycheck (`reconcilePaycheck`) adds
  the actual side onto the same record rather than overwriting the
  projected side, so the original forecast survives for variance/history.
  Canonical-window assignment always reads the effective (actual-if-known,
  else projected) date, so a paycheck whose real deposit lands in a
  different window than it was projected into reassigns automatically,
  with no double counting.
- **`projectExpectedPaychecks()` added.** A regular income source's own
  `pay_schedule` + `expected_per_paycheck` baseline (new field on
  `income_sources`) now forecasts future paycheck events directly —
  Circle K and Church paychecks in the seed fixture are generated this
  way, not hand-written one by one. Irregular (gig) income still produces
  no projected events, by construction.
- **Seed fixture extended to five consecutive canonical windows**
  (2026-01-02 through 2026-03-13), covering January's real 3-payday month,
  February's normal 2-payday month, and realistic income/bills/spending on
  both sides of the window that crosses the Jan/Feb boundary — including
  the exact Groceries example validated in tests: $150 baseline, $40 spent
  Jan 31, $30 spent Feb 3, $80 remaining, unaffected by calendar-reporting
  proration.
- Supabase migration `0001_init.sql` amended in place (not superseded —
  nothing has ever been applied to a live project) to match the new
  `paychecks` and `income_sources` shape.
- 13 new tests (34 total, all passing): paycheck projection (Circle K
  biweekly, Church weekly, semimonthly generic, irregular → none),
  reconciliation (same-window, cross-window, amount variance, no double
  counting), and the real-fixture cross-month balance-carry case above.

## v2 rv2.1 — 2026-09-16

First commit of the v2 rebuild. Scope: build-sequence steps 1–3 (schema + auth
foundation, core budget/pay-window math, manually-seeded validation) plus a
basic UI shell, per the BASELINE v2 Build Brief.

- Supabase Postgres schema (`supabase/migrations/0001_init.sql`) for all core
  entities: accounts, income sources, pay schedules, paychecks, categories,
  category window budgets, bills, sinking funds, debts, transactions.
  Multi-user-capable via `user_id` + RLS on every table. Not yet connected to
  a live Supabase project.
- Canonical operating window model: Circle K's biweekly Friday payroll is the
  sole canonical schedule. Windows are exact 14-day periods that never reset
  at a calendar-month boundary. Steady category budgets are a constant
  per-window baseline, never divided by paydays-in-month. Calendar month is a
  reporting-only, day-count-prorated view derived from windows.
- Multi-income aggregation: Church (regular, non-primary) and gig (irregular)
  income are assigned into whichever canonical CK window contains their
  deposit (or, for Church, projected payday) date — one window structure,
  fed by multiple sources.
- Domain math (`src/lib/domain/`) unit-tested against manually-seeded
  fixtures: pay-window computation, category window-balance, calendar
  reporting proration, and the sweep formula.
- Basic UI shell (Dashboard, Budget) reading seeded data through a
  swappable repository interface — no live Plaid/Supabase wiring yet.

Out of scope this pass: Plaid integration, live Supabase connection, PWA,
transaction merchant-memory/splits/transfer-detection, receipts,
notifications, Insights, debt payoff planning, bill auto-detection.
