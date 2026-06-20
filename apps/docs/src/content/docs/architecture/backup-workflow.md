---
title: Backup workflow
description: The step sequence of the per-Run BackupWorkflow — how it leases the Tenant, discovers Resources, fans out the Queue, drains the counter, and finalizes a Restore Point durably.
---

`BackupWorkflow` is the per-[Run](/concepts/domain-glossary/) "brain": one
instance per [Tenant](/concepts/domain-glossary/) per day, started by the daily
cron with `env.BACKUP_WORKFLOW.create({ params: { tenantId } })`. It is a
Cloudflare Workflow (`WorkflowEntrypoint`), so every `step.do(...)` checkpoints
its result — a crash or eviction resumes from the last completed step rather
than restarting the Run. Its single payload field is `tenantId`.

## The run() step sequence

`run()` resolves the Tenant's [TenantCoordinator](/architecture/tenant-coordinator/)
stub (`tenantStub(env, tenantId)`) and then executes these steps in order:

1. **`acquire-lease`** — calls `coordinator.acquireLease()`. The lease
   serializes Runs: only one BackupWorkflow may be in flight per Tenant. If a
   Run is already holding the lease, `acquired` is `false` and `run()` returns
   cleanly without doing any work.

2. **`discover-users`** — `graph.listUsers(tenantId)`, the mailbox/OneDrive
   owners.

3. **`discover-sites`** — `graph.listSites(tenantId)`, the site drives. (Sites
   are deferred from MVP scope but the step is present.)

4. **`discover-folders:<userId>`** — one step _per user_. Each calls
   `graph.listMailFolders(tenantId, userId)` to walk that mailbox's folder
   tree into mail-folder [Resources](/concepts/domain-glossary/). Splitting
   discovery per mailbox gives each folder-tree walk its own subrequest budget;
   a single combined step would exceed the ~1,000-subrequest-per-invocation
   limit at the ~300-mailbox ceiling. The Resources accumulate into one `scope`
   array (`[...folders, ...sites]`), so `scope.length` is known before the Run
   opens.

5. **`open-run`** — reads `retention_days` for the Tenant from the
   control-plane registry (`env.DB`), falling back to a safe minimum of `30`
   when the row is missing (a `0` would set `expiresAt == startedAt` and make
   the Run GC-eligible the instant it opens). Then calls
   `coordinator.openRun('incremental', scope.length, retentionDays)`, which
   writes the Run row into the Tenant's catalog and returns its `runId`. This
   Run _is_ the [Restore Point](/concepts/domain-glossary/).

6. **`prime-counter`** — `coordinator.setOutstanding(scope.length)` sets the
   completion counter to the Resource count. The counter is the drain signal.

7. **`fan-out`** — for each Resource, sends one message to `BACKUP_QUEUE`:
   `{ tenantId, runId, resource, cursor: null }`. `cursor: null` tells the
   [queue consumer](/architecture/queue-consumer/) to use the stored
   [Delta Cursor](/concepts/domain-glossary/) (or do a full resync if none
   exists yet — a [Seed](/concepts/domain-glossary/)).

8. **`await-drain`** — a `while ((await coordinator.outstanding()) > 0)` loop
   that `step.sleep('await-drain', '30 seconds')` between polls. Each consumer
   decrements the counter once per Resource fully synced. Sleeping cheaply
   between polls keeps multi-hour Seeds within Workflow limits.

9. **`finalize`** — once the counter hits zero, `coordinator.finalizeRun(runId)`
   seals the Run as a completed Restore Point.

10. **`release-lease`** — in a `finally`, `coordinator.releaseLease()` so the
    lease is always freed even if the Run throws, leaving the next day's Run
    free to acquire it.

```ts
const acquired = await step.do('acquire-lease', async () => {
	const lease = await coordinator.acquireLease();
	return lease.acquired;
});
if (!acquired) return;

try {
	const users = await step.do('discover-users', () => graph.listUsers(tenantId));
	const sites = await step.do('discover-sites', () => graph.listSites(tenantId));
	const folders: Resource[] = [];
	for (const userId of users) {
		const f = await step.do(`discover-folders:${userId}`, () => graph.listMailFolders(tenantId, userId));
		folders.push(...f);
	}
	const scope: Resource[] = [...folders, ...sites];
	// open-run, prime-counter, fan-out ...
	while ((await coordinator.outstanding()) > 0) {
		await step.sleep('await-drain', '30 seconds');
	}
	await step.do('finalize', () => coordinator.finalizeRun(runId));
} finally {
	await step.do('release-lease', () => coordinator.releaseLease());
}
```

## Why it's durable and resumable

Each `step.do(...)` is a checkpoint: Workflows persist its return value, so on
resume completed steps are skipped and replay continues from the first
unfinished one. This matters because a [Seed](/concepts/domain-glossary/) — the
first full backup of a Tenant — can run for hours, far longer than any single
Worker invocation. The expensive discovery steps (`discover-users`,
`discover-sites`, the per-mailbox `discover-folders`) never re-enumerate Graph
on resume, and the `await-drain` loop's cheap sleeps let the orchestration
outlive the consumers it's waiting on.

:::note
The Workflow only _orchestrates_. It never touches Microsoft Graph item bytes
or R2 — discovery enumerates Scope Containers into Resources, then the
[queue consumer](/architecture/queue-consumer/) does the byte-level capture.
The Workflow's only feedback channel is the outstanding counter the consumers
decrement.
:::

## The lease and the counter

Two pieces of `TenantCoordinator` state make the Run safe and observable:

- **The lease** guarantees one Run per Tenant. It has a 6-hour TTL safety net
  (`LEASE_TTL_MS`) so a Workflow that dies between `acquire-lease` and
  `release-lease` cannot wedge the Tenant forever — the next day's Run can take
  a stale lease.
- **The outstanding counter** counts Resources, not pages or mailboxes. It is
  primed to `scope.length`, decremented once when a Resource reaches its final
  delta page, and read by `await-drain`. When it drains to zero, every Resource
  is fully captured and the Run can finalize.

See [tenant coordinator](/architecture/tenant-coordinator/) for how the lease,
counter, and Delta Cursors are stored, and
[queue consumer](/architecture/queue-consumer/) for what each fanned-out
message does.
