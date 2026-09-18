// Structural, textual guard over supabase/migrations/0001_init.sql — no
// live Postgres exists to check this against, so this test parses the
// migration's own SQL text instead of hardcoding a column list, so a
// future forgotten FK or enum value fails automatically rather than
// silently drifting. See the rv2.6 planning doc's §5.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(process.cwd(), "supabase/migrations/0001_init.sql");
const sql = readFileSync(MIGRATION_PATH, "utf-8");

/** Tables whose primary key was converted from uuid to text in rv2.6 —
 * application-generated ids, never DB-generated uuids. */
const CONVERTED_TABLES = new Set([
  "accounts",
  "transactions",
  "debts",
  "account_balance_snapshots",
  "reconciliation_offsets",
  "daily_balance_records",
]);

/** Walks `create table <name> (` ... matching `)` for every table in the
 * migration, tracking paren depth so nested parens (numeric(12,2),
 * check(...), references t (id)) don't terminate the block early. */
function extractCreateTableBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const headerRegex = /create table (\w+) \(/g;
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(text))) {
    const tableName = match[1];
    const startIdx = headerRegex.lastIndex;
    let depth = 1;
    let i = startIdx;
    while (depth > 0 && i < text.length) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    blocks.set(tableName, text.slice(startIdx, i - 1));
    headerRegex.lastIndex = i;
  }
  return blocks;
}

const tableBlocks = extractCreateTableBlocks(sql);

describe("converted tables declare id text primary key", () => {
  it.each([...CONVERTED_TABLES])("%s", (tableName) => {
    const block = tableBlocks.get(tableName);
    expect(block, `table ${tableName} not found in migration`).toBeDefined();
    expect(block).toMatch(/\bid text primary key\b/);
  });
});

describe("every FK referencing a converted table's id is itself text", () => {
  // A generic scan over every `references <table> (id)` occurrence in the
  // whole file, not a fixed list — a future forgotten FK conversion fails
  // this automatically.
  const lines = sql.split("\n");
  const referencingLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /references\s+\w+\s*\(id\)/.test(line));

  it("finds at least one FK referencing each converted table (sanity check on the scan itself)", () => {
    const referencedTables = new Set(
      referencingLines.map(({ line }) => /references\s+(\w+)\s*\(id\)/.exec(line)?.[1]).filter(Boolean)
    );
    // accounts and transactions are referenced by other tables; debts and
    // daily_balance_records/reconciliation_offsets are not referenced by
    // anything else in this schema, which is expected — this assertion
    // only guards that the line-scan mechanism itself is finding matches.
    expect(referencedTables.has("accounts")).toBe(true);
    expect(referencedTables.has("transactions")).toBe(true);
    expect(referencedTables.has("account_balance_snapshots")).toBe(true);
  });

  for (const { line, index } of referencingLines) {
    const referencedTable = /references\s+(\w+)\s*\(id\)/.exec(line)?.[1];
    if (!referencedTable || !CONVERTED_TABLES.has(referencedTable)) continue;

    const columnMatch = /^\s*(\w+)\s+(\w+)\b/.exec(line);
    const columnName = columnMatch?.[1] ?? `<unparsed line ${index + 1}>`;
    const columnType = columnMatch?.[2];

    it(`line ${index + 1}: ${columnName} (references ${referencedTable} (id)) is text`, () => {
      expect(columnType).toBe("text");
    });
  }
});

describe("account_role enum", () => {
  it("includes 'loan'", () => {
    const enumMatch = /create type account_role as enum \(([\s\S]*?)\)/.exec(sql);
    expect(enumMatch, "account_role enum not found").toBeDefined();
    expect(enumMatch![1]).toMatch(/'loan'/);
  });
});

describe("reconcile_account_balance privilege lockdown", () => {
  const RECONCILE_SIGNATURE = "text, text, text, numeric, timestamptz, text, text, numeric, date";
  const statements = sql.split(";");

  it("revokes from public, anon, and authenticated using the explicit signature", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      const statement = statements.find(
        (s) =>
          /revoke all on function reconcile_account_balance\(/.test(s) &&
          s.includes(RECONCILE_SIGNATURE) &&
          new RegExp(`from ${role}\\b`).test(s)
      );
      expect(statement, `no explicit-signature revoke from ${role} found`).toBeDefined();
    }
  });

  it("grants execute to service_role using the explicit signature", () => {
    const statement = statements.find(
      (s) =>
        /grant execute on function reconcile_account_balance\(/.test(s) &&
        s.includes(RECONCILE_SIGNATURE) &&
        /to service_role\b/.test(s)
    );
    expect(statement, "no explicit-signature grant to service_role found").toBeDefined();
  });
});

describe("insert-only tables are not quietly upserted via an id-level unique/on-conflict target", () => {
  it.each(["account_balance_snapshots", "reconciliation_offsets"])("%s has no unique(id) beyond its primary key", (tableName) => {
    const block = tableBlocks.get(tableName)!;
    expect(block).toBeDefined();
    expect(block).not.toMatch(/unique\s*\(\s*id\s*\)/);
  });

  // Explicitly NOT checked above — these are intentional, different
  // constraints (one-offset-per-snapshot; one-record-per-account-per-day),
  // not an id-level upsert target:
  it("reconciliation_offsets still declares unique(new_snapshot_id) — the intentional one-offset-per-snapshot constraint", () => {
    expect(tableBlocks.get("reconciliation_offsets")).toMatch(/unique\s*\(\s*new_snapshot_id\s*\)/);
  });

  it("daily_balance_records declares unique(account_id, date) — the intentional upsert target", () => {
    expect(tableBlocks.get("daily_balance_records")).toMatch(/unique\s*\(\s*account_id,\s*date\s*\)/);
  });
});

describe("account_balance_snapshots.prior_snapshot_id / reconciliation_offsets.*_snapshot_id are text", () => {
  it("account_balance_snapshots.prior_snapshot_id", () => {
    expect(tableBlocks.get("account_balance_snapshots")).toMatch(/prior_snapshot_id text references account_balance_snapshots/);
  });

  it("reconciliation_offsets.prior_snapshot_id", () => {
    expect(tableBlocks.get("reconciliation_offsets")).toMatch(/prior_snapshot_id text references account_balance_snapshots/);
  });

  it("reconciliation_offsets.new_snapshot_id", () => {
    expect(tableBlocks.get("reconciliation_offsets")).toMatch(/new_snapshot_id text not null references account_balance_snapshots/);
  });
});
