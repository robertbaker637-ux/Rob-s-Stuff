-- BASELINE v2 rv2.1 — initial schema (paychecks/income_sources amended in
-- rv2.2 for projected/actual reconciliation; transactions extended and
-- transaction_splits/merchant_rules/transfer_pair_history added in rv2.3
-- for the Step 4 transaction model; plaid_items/account_balance_snapshots
-- added and transactions extended again in rv2.4 for Step 5 Plaid
-- integration — see CHANGELOG v2 rv2.4).
--
-- Core entities for build-sequence steps 1-3: accounts, income sources /
-- pay schedules, paychecks, categories / category window budgets, bills,
-- sinking funds, debts, and a minimal transactions table.
--
-- Canonical window model (see CHANGELOG v2 rv2.1 and the rv2.1 build plan):
-- exactly one income_source per user is the canonical/primary window
-- source. Its pay_schedule (weekly or biweekly only — never semimonthly)
-- defines Window N = [payday_N, payday_(N+1)) for the whole household.
-- Steady category budgets are a per-window baseline (category_window_budgets),
-- never a monthly amount divided across paydays. Calendar month/quarter/year
-- are reporting-only rollups computed in application code, not stored here.
--
-- This migration is amended in place rather than superseded by a new
-- migration file: nothing has ever been applied to a live Supabase
-- project (rv2.1 shipped with no connection at all — see .env.example),
-- so there is no deployed schema to migrate away from yet. Once a real
-- project exists, changes after that point get their own migration files.
--
-- Every table is scoped to a single user via `user_id` + row-level security,
-- laying the multi-user foundation the brief requires from day one even
-- though only one user exists today.

-- ============================================================================
-- profiles
-- ============================================================================

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on profiles
  for update using (auth.uid() = id);

-- ============================================================================
-- accounts
-- ============================================================================

create type account_role as enum (
  'primary_pay',
  'savings',
  'hsa',
  'credit_card',
  'business',
  'other_manual'
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  role account_role not null,
  is_manual boolean not null default true,
  plaid_item_id text,
  plaid_account_id text,
  created_at timestamptz not null default now()
);

alter table accounts enable row level security;

create policy "accounts_all_own" on accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index accounts_user_id_idx on accounts (user_id);

-- ============================================================================
-- income_sources + pay_schedules
-- ============================================================================

create type income_source_type as enum ('regular', 'irregular');

create table income_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  type income_source_type not null,
  is_primary_window_source boolean not null default false,
  -- Regular sources only: the Setup baseline projectExpectedPaychecks()
  -- forecasts future paycheck events from.
  expected_per_paycheck numeric(12, 2),
  -- Irregular sources only: a monthly planning estimate.
  expected_monthly numeric(12, 2),
  created_at timestamptz not null default now(),
  constraint regular_has_no_expected_monthly
    check (type = 'irregular' or expected_monthly is null),
  constraint irregular_has_no_expected_per_paycheck
    check (type = 'regular' or expected_per_paycheck is null)
);

alter table income_sources enable row level security;

create policy "income_sources_all_own" on income_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index income_sources_user_id_idx on income_sources (user_id);

-- At most one primary/canonical window source per user. This is a ceiling,
-- not a floor: the app must still validate that exactly one exists before
-- enabling canonical-window calculations (see rv2.1 plan).
create unique index income_sources_one_primary_per_user
  on income_sources (user_id)
  where is_primary_window_source;

create type pay_cadence as enum ('weekly', 'biweekly', 'semimonthly');

create table pay_schedules (
  id uuid primary key default gen_random_uuid(),
  income_source_id uuid not null unique references income_sources (id) on delete cascade,
  cadence pay_cadence not null,
  -- weekly/biweekly: exact 7- or 14-day interval off this date.
  anchor_date date,
  -- semimonthly only: explicit day-of-month pair, 1-31, with 0 meaning
  -- "last calendar day of the month". Data, not a named-preset enum, so a
  -- new explicit two-payday rule never needs a schema change.
  semimonthly_day_a smallint,
  semimonthly_day_b smallint,
  created_at timestamptz not null default now(),
  constraint weekly_biweekly_requires_anchor
    check (cadence not in ('weekly', 'biweekly') or anchor_date is not null),
  constraint semimonthly_requires_day_pair
    check (
      cadence <> 'semimonthly'
      or (semimonthly_day_a between 0 and 31 and semimonthly_day_b between 0 and 31)
    )
);

alter table pay_schedules enable row level security;

create policy "pay_schedules_all_own" on pay_schedules
  for all using (
    exists (
      select 1 from income_sources s
      where s.id = pay_schedules.income_source_id and s.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from income_sources s
      where s.id = pay_schedules.income_source_id and s.user_id = auth.uid()
    )
  );

-- Application-level rule (documented, not a DB constraint since it requires
-- a cross-table check on income_sources.is_primary_window_source): a
-- pay_schedule may only be marked as backing the canonical window when its
-- cadence is 'weekly' or 'biweekly'. Semimonthly can never be canonical.

-- ============================================================================
-- paychecks
-- ============================================================================

-- A paycheck EVENT, which may carry a projected side, an actual side, or
-- both — never collapsed into one pay_date/amount pair. Reconciliation
-- (rv2.2) populates the actual_* columns onto the SAME row rather than
-- overwriting projected_*, so the original forecast survives for
-- variance/history after a real deposit is matched. is_actual is the
-- reconciliation status: false = projected_* authoritative, true =
-- actual_* authoritative for all downstream math and canonical-window
-- assignment (see src/lib/domain/paycheck.ts).
create table paychecks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  income_source_id uuid not null references income_sources (id) on delete cascade,
  -- Regular sources only — set by projectExpectedPaychecks().
  projected_pay_date date,
  projected_amount numeric(12, 2),
  -- Populated once reconciled (any source type).
  actual_pay_date date,
  actual_amount numeric(12, 2),
  actual_gross numeric(12, 2),
  auto_split_amount numeric(12, 2) not null default 0,
  auto_split_destination_account_id uuid references accounts (id) on delete set null,
  is_actual boolean not null default false,
  created_at timestamptz not null default now(),
  constraint actual_fields_required_once_reconciled
    check (not is_actual or (actual_pay_date is not null and actual_amount is not null)),
  constraint has_a_projected_or_actual_side
    check (projected_pay_date is not null or actual_pay_date is not null)
);

alter table paychecks enable row level security;

create policy "paychecks_all_own" on paychecks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index paychecks_user_id_idx on paychecks (user_id);
create index paychecks_income_source_id_idx on paychecks (income_source_id);
create index paychecks_projected_pay_date_idx on paychecks (projected_pay_date);
create index paychecks_actual_pay_date_idx on paychecks (actual_pay_date);

-- No stored window_start/window_end: canonical-window membership for any
-- income source's paycheck is derived at query time against the primary
-- source's pay_schedule (see src/lib/domain/payWindow.ts), never stored
-- per row.

-- ============================================================================
-- categories + category_window_budgets
-- ============================================================================

create type category_rollover_mode as enum ('rollover', 'sweep');

create table categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  parent_category_id uuid references categories (id) on delete set null,
  rollover_mode category_rollover_mode not null default 'rollover',
  is_income_category boolean not null default false,
  created_at timestamptz not null default now()
);

alter table categories enable row level security;

create policy "categories_all_own" on categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index categories_user_id_idx on categories (user_id);

-- Per-canonical-window baseline amount for a category. The amount applies
-- to every window from effective_from onward until superseded by a later
-- row for the same category — this is what keeps a $150/window budget at
-- $150/window regardless of how many paydays a given calendar month
-- happens to contain (see rv2.1 plan, "steady category budgets").
create table category_window_budgets (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories (id) on delete cascade,
  amount numeric(12, 2) not null,
  effective_from date not null,
  created_at timestamptz not null default now()
);

alter table category_window_budgets enable row level security;

create policy "category_window_budgets_all_own" on category_window_budgets
  for all using (
    exists (
      select 1 from categories c
      where c.id = category_window_budgets.category_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from categories c
      where c.id = category_window_budgets.category_id and c.user_id = auth.uid()
    )
  );

create index category_window_budgets_category_id_idx
  on category_window_budgets (category_id, effective_from);

-- ============================================================================
-- bills
-- ============================================================================

create type bill_type as enum ('bill', 'subscription');

create table bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  amount numeric(12, 2) not null,
  due_date date not null,
  paid_status boolean not null default false,
  type bill_type not null default 'bill',
  created_at timestamptz not null default now()
);

alter table bills enable row level security;

create policy "bills_all_own" on bills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index bills_user_id_idx on bills (user_id);
create index bills_due_date_idx on bills (due_date);

-- Paycheck-window assignment is computed from due_date against the
-- canonical window (see src/lib/domain/payWindow.ts), never manually set
-- or stored here.

-- ============================================================================
-- sinking_funds
-- ============================================================================

create table sinking_funds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  target_amount numeric(12, 2) not null,
  current_amount numeric(12, 2) not null default 0,
  priority integer not null,
  funding_account_id uuid references accounts (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table sinking_funds enable row level security;

create policy "sinking_funds_all_own" on sinking_funds
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index sinking_funds_user_id_idx on sinking_funds (user_id, priority);

-- ============================================================================
-- debts
-- ============================================================================

create table debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  balance numeric(12, 2) not null,
  apr numeric(6, 3),
  minimum_payment numeric(12, 2),
  plaid_liability_id text,
  created_at timestamptz not null default now()
);

alter table debts enable row level security;

create policy "debts_all_own" on debts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index debts_user_id_idx on debts (user_id);

-- ============================================================================
-- transactions (extended in rv2.3 for the Step 4 transaction model)
-- ============================================================================

-- Raw source fields (raw_*) are set once at creation and never
-- overwritten by any correction — see src/lib/domain/merchantMemory.ts.
-- Pre-Plaid, raw_merchant_name/raw_category are typically null since
-- there's no external enrichment to diverge from yet.
create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  posted_date date not null,
  pending boolean not null default false,
  amount numeric(12, 2) not null,
  description text not null,
  category_id uuid references categories (id) on delete set null,
  is_transfer boolean not null default false,

  raw_description text not null,
  raw_merchant_name text,
  raw_category text,
  raw_amount numeric(12, 2) not null,
  raw_date date not null,

  normalized_merchant_name text,
  needs_review boolean not null default true,

  bill_id uuid references bills (id) on delete set null,
  transfer_link_id uuid,

  -- rv2.4: Plaid's stable transaction_id is the idempotency key for sync
  -- (see src/lib/domain/plaidSync.ts). Absent for manually-entered rows.
  -- When a pending transaction posts, Plaid issues a NEW transaction_id,
  -- so this column is updated in place on reconciliation — our own `id`
  -- above never is.
  plaid_transaction_id text unique,
  plaid_pending_transaction_id text,

  created_at timestamptz not null default now()
);

alter table transactions enable row level security;

create policy "transactions_all_own" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index transactions_user_id_idx on transactions (user_id);
create index transactions_account_id_idx on transactions (account_id);
create index transactions_posted_date_idx on transactions (posted_date);
create index transactions_bill_id_idx on transactions (bill_id);
create index transactions_transfer_link_id_idx on transactions (transfer_link_id);
create index transactions_plaid_transaction_id_idx on transactions (plaid_transaction_id);

-- Canonical-window assignment for a transaction is computed from
-- posted_date via assignDateToCanonicalWindow (see
-- src/lib/domain/payWindow.ts) — a second reporting dimension on the same
-- row, not a stored column and not a duplicated record. raw_date is a
-- separate, independent field that nothing in the window/budget domain
-- layer reads.

-- ============================================================================
-- transaction_splits
-- ============================================================================

-- A transaction with splits has one or more of these; their amounts must
-- sum exactly to the parent transaction's amount (enforced by
-- validateSplitAllocations in src/lib/domain/transactionSplits.ts, not a
-- DB constraint, since a partial edit mid-flow can transiently not sum
-- yet — the app validates before persisting).
create table transaction_splits (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions (id) on delete cascade,
  category_id uuid not null references categories (id) on delete cascade,
  amount numeric(12, 2) not null,
  created_at timestamptz not null default now()
);

alter table transaction_splits enable row level security;

create policy "transaction_splits_all_own" on transaction_splits
  for all using (
    exists (
      select 1 from transactions t
      where t.id = transaction_splits.transaction_id and t.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from transactions t
      where t.id = transaction_splits.transaction_id and t.user_id = auth.uid()
    )
  );

create index transaction_splits_transaction_id_idx on transaction_splits (transaction_id);

-- ============================================================================
-- merchant_rules
-- ============================================================================

-- One row per normalized merchant identity. merchant_key is always
-- derived from a transaction's RAW fields (see
-- getTransactionMerchantKey in src/lib/domain/merchantMemory.ts) — never
-- from normalized_merchant_name, so renaming how a merchant displays can
-- never change which rule applies.
create table merchant_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  merchant_key text not null,
  category_id uuid not null references categories (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, merchant_key)
);

alter table merchant_rules enable row level security;

create policy "merchant_rules_all_own" on merchant_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index merchant_rules_user_id_idx on merchant_rules (user_id);

-- ============================================================================
-- transfer_pair_history
-- ============================================================================

-- Confirmed-transfer history for one unordered pair of accounts.
-- account_a_id/account_b_id are always stored in sorted order (see
-- canonicalAccountPairKey in src/lib/domain/transferDetection.ts) so a
-- pair is looked up the same way regardless of which account a given
-- transaction happens to be on. Growing confirmed_count is what lets
-- scoreTransferCandidate raise confidence on that pair over time.
create table transfer_pair_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_a_id uuid not null references accounts (id) on delete cascade,
  account_b_id uuid not null references accounts (id) on delete cascade,
  confirmed_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, account_a_id, account_b_id),
  constraint account_pair_is_sorted check (account_a_id < account_b_id)
);

alter table transfer_pair_history enable row level security;

create policy "transfer_pair_history_all_own" on transfer_pair_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index transfer_pair_history_user_id_idx on transfer_pair_history (user_id);

-- ============================================================================
-- plaid_items (rv2.4, Step 5)
-- ============================================================================

create type plaid_item_status as enum ('active', 'login_required', 'error');

-- One linked institution connection. access_token is SERVICE-ROLE-ONLY:
-- deliberately no RLS policy grants any access to it at all (not even
-- to the owning user via the anon/authenticated client) — only the
-- service_role key, which bypasses RLS entirely, can read or write this
-- table, and every place that does so lives under src/lib/plaid/,
-- server-only, never shipped to the client bundle. See
-- src/lib/domain/types.ts's PlaidItem, which has NO access_token field
-- for exactly this reason.
create table plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plaid_item_id text not null unique,
  institution_name text,
  status plaid_item_status not null default 'active',
  error_code text,
  access_token text not null,
  -- Cursor for /transactions/sync. Advanced only after a complete sync
  -- batch (all pages) has been fetched AND successfully persisted — see
  -- src/lib/plaid/syncOrchestration.ts.
  transactions_cursor text,
  last_successful_sync_at timestamptz,
  -- Set when a SYNC_UPDATES_AVAILABLE webhook's payload carries
  -- historical_update_complete: true. Always a side effect of running
  -- that same sync, never set in place of it.
  historical_pull_complete boolean not null default false,
  created_at timestamptz not null default now()
);

alter table plaid_items enable row level security;
-- No policies created — service_role bypasses RLS by default, and
-- nothing else should ever query this table.

-- ============================================================================
-- account_balance_snapshots (rv2.4 — Step 6 storage hook only)
-- ============================================================================

-- A raw balance-as-reported-by-Plaid snapshot. No roll-forward
-- projection or offset-reconciliation logic reads this yet — that's
-- Step 6. This table is the minimum hook it will read from.
create table account_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  as_of_balance numeric(12, 2) not null,
  as_of_timestamp timestamptz not null,
  created_at timestamptz not null default now()
);

alter table account_balance_snapshots enable row level security;

create policy "account_balance_snapshots_all_own" on account_balance_snapshots
  for all using (
    exists (
      select 1 from accounts a
      where a.id = account_balance_snapshots.account_id and a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from accounts a
      where a.id = account_balance_snapshots.account_id and a.user_id = auth.uid()
    )
  );

create index account_balance_snapshots_account_id_idx
  on account_balance_snapshots (account_id, as_of_timestamp);
