import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { seedRepository } from "@/lib/data/seedRepository";
import {
  computeCategoryBalanceForWindow,
  filterTransactionsForCategoryWindow,
  getCurrentWindowBudget,
} from "@/lib/domain/categoryAllocation";
import { prorateWindowAcrossMonths } from "@/lib/domain/calendarReporting";
import { computeCanonicalWindow } from "@/lib/domain/payWindow";
import { computeIncomeForWindow, computeSweepAmount, getBillsInWindow } from "@/lib/domain/sweep";
import { SEED_TODAY } from "@/lib/ui/seedToday";
import { formatCurrency, formatDate } from "@/lib/ui/format";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export default async function BudgetPage() {
  const [
    categories,
    categoryWindowBudgets,
    transactions,
    incomeSources,
    paychecks,
    bills,
    canonicalSchedule,
  ] = await Promise.all([
    seedRepository.getCategories(),
    seedRepository.getCategoryWindowBudgets(),
    seedRepository.getTransactions(),
    seedRepository.getIncomeSources(),
    seedRepository.getPaychecks(),
    seedRepository.getBills(),
    seedRepository.getCanonicalPaySchedule(),
  ]);

  const currentWindow = computeCanonicalWindow(canonicalSchedule, SEED_TODAY);

  const categoryRows = categories.map((category) => {
    const budget = getCurrentWindowBudget(categoryWindowBudgets, category.id, currentWindow.start) ?? 0;
    const transactionsInWindow = filterTransactionsForCategoryWindow(
      transactions,
      category.id,
      currentWindow,
      canonicalSchedule
    );
    const spent = transactionsInWindow.reduce((sum, t) => sum + t.amount, 0);
    const remaining = computeCategoryBalanceForWindow(budget, transactionsInWindow);
    return { category, budget, spent, remaining };
  });

  const totalBudgeted = categoryRows.reduce((sum, r) => sum + r.budget, 0);
  const totalSpent = categoryRows.reduce((sum, r) => sum + r.spent, 0);
  const totalRemaining = totalBudgeted - totalSpent;

  const incomeForWindow = computeIncomeForWindow(
    currentWindow,
    canonicalSchedule,
    incomeSources,
    paychecks
  );
  const billsInWindow = getBillsInWindow(bills, currentWindow, canonicalSchedule);
  const sweepAmount = computeSweepAmount(incomeForWindow, billsInWindow, categoryWindowBudgets);

  // As of SEED_TODAY, the current operating window IS the one that
  // crosses the Jan/Feb boundary (2026-01-30 - 2026-02-13), so the
  // calendar-reporting proration below is shown for the same window as
  // the rest of this page — not a separate illustrative example.
  const crossMonthWindow = currentWindow;
  const groceriesBudgetForCrossMonthWindow =
    getCurrentWindowBudget(categoryWindowBudgets, "cat-groceries", crossMonthWindow.start) ?? 0;
  const crossMonthAttribution = prorateWindowAcrossMonths(
    crossMonthWindow,
    groceriesBudgetForCrossMonthWindow
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-neutral-100">Budget</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Current operating window: {formatDate(currentWindow.start)} –{" "}
          {formatDate(currentWindow.end)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card title="Total Budgeted (this window)">
          <p className="text-2xl font-semibold text-neutral-50">{formatCurrency(totalBudgeted)}</p>
        </Card>
        <Card title="Spent (this window)">
          <p className="text-2xl font-semibold text-neutral-50">{formatCurrency(totalSpent)}</p>
        </Card>
        <Card title="Remaining (this window)">
          <p
            className={`text-2xl font-semibold ${totalRemaining < 0 ? "text-status-bad" : "text-neutral-50"}`}
          >
            {formatCurrency(totalRemaining)}
          </p>
        </Card>
      </div>

      <Card title="Categories — constant per-window baseline">
        <p className="mb-4 text-xs text-neutral-500">
          Each category&apos;s amount is fixed per 14-day operating window — never divided by
          however many paydays a calendar month happens to contain.
        </p>
        <ul className="divide-y divide-surface-border">
          {categoryRows.map(({ category, budget, spent, remaining }) => (
            <li key={category.id} className="flex items-center justify-between py-3 text-sm">
              <span className="text-neutral-200">{category.name}</span>
              <span className="text-neutral-500">
                {formatCurrency(spent)} / {formatCurrency(budget)} spent
              </span>
              <StatusBadge
                status={remaining < 0 ? "bad" : "good"}
                label={`${formatCurrency(remaining)} left`}
              />
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Window drill-in — sweep formula">
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-neutral-500">Income assigned to window</p>
            <p className="text-lg font-medium text-neutral-100">{formatCurrency(incomeForWindow)}</p>
          </div>
          <div>
            <p className="text-neutral-500">Bills due in window</p>
            <p className="text-lg font-medium text-neutral-100">
              {formatCurrency(billsInWindow.reduce((sum, b) => sum + b.amount, 0))}
            </p>
          </div>
          <div>
            <p className="text-neutral-500">Sweep amount</p>
            <p className="text-lg font-medium text-neutral-100">{formatCurrency(sweepAmount)}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Income assigned to this window includes Circle K (canonical), Church deposits landing
          in this window, and any actual gig deposits — never just Circle K alone.
        </p>
      </Card>

      <Card title="Calendar-month reporting (read-only)">
        <p className="mb-3 text-xs text-neutral-500">
          The current window ({formatDate(crossMonthWindow.start)} – {formatDate(crossMonthWindow.end)})
          spans January and February. Its Groceries budget of{" "}
          {formatCurrency(groceriesBudgetForCrossMonthWindow)} is prorated below by day-count for
          calendar reporting only — this never changes the operational window balance shown for
          Groceries above.
        </p>
        <ul className="divide-y divide-surface-border">
          {crossMonthAttribution.map((a) => (
            <li key={`${a.year}-${a.month}`} className="flex items-center justify-between py-2 text-sm">
              <span className="text-neutral-200">
                {MONTH_NAMES[a.month - 1]} {a.year}
              </span>
              <span className="text-neutral-500">{a.days} days</span>
              <span className="font-medium text-neutral-100">{formatCurrency(a.amount)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
