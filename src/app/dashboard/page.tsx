import { Card } from "@/components/Card";
import { ProgressBar } from "@/components/ProgressBar";
import { getEffectiveAmount } from "@/lib/domain/paycheck";
import { computeCanonicalWindow } from "@/lib/domain/payWindow";
import { seedRepository } from "@/lib/data/seedRepository";
import { SEED_TODAY } from "@/lib/ui/seedToday";
import { daysBetweenIso, formatCurrency, formatDate } from "@/lib/ui/format";

export default async function DashboardPage() {
  const [accounts, incomeSources, paychecks, bills, sinkingFunds, transactions, canonicalSchedule] =
    await Promise.all([
      seedRepository.getAccounts(),
      seedRepository.getIncomeSources(),
      seedRepository.getPaychecks(),
      seedRepository.getBills(),
      seedRepository.getSinkingFunds(),
      seedRepository.getTransactions(),
      seedRepository.getCanonicalPaySchedule(),
    ]);

  const currentWindow = computeCanonicalWindow(canonicalSchedule, SEED_TODAY);

  // Simple seed-data cash position, not the full As-of-Date roll-forward
  // system (that's out of scope this pass — see rv2.1 plan).
  const actualIncome = paychecks
    .filter((p) => p.isActual)
    .reduce((sum, p) => sum + getEffectiveAmount(p), 0);
  const spent = transactions
    .filter((t) => !t.isTransfer)
    .reduce((sum, t) => sum + t.amount, 0);
  const paidBills = bills.filter((b) => b.paidStatus).reduce((sum, b) => sum + b.amount, 0);
  const projectedBalance = actualIncome - spent - paidBills;

  // Next CANONICAL Circle K payday: derived directly from the schedule,
  // never from paycheck rows. This is always computable — it doesn't
  // depend on a paycheck record existing for it — and it's the date that
  // actually opens the next operating window.
  const nextCanonicalPayday = currentWindow.end;
  const nextCanonicalPaycheck = paychecks.find(
    (p) => p.incomeSourceId === "src-ck" && !p.isActual && p.projectedPayDate === nextCanonicalPayday
  );

  // Next EXPECTED INCOME: the earliest still-projected paycheck across
  // ANY regular income source (Circle K included, but not exclusively).
  // This is a genuinely different question from "when does the next
  // operating window open" — e.g. Church can have a projected payday
  // before Circle K's, and this card is allowed to show that.
  const nextExpectedIncome = paychecks
    .filter((p) => !p.isActual && p.projectedPayDate !== undefined && p.projectedPayDate >= SEED_TODAY)
    .sort((a, b) => (a.projectedPayDate! < b.projectedPayDate! ? -1 : 1))[0];
  const nextExpectedIncomeSource = nextExpectedIncome
    ? incomeSources.find((s) => s.id === nextExpectedIncome.incomeSourceId)
    : undefined;

  const billsDueSoon = bills
    .filter((b) => !b.paidStatus && b.dueDate >= SEED_TODAY)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-neutral-100">Dashboard</h1>
        <p className="mt-1 text-sm text-neutral-500">
          As of {formatDate(SEED_TODAY)} · seed data — {accounts.length} accounts, no live
          Plaid/Supabase connection this pass
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card title="Total Balance (seed projection)">
          <p className="text-3xl font-semibold text-neutral-50">
            {formatCurrency(projectedBalance)}
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            Actual income received minus spend and paid bills so far — not a live
            Plaid-reconciled balance.
          </p>
        </Card>

        <Card title="Next Circle K Payday (canonical)">
          <p className="text-3xl font-semibold text-neutral-50">
            {daysBetweenIso(SEED_TODAY, nextCanonicalPayday)} days
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            {formatDate(nextCanonicalPayday)}
            {nextCanonicalPaycheck && ` · expected ${formatCurrency(nextCanonicalPaycheck.projectedAmount ?? 0)}`}
            {" "}· opens the next operating window
          </p>
        </Card>

        <Card title="Next Expected Income (any source)">
          {nextExpectedIncome ? (
            <>
              <p className="text-3xl font-semibold text-neutral-50">
                {daysBetweenIso(SEED_TODAY, nextExpectedIncome.projectedPayDate!)} days
              </p>
              <p className="mt-2 text-xs text-neutral-500">
                {nextExpectedIncomeSource?.name} · {formatDate(nextExpectedIncome.projectedPayDate!)} ·
                expected {formatCurrency(nextExpectedIncome.projectedAmount ?? 0)}
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-500">No projected income in seed data.</p>
          )}
          <p className="mt-2 text-xs text-neutral-600">
            Informational only — does not drive the operating window (see Circle K card).
          </p>
        </Card>

        <Card title="Bills Due Soon">
          {billsDueSoon.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing due — you&apos;re clear.</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {billsDueSoon.map((bill) => (
                <li key={bill.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-neutral-200">{bill.name}</span>
                  <span className="text-neutral-500">{formatDate(bill.dueDate)}</span>
                  <span className="font-medium text-neutral-100">
                    {formatCurrency(bill.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Sinking Funds Progress" className="sm:col-span-2">
          <div className="space-y-4">
            {sinkingFunds
              .slice()
              .sort((a, b) => a.priority - b.priority)
              .map((fund) => (
                <div key={fund.id}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="text-neutral-200">{fund.name}</span>
                    <span className="text-neutral-500">
                      {formatCurrency(fund.currentAmount)} / {formatCurrency(fund.targetAmount)}
                    </span>
                  </div>
                  <ProgressBar value={fund.currentAmount} max={fund.targetAmount} />
                </div>
              ))}
          </div>
        </Card>
      </div>

      <p className="text-xs text-neutral-600">
        Current operating window: {formatDate(currentWindow.start)} –{" "}
        {formatDate(currentWindow.end)} (canonical, Circle K biweekly)
      </p>
    </div>
  );
}
