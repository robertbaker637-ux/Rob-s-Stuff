# BASELINE Changelog

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
