import { Card } from "@/components/Card";
import { ProgressBar } from "@/components/ProgressBar";
import { computeCanonicalWindow } from "@/lib/domain/payWindow";
import { seedRepository } from "@/lib/data/seedRepository";
import { SEED_TODAY } from "@/lib/ui/seedToday";
import { daysBetweenIso, formatCurrency, formatDate } from "@/lib/ui/format";

export default async function DashboardPage() {
  const [accounts, paychecks, bills, sinkingFunds, transactions, canonicalSchedule] =
    await Promise.all([
      seedRepository.getAccounts(),
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
    .reduce((sum, p) => sum + p.net, 0);
  const spent = transactions
    .filter((t) => !t.isTransfer)
    .reduce((sum, t) => sum + t.amount, 0);
  const paidBills = bills.filter((b) => b.paidStatus).reduce((sum, b) => sum + b.amount, 0);
  const projectedBalance = actualIncome - spent - paidBills;

  const nextPaycheck = paychecks
    .filter((p) => !p.isActual && p.payDate >= SEED_TODAY)
    .sort((a, b) => (a.payDate < b.payDate ? -1 : 1))[0];

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

        <Card title="Next Payday">
          {nextPaycheck ? (
            <>
              <p className="text-3xl font-semibold text-neutral-50">
                {daysBetweenIso(SEED_TODAY, nextPaycheck.payDate)} days
              </p>
              <p className="mt-2 text-xs text-neutral-500">
                {formatDate(nextPaycheck.payDate)} · expected{" "}
                {formatCurrency(nextPaycheck.expectedPerPaycheck ?? 0)}
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-500">No upcoming paycheck in seed data.</p>
          )}
        </Card>

        <Card title="Bills Due Soon" className="sm:col-span-2">
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
