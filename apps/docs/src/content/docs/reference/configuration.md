---
title: Configuration
description: Operational knobs for m365vault — cron schedules, the tenants registry, retention and GC cutoff, the token-bucket governor, lease TTL, and the multipart threshold.
---

This page collects the operational settings that govern _when_ m365vault runs, _which_ Tenants it backs up, and _how hard_ it drives Microsoft Graph. For the bindings these settings attach to, see [bindings](/reference/bindings/); for the rate governor and lease they configure, see [the Tenant coordinator](/architecture/tenant-coordinator/).

## Cron schedules

Declared under `triggers.crons` in `wrangler.jsonc`:

| Schedule    | Trigger                     | What it does                                                                                       |
| ----------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `0 3 * * *` | Daily backup                | Reads `tenants` from D1 and starts a `BackupWorkflow` for each Tenant where `backup_enabled = 1`.  |
| `0 4 * * 0` | Weekly retention / GC sweep | Expires Item Versions past the retention cutoff and reclaims Blobs whose `ref_count` reaches zero. |

The retention sweep runs one hour after the daily backup, and weekly rather than nightly, so GC never races a Run that is still writing.

## Tenant registry

The control-plane `tenants` table (in D1) is the source of truth for what gets backed up. Three columns drive scheduling and retention:

| Field            | Meaning                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup_enabled` | `0`/`1` gate. The daily cron only starts a Workflow when this is `1`. Defaults to `1`.                                                               |
| `retention_days` | Days of history to keep. Anchors each Run's `expires_at` (`started_at + retention`) and therefore the GC cutoff. Must be positive; defaults to `90`. |
| `schedule_cron`  | Optional per-Tenant cron expression (e.g. `'0 3 * * *'`) for the backup schedule.                                                                    |

See the full column list in [the data model](/reference/data-model/).

## Retention and GC cutoff

A Run's data lives until its `runs.expires_at`, computed as `started_at + retention_days`. The weekly sweep calls `expireVersions(cutoff, limit)` on each Tenant's `TenantCoordinator`: closed Item Versions whose `valid_to_ts` falls before the cutoff are expired (using the `idx_versions_closed` partial index), and any Blob whose `ref_count` drops to zero is removed from both the catalog and R2 via `removeBlobs`. Tombstones keep their bytes only until that cutoff.

## Token-bucket governor

`TenantCoordinator` runs a per-Tenant token bucket to stay under Microsoft Graph's per-tenant/per-service throttling limits. The two constants live in `src/coordinator.ts`:

```ts
static CAP = 30;          // allowed burst (max tokens)
static REFILL_PER_SEC = 8; // steady-state refill rate
```

- `CAP` is the maximum burst — the bucket starts full and never exceeds this.
- `REFILL_PER_SEC` is the sustained request rate once the burst is spent.

`takeToken()` returns `0` when a token is available (proceed now) or the number of milliseconds to wait before retrying. Tune both to the Graph throttling envelope for the workload.

:::note
Token denial is flow-control, not failure: the consumer re-enqueues a fresh message after the returned delay rather than consuming a retry. That is why the queue's `max_retries` is set high (see [bindings](/reference/bindings/)).
:::

## Lease TTL

Only one Run executes per Tenant at a time. `acquireLease()` stores `Date.now()` under the `lease` key and refuses a new lease while the existing one is younger than `LEASE_TTL_MS`. From `src/types.ts`:

```ts
export const LEASE_TTL_MS = 6 * 60 * 60 * 1000; // 6h safety net on a stuck run
```

The 6-hour TTL is a safety net: if a Run crashes without calling `releaseLease()`, the stale lease self-expires so the next daily cron can proceed. A Seed (the first full backup) can legitimately run for hours, so the window is generous.

## Multipart threshold

Objects larger than this are streamed to R2 instead of being buffered in memory. From `src/types.ts`:

```ts
export const MULTIPART_THRESHOLD = 8 * 1024 * 1024; // 8 MiB — stream anything bigger
```

Anything at or below 8 MiB is downloaded and hashed in full (true sha-256 content address); anything larger is streamed and never fully buffered, so it is content-addressed by a Graph `etag:` surrogate instead.
