// The seed fixture models a fixed slice of January 2026, not the real
// calendar date this app happens to be built on — Plaid's live sync will
// supply a real "as of now" once that integration exists (out of scope
// this pass). This constant stands in for "today" so the UI shell has a
// stable reference point into the seeded data.
export const SEED_TODAY = "2026-01-08";
