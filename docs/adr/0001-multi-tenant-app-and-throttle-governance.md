# Single multi-tenant Graph app + conservative reactive throttling (v1)

m365vault authenticates to Microsoft Graph as **one multi-tenant Azure AD app**, admin-consented per customer tenant and called app-only (client-credentials), rather than registering a separate app per customer. Throttle governance for v1 is a **single conservative per-tenant token bucket** in the `TenantCoordinator` Durable Object plus **reactive backoff**: honor `Retry-After`, and `max(Retry-After, RateLimit-Reset)` when the preview `RateLimit` headers are present. We deliberately do _not_ do resource-unit accounting, per-service (mail vs files) buckets, or egress-byte budgeting yet.

## Considered Options

- **Per-tenant app registrations** — rejected. Heavier onboarding (an app + secret per customer) and _no_ throttling benefit: SharePoint/OneDrive limits are already per-app-per-tenant and isolated across tenants, and Microsoft explicitly warns that minting multiple app IDs for one backup workload just exhausts the tenant's shared resource budget.
- **Adaptive limiter** (drive rate from `RateLimit-Remaining`, RU accounting, separate mail/files buckets, egress budget) — deferred. This is the documented "right" answer but tunes against limits Microsoft keeps dynamic; it's the upgrade path if we hit real walls, not v1.

## Consequences

- All ~100 customer tenants share **one app identity**, so the global per-app ceiling (130,000 requests / 10s across all tenants) is a shared resource. Fine at this scale (~800 req/s) but must be watched as tenant count grows.
- The conservative bucket (`CAP=30`, `REFILL=8/s`) **under-utilizes** per-tenant budgets (SharePoint allows ~1,250 resource-units/min even for a ≤1,000-license tenant). Throughput is sacrificed, not correctness — the right trade for a backup product.
- The request-counting bucket is **blind to the egress limit** (400 GB/hr per app per tenant) and to Exchange's separate budget; both are handled reactively via 429 + `Retry-After`, not predicted.
- Traffic must be **decorated** with `User-Agent: ISV|Company|App/Version` to get prioritized — a required v1 fix in the Graph client.
