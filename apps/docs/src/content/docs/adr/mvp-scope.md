---
title: 'MVP scope: mail + OneDrive capture, baseline restore; the rest deferred'
description: What the m365vault MVP delivers — mail and OneDrive capture with baseline restore — and the workloads and fidelity deliberately deferred.
---

## Decision

The MVP proves the inner vertical slice end to end before broadening. Mail and OneDrive both reduce to the same two delta shapes (mail folder, drive), so the MVP consumer handles exactly two collection types.

## In scope

- **Workloads:** mail (per-folder delta) + OneDrive (per-user drive).
- **Capture + incremental + retention/GC** for Tenants up to the ~300-mailbox v1 ceiling ([ADR: per-tenant catalog](/adr/per-tenant-catalog/)).
- **Baseline restore:** fetch Blobs from R2, best-effort write-back (new Item, flat placement), with the fidelity gaps documented in `graph.ts`.

## Non-goals

Deliberately deferred — do not re-add without revisiting this ADR.

- SharePoint sites, Teams, calendar, contacts (`listSites` and those item types).
- Restore fidelity: permissions/sharing, version history, folder-tree reconstruction, in-place/conflict handling.
- WORM / Object Lock immutability (ransomware resilience).
- Adaptive throttling — RU accounting, per-service buckets, egress budget (see [ADR: throttle governance](/adr/multi-tenant-and-throttle-governance/)).
- Intra-tenant catalog sharding (see [ADR: per-tenant catalog](/adr/per-tenant-catalog/)).
- **Self-serve onboarding.** Onboarding is manual: an operator sends the admin-consent URL and inserts the Tenant row. (App-only client-credentials use _one_ app secret and no per-tenant refresh tokens — the original handoff's "per-tenant OAuth refresh tokens" is obsolete.)

:::caution
The two collection types this MVP handles are exactly the mail folder and drive Resources defined in the [Resource = delta collection](/adr/resource-equals-delta-collection/) record. Adding a third workload means revisiting both that ADR and this scope boundary.
:::

## Related

- Capture and incremental sync flow through the [backup workflow](/architecture/backup-workflow/) and [queue consumer](/architecture/queue-consumer/).
- Retention/GC and baseline restore from R2 Blobs are covered in [retention and restore](/architecture/retention-and-restore/).
- The single app secret and manual admin-consent onboarding tie back to the [throttle governance](/adr/multi-tenant-and-throttle-governance/) record.
