# MVP scope: mail + OneDrive capture, baseline restore; the rest deferred

The MVP proves the inner vertical slice end to end before broadening. Mail and OneDrive both reduce to the same two delta shapes (mail folder, drive), so the MVP consumer handles exactly two collection types.

## In scope

- **Workloads:** mail (per-folder delta) + OneDrive (per-user drive).
- **Capture + incremental + retention/GC** for tenants up to the ~300-mailbox v1 ceiling (ADR 0003).
- **Baseline restore:** fetch blobs from R2, best-effort write-back (new item, flat placement), with the fidelity gaps documented in `graph.ts`.

## Non-goals (deliberately deferred — do not re-add without revisiting this ADR)

- SharePoint sites, Teams, calendar, contacts (`listSites` and those item types).
- Restore fidelity: permissions/sharing, version history, folder-tree reconstruction, in-place/conflict handling.
- WORM / Object Lock immutability (ransomware resilience).
- Adaptive throttling — RU accounting, per-service buckets, egress budget (see ADR 0001).
- Intra-tenant catalog sharding (see ADR 0003).
- **Self-serve onboarding.** Onboarding is manual: an operator sends the admin-consent URL and inserts the tenant row. (App-only client-credentials use _one_ app secret and no per-tenant refresh tokens — the original handoff's "per-tenant OAuth refresh tokens" is obsolete.)
