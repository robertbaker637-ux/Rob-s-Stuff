import { describe, expect, it, vi } from "vitest";
import {
  isStaleBaselineError,
  runAccountBalanceReconciliation,
  type ReconciliationEvent,
} from "@/lib/plaid/syncOrchestration";
import type {
  Account,
  AccountBalanceSnapshot,
  PlaidBalanceObservation,
  ReconciliationOffset,
  Transaction,
} from "@/lib/domain/types";

// A mock persistReconciliationEvent standing in for reconcile_account_balance's
// documented behavior (see supabase/migrations/0001_init.sql): replay-vs-
// corruption detection validated against the FULL event identity, a
// compare-and-swap check against the account's actual latest snapshot, and
// a daily-record upsert derived entirely from the event's own snapshot.
function createMockReconciliationStore() {
  const snapshots = new Map<string, AccountBalanceSnapshot>();
  const offsetsByNewSnapshotId = new Map<string, ReconciliationOffset>();
  const dailyRecords = new Map<string, { balance: number; date: string }>();

  function latestForAccount(accountId: string): AccountBalanceSnapshot | undefined {
    const forAccount = [...snapshots.values()].filter((s) => s.accountId === accountId);
    if (forAccount.length === 0) return undefined;
    return forAccount.reduce((latest, s) => (s.asOfTimestamp > latest.asOfTimestamp ? s : latest));
  }

  const persistReconciliationEvent = vi.fn(async (event: ReconciliationEvent): Promise<void> => {
    const { snapshot, offset, localDate } = event;
    const existing = snapshots.get(snapshot.id);

    if (existing) {
      if (
        existing.accountId !== snapshot.accountId ||
        existing.asOfBalance !== snapshot.asOfBalance ||
        existing.asOfTimestamp !== snapshot.asOfTimestamp ||
        existing.syncCursor !== snapshot.syncCursor ||
        existing.priorSnapshotId !== snapshot.priorSnapshotId
      ) {
        throw { code: "B0002", message: "snapshot_immutability_violation" };
      }

      const existingOffset = offsetsByNewSnapshotId.get(snapshot.id);
      if (existingOffset && !offset) {
        throw { code: "B0002", message: "offset_immutability_violation: replay omits an offset" };
      }
      if (!existingOffset && offset) {
        throw { code: "B0002", message: "offset_immutability_violation: replay supplies an offset" };
      }
      if (existingOffset && offset) {
        if (
          existingOffset.id !== offset.id ||
          existingOffset.accountId !== offset.accountId ||
          existingOffset.amount !== offset.amount ||
          existingOffset.priorSnapshotId !== offset.priorSnapshotId ||
          existingOffset.newSnapshotId !== offset.newSnapshotId ||
          existingOffset.occurredAt !== offset.occurredAt
        ) {
          throw { code: "B0002", message: "offset_immutability_violation" };
        }
      }

      // Fully validated replay — daily_balance_records deliberately
      // untouched, so an older replay never rolls it backward.
      return;
    }

    const actualLatest = latestForAccount(snapshot.accountId);
    if (snapshot.priorSnapshotId === null) {
      if (actualLatest) throw { code: "B0001", message: "stale_baseline" };
    } else {
      if (!actualLatest || actualLatest.id !== snapshot.priorSnapshotId) {
        throw { code: "B0001", message: "stale_baseline" };
      }
      if (snapshot.asOfTimestamp <= actualLatest.asOfTimestamp) {
        throw { code: "B0003", message: "chronological_order_violation" };
      }
    }

    snapshots.set(snapshot.id, snapshot);
    if (offset) offsetsByNewSnapshotId.set(snapshot.id, offset);
    dailyRecords.set(`${snapshot.accountId}|${localDate}`, { balance: snapshot.asOfBalance, date: localDate });
  });

  const getLatestSnapshot = vi.fn(async (accountId: string) => latestForAccount(accountId));

  return { snapshots, offsetsByNewSnapshotId, dailyRecords, persistReconciliationEvent, getLatestSnapshot };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acct-checking",
    name: "Checking",
    role: "primary_pay",
    isManual: false,
    plaidAccountId: "plaid-acct-checking",
    ...overrides,
  };
}

function observation(overrides: Partial<PlaidBalanceObservation> = {}): PlaidBalanceObservation {
  return {
    balances: [{ plaidAccountId: "plaid-acct-checking", currentBalance: 1000 }],
    observedAt: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("runAccountBalanceReconciliation — basic orchestration", () => {
  it("reconciles a single account, establishing its baseline via exactly one persistReconciliationEvent call", async () => {
    const store = createMockReconciliationStore();
    const result = await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances: async () => observation(),
      syncCursor: "cursor-1",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });

    expect(store.persistReconciliationEvent).toHaveBeenCalledTimes(1);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].asOfBalance).toBe(1000);
    expect(result.snapshots[0].priorSnapshotId).toBeNull();
    expect(result.offsets).toHaveLength(0);
  });

  it("reconciles multiple accounts independently, one persistReconciliationEvent call each", async () => {
    const store = createMockReconciliationStore();
    const checking = account({ id: "acct-checking", plaidAccountId: "plaid-checking" });
    const savings = account({ id: "acct-savings", plaidAccountId: "plaid-savings", role: "savings" });

    const result = await runAccountBalanceReconciliation({
      accounts: [checking, savings],
      fetchBalances: async () => ({
        balances: [
          { plaidAccountId: "plaid-checking", currentBalance: 500 },
          { plaidAccountId: "plaid-savings", currentBalance: 2500 },
        ],
        observedAt: "2026-01-01T12:00:00.000Z",
      }),
      syncCursor: "cursor-1",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });

    expect(store.persistReconciliationEvent).toHaveBeenCalledTimes(2);
    expect(result.snapshots.map((s) => s.accountId).sort()).toEqual(["acct-checking", "acct-savings"]);
    expect(result.snapshots.find((s) => s.accountId === "acct-checking")?.asOfBalance).toBe(500);
    expect(result.snapshots.find((s) => s.accountId === "acct-savings")?.asOfBalance).toBe(2500);
  });

  it("a null current balance skips that account entirely — never defaulted to 0", async () => {
    const store = createMockReconciliationStore();
    const result = await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances: async () => ({
        balances: [{ plaidAccountId: "plaid-acct-checking", currentBalance: null }],
        observedAt: "2026-01-01T12:00:00.000Z",
      }),
      syncCursor: "cursor-1",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });

    expect(store.persistReconciliationEvent).not.toHaveBeenCalled();
    expect(result.snapshots).toHaveLength(0);
  });

  it("a manual account (no plaidAccountId) is skipped without ever being looked up in the observation", async () => {
    const store = createMockReconciliationStore();
    const manual = account({ id: "acct-manual", plaidAccountId: undefined, isManual: true });
    const result = await runAccountBalanceReconciliation({
      accounts: [manual],
      fetchBalances: async () => observation(),
      syncCursor: "cursor-1",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });
    expect(store.persistReconciliationEvent).not.toHaveBeenCalled();
    expect(result.snapshots).toHaveLength(0);
  });

  it("uses the fetch's own observedAt for the snapshot timestamp and the local date — not 'now'", async () => {
    const store = createMockReconciliationStore();
    const specificObservedAt = "2020-05-15T03:00:00.000Z"; // clearly not "now"
    await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances: async () => observation({ observedAt: specificObservedAt }),
      syncCursor: "cursor-1",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "UTC",
    });

    const event = store.persistReconciliationEvent.mock.calls[0][0] as ReconciliationEvent;
    expect(event.snapshot.asOfTimestamp).toBe(specificObservedAt);
    expect(event.localDate).toBe("2020-05-15");
  });

  it("resolves the local date via the given IANA timezone, not a UTC slice", async () => {
    const store = createMockReconciliationStore();
    // 02:00 UTC on Jan 1 is still Dec 31 evening in New York.
    await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances: async () => observation({ observedAt: "2026-01-01T02:00:00.000Z" }),
      syncCursor: "cursor-1",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });
    const event = store.persistReconciliationEvent.mock.calls[0][0] as ReconciliationEvent;
    expect(event.localDate).toBe("2025-12-31");
  });

  it("ReconciliationEvent carries exactly one account identity (snapshot.accountId) and no independent balance field", async () => {
    const store = createMockReconciliationStore();
    await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances: async () => observation(),
      syncCursor: "cursor-1",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });
    const event = store.persistReconciliationEvent.mock.calls[0][0] as ReconciliationEvent;
    expect(Object.keys(event).sort()).toEqual(["localDate", "offset", "snapshot"]);
    expect("accountId" in event).toBe(false);
    expect("balance" in event).toBe(false);
    expect("dailyRecord" in event).toBe(false);

    const storedDaily = store.dailyRecords.get(`${event.snapshot.accountId}|${event.localDate}`);
    expect(storedDaily?.balance).toBe(event.snapshot.asOfBalance);
  });
});

describe("runAccountBalanceReconciliation — stale-baseline retry", () => {
  it("isStaleBaselineError recognizes only SQLSTATE B0001", () => {
    expect(isStaleBaselineError({ code: "B0001" })).toBe(true);
    expect(isStaleBaselineError({ code: "B0002" })).toBe(false);
    expect(isStaleBaselineError({ code: "B0003" })).toBe(false);
    expect(isStaleBaselineError(new Error("boom"))).toBe(false);
    expect(isStaleBaselineError(null)).toBe(false);
  });

  it("baseline concurrency: a lost race on priorSnapshotId === null retries once, re-fetching the concurrently-created baseline, using the SAME balance observation", async () => {
    const store = createMockReconciliationStore();
    // Simulate: another process already committed this account's baseline
    // between this orchestration's (stale) view and its persist attempt.
    const concurrentBaseline: AccountBalanceSnapshot = {
      id: "snap-concurrent-baseline",
      accountId: "acct-checking",
      asOfBalance: 995,
      asOfTimestamp: "2026-01-01T11:59:00.000Z",
      syncCursor: "cursor-concurrent",
      priorSnapshotId: null,
    };
    store.snapshots.set(concurrentBaseline.id, concurrentBaseline);

    const getLatestSnapshot = vi
      .fn<(accountId: string) => Promise<AccountBalanceSnapshot | undefined>>()
      .mockResolvedValueOnce(undefined) // this orchestration's own (stale) first read
      .mockImplementation(async (accountId: string) => {
        const forAccount = [...store.snapshots.values()].filter((s) => s.accountId === accountId);
        return forAccount.length === 0 ? undefined : forAccount[forAccount.length - 1];
      });

    const fetchBalances = vi.fn(async () => observation());

    const result = await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances,
      syncCursor: "cursor-1",
      getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });

    expect(fetchBalances).toHaveBeenCalledTimes(1); // never re-fetched from Plaid
    expect(store.persistReconciliationEvent).toHaveBeenCalledTimes(2); // one failed, one retried
    expect(getLatestSnapshot).toHaveBeenCalledTimes(2);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].priorSnapshotId).toBe(concurrentBaseline.id); // recomputed as ordinary post-baseline
  });

  it("an ordinary (non-baseline) stale prior retries once against the actual current latest", async () => {
    const store = createMockReconciliationStore();
    const original: AccountBalanceSnapshot = {
      id: "snap-original",
      accountId: "acct-checking",
      asOfBalance: 1000,
      asOfTimestamp: "2026-01-01T10:00:00.000Z",
      syncCursor: "cursor-0",
      priorSnapshotId: null,
    };
    const concurrentAdvance: AccountBalanceSnapshot = {
      id: "snap-concurrent-advance",
      accountId: "acct-checking",
      asOfBalance: 900,
      asOfTimestamp: "2026-01-01T11:00:00.000Z",
      syncCursor: "cursor-concurrent",
      priorSnapshotId: original.id,
    };
    store.snapshots.set(original.id, original);
    store.snapshots.set(concurrentAdvance.id, concurrentAdvance);

    const getLatestSnapshot = vi
      .fn<(accountId: string) => Promise<AccountBalanceSnapshot | undefined>>()
      .mockResolvedValueOnce(original) // stale view: doesn't yet see the concurrent advance
      .mockImplementation(async () => concurrentAdvance);

    const fetchBalances = vi.fn(async () => observation({ observedAt: "2026-01-01T12:00:00.000Z" }));

    const result = await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances,
      syncCursor: "cursor-1",
      getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });

    expect(fetchBalances).toHaveBeenCalledTimes(1);
    expect(store.persistReconciliationEvent).toHaveBeenCalledTimes(2);
    expect(result.snapshots[0].priorSnapshotId).toBe(concurrentAdvance.id);
  });

  it("a second stale-baseline failure in immediate succession propagates rather than retrying forever", async () => {
    const alwaysStale = vi.fn(async () => {
      throw { code: "B0001" };
    });

    await expect(
      runAccountBalanceReconciliation({
        accounts: [account()],
        fetchBalances: async () => observation(),
        syncCursor: "cursor-1",
        getLatestSnapshot: async () => undefined,
        loadTransactionsForAccount: async () => [],
        persistReconciliationEvent: alwaysStale,
        timezone: "America/New_York",
      })
    ).rejects.toMatchObject({ code: "B0001" });

    expect(alwaysStale).toHaveBeenCalledTimes(2); // one initial attempt, one retry, no more
  });

  it("chronological-order rejection (B0003) is never retried", async () => {
    const rejectsChronological = vi.fn(async () => {
      throw { code: "B0003" };
    });

    await expect(
      runAccountBalanceReconciliation({
        accounts: [account()],
        fetchBalances: async () => observation(),
        syncCursor: "cursor-1",
        getLatestSnapshot: async () => undefined,
        loadTransactionsForAccount: async () => [],
        persistReconciliationEvent: rejectsChronological,
        timezone: "America/New_York",
      })
    ).rejects.toMatchObject({ code: "B0003" });

    expect(rejectsChronological).toHaveBeenCalledTimes(1);
  });

  it("an unrelated error (no recognizable code) is never retried", async () => {
    const genericFailure = vi.fn(async () => {
      throw new Error("connection reset");
    });

    await expect(
      runAccountBalanceReconciliation({
        accounts: [account()],
        fetchBalances: async () => observation(),
        syncCursor: "cursor-1",
        getLatestSnapshot: async () => undefined,
        loadTransactionsForAccount: async () => [],
        persistReconciliationEvent: genericFailure,
        timezone: "America/New_York",
      })
    ).rejects.toThrow("connection reset");

    expect(genericFailure).toHaveBeenCalledTimes(1);
  });

  it("a total failure loses nothing: a later, separate call still recomputes against the original prior snapshot", async () => {
    const store = createMockReconciliationStore();
    const original: AccountBalanceSnapshot = {
      id: "snap-original",
      accountId: "acct-checking",
      asOfBalance: 1000,
      asOfTimestamp: "2026-01-01T10:00:00.000Z",
      syncCursor: "cursor-0",
      priorSnapshotId: null,
    };
    store.snapshots.set(original.id, original);

    const failingPersist = vi.fn(async () => {
      throw new Error("db unavailable");
    });

    await expect(
      runAccountBalanceReconciliation({
        accounts: [account()],
        fetchBalances: async () => observation({ observedAt: "2026-01-01T11:00:00.000Z" }),
        syncCursor: "cursor-1",
        getLatestSnapshot: store.getLatestSnapshot,
        loadTransactionsForAccount: async () => [],
        persistReconciliationEvent: failingPersist,
        timezone: "America/New_York",
      })
    ).rejects.toThrow("db unavailable");

    // Nothing committed — a fresh call still sees the same original prior.
    const result = await runAccountBalanceReconciliation({
      accounts: [account()],
      fetchBalances: async () => observation({ observedAt: "2026-01-01T12:00:00.000Z" }),
      syncCursor: "cursor-2",
      getLatestSnapshot: store.getLatestSnapshot,
      loadTransactionsForAccount: async () => [],
      persistReconciliationEvent: store.persistReconciliationEvent,
      timezone: "America/New_York",
    });
    expect(result.snapshots[0].priorSnapshotId).toBe(original.id);
  });
});

describe("persistReconciliationEvent contract — replay vs. corruption (mocked RPC behavior)", () => {
  function baseSnapshot(): AccountBalanceSnapshot {
    return {
      id: "snap-x",
      accountId: "acct-checking",
      asOfBalance: 1000,
      asOfTimestamp: "2026-01-01T10:00:00.000Z",
      syncCursor: "cursor-x",
      priorSnapshotId: null,
    };
  }

  function baseOffset(): ReconciliationOffset {
    return {
      id: "offset-x",
      accountId: "acct-checking",
      amount: 25,
      priorSnapshotId: "snap-prior",
      newSnapshotId: "snap-x",
      occurredAt: "2026-01-01T10:00:00.000Z",
    };
  }

  it("an exact replay (identical snapshot, no offset) is idempotent", async () => {
    const store = createMockReconciliationStore();
    const event: ReconciliationEvent = { snapshot: baseSnapshot(), localDate: "2026-01-01" };
    await store.persistReconciliationEvent(event);
    await expect(store.persistReconciliationEvent({ ...event })).resolves.toBeUndefined();
  });

  function seedPriorSnapshot(store: ReturnType<typeof createMockReconciliationStore>): AccountBalanceSnapshot {
    const prior: AccountBalanceSnapshot = {
      id: "snap-prior",
      accountId: "acct-checking",
      asOfBalance: 900,
      asOfTimestamp: "2026-01-01T09:00:00.000Z",
      syncCursor: "cursor-prior",
      priorSnapshotId: null,
    };
    store.snapshots.set(prior.id, prior);
    return prior;
  }

  it("an exact replay WITH an identical offset is idempotent", async () => {
    const store = createMockReconciliationStore();
    seedPriorSnapshot(store);
    const snapshot = { ...baseSnapshot(), priorSnapshotId: "snap-prior" };
    const event: ReconciliationEvent = { snapshot, offset: baseOffset(), localDate: "2026-01-01" };
    await store.persistReconciliationEvent(event);
    await expect(store.persistReconciliationEvent({ snapshot: { ...snapshot }, offset: { ...baseOffset() }, localDate: "2026-01-01" })).resolves.toBeUndefined();
  });

  it.each([
    ["balance", { asOfBalance: 1234 }],
    ["timestamp", { asOfTimestamp: "2026-01-01T11:00:00.000Z" }],
    ["cursor", { syncCursor: "cursor-different" }],
    ["priorSnapshotId", { priorSnapshotId: "snap-other-prior" }],
    ["accountId", { accountId: "acct-other" }],
  ])("same snapshot id, different %s -> corruption (B0002)", async (_field, patch) => {
    const store = createMockReconciliationStore();
    await store.persistReconciliationEvent({ snapshot: baseSnapshot(), localDate: "2026-01-01" });
    await expect(
      store.persistReconciliationEvent({ snapshot: { ...baseSnapshot(), ...patch }, localDate: "2026-01-01" })
    ).rejects.toMatchObject({ code: "B0002" });
  });

  it("offset present originally, replay omits it -> corruption (B0002)", async () => {
    const store = createMockReconciliationStore();
    seedPriorSnapshot(store);
    const snapshot = { ...baseSnapshot(), priorSnapshotId: "snap-prior" };
    await store.persistReconciliationEvent({ snapshot, offset: baseOffset(), localDate: "2026-01-01" });
    await expect(store.persistReconciliationEvent({ snapshot: { ...snapshot }, localDate: "2026-01-01" })).rejects.toMatchObject({
      code: "B0002",
    });
  });

  it("offset absent originally, replay supplies one -> corruption (B0002)", async () => {
    const store = createMockReconciliationStore();
    await store.persistReconciliationEvent({ snapshot: baseSnapshot(), localDate: "2026-01-01" });
    await expect(
      store.persistReconciliationEvent({ snapshot: { ...baseSnapshot() }, offset: baseOffset(), localDate: "2026-01-01" })
    ).rejects.toMatchObject({ code: "B0002" });
  });

  it.each([
    ["amount", { amount: 999 }],
    ["priorSnapshotId", { priorSnapshotId: "snap-different-prior" }],
    ["newSnapshotId", { newSnapshotId: "snap-different-new" }],
    ["occurredAt", { occurredAt: "2026-01-01T12:00:00.000Z" }],
    ["accountId", { accountId: "acct-other" }],
  ])("same offset id, different %s -> corruption (B0002)", async (_field, patch) => {
    const store = createMockReconciliationStore();
    seedPriorSnapshot(store);
    const snapshot = { ...baseSnapshot(), priorSnapshotId: "snap-prior" };
    await store.persistReconciliationEvent({ snapshot, offset: baseOffset(), localDate: "2026-01-01" });
    await expect(
      store.persistReconciliationEvent({ snapshot: { ...snapshot }, offset: { ...baseOffset(), ...patch }, localDate: "2026-01-01" })
    ).rejects.toMatchObject({ code: "B0002" });
  });

  it("a replay of an OLDER event never rolls the daily record backward", async () => {
    const store = createMockReconciliationStore();
    const first: AccountBalanceSnapshot = {
      id: "snap-first",
      accountId: "acct-checking",
      asOfBalance: 1000,
      asOfTimestamp: "2026-01-01T09:00:00.000Z",
      syncCursor: "cursor-1",
      priorSnapshotId: null,
    };
    const second: AccountBalanceSnapshot = {
      id: "snap-second",
      accountId: "acct-checking",
      asOfBalance: 1200,
      asOfTimestamp: "2026-01-01T15:00:00.000Z",
      syncCursor: "cursor-2",
      priorSnapshotId: "snap-first",
    };

    await store.persistReconciliationEvent({ snapshot: first, localDate: "2026-01-01" });
    await store.persistReconciliationEvent({ snapshot: second, localDate: "2026-01-01" });
    expect(store.dailyRecords.get("acct-checking|2026-01-01")?.balance).toBe(1200);

    // Replay of the FIRST event — validated as identical, so it's a no-op.
    await store.persistReconciliationEvent({ snapshot: { ...first }, localDate: "2026-01-01" });
    expect(store.dailyRecords.get("acct-checking|2026-01-01")?.balance).toBe(1200); // unchanged
  });
});
