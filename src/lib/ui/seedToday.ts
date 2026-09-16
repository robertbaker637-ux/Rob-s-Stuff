// The seed fixture models a fixed slice of Jan-Mar 2026, not the real
// calendar date this app happens to be built on — Plaid's live sync will
// supply a real "as of now" once that integration exists (out of scope
// this pass). This constant stands in for "today" so the UI shell has a
// stable reference point into the seeded data.
//
// 2026-02-05 falls inside the canonical window that crosses the Jan/Feb
// boundary (2026-01-30 - 2026-02-13), so everything through Feb 1 in the
// fixture is reconciled as actual and everything after remains a live
// projection — including the rest of that same in-progress window.
export const SEED_TODAY = "2026-02-05";
