---
title: Queue consumer
description: How the queue consumer turns one message — one page of one Resource — into bytes in R2 and rows in the catalog, with rate-token flow control, delta paging, and error recovery.
---

The queue consumer is the worker that does the real capture: Microsoft Graph
into R2 (bytes) and the catalog (index). Its contract is deliberately uniform —
**one message == one page of one [Resource](/concepts/domain-glossary/)**. A
[BackupJob](/reference/data-model/) message carries
`{ tenantId, runId, resource, cursor }`. Pages re-enqueue themselves; the final
page advances the [Delta Cursor](/concepts/domain-glossary/). The Worker's
`queue` handler hands each `MessageBatch` to `handleBackupBatch`, which loops
the messages one at a time.

## Spend a rate token first

Before touching Graph, the consumer spends a token from the Tenant's rate
governor: `const waitMs = await coordinator.takeToken()`. Token denial
(`waitMs > 0`) is **flow control, not failure** — under heavy fan-out it is the
common case, not an error.

This is the load-bearing distinction. Calling `msg.retry()` on a denied token
would charge the delivery against `max_retries` and eventually dead-letter
_healthy_ work whose only problem was back-pressure. So instead the consumer
**re-enqueues a fresh copy and acks the current delivery**, resetting the
attempt count:

```ts
const waitMs = await coordinator.takeToken();
if (waitMs > 0) {
	const delaySeconds = Math.ceil(waitMs / 1000) + Math.floor(Math.random() * 6);
	try {
		await env.BACKUP_QUEUE.send(job, { delaySeconds });
		msg.ack();
	} catch {
		// rare queue-send failure: fall back to retry so the message stays alive
		msg.retry({ delaySeconds });
	}
	continue;
}
```

The jitter (`Math.random() * 6`) de-syncs the denied herd so they don't all
re-arrive in lockstep. A rare `send` failure (transient or throughput ceiling)
falls back to `msg.retry()` so the message is never dropped. This decoupling of
token-denial flow control from the retry budget is why `max_retries` can sit at
25 in `wrangler.jsonc` without dead-lettering throttled-but-healthy work — see
[tenant coordinator](/architecture/tenant-coordinator/) for the token-bucket
sizing (`CAP=30`, `REFILL_PER_SEC=8`).

## Delta paging

With a token in hand, the consumer resolves the cursor and fetches a page:

```ts
const cursor = job.cursor ?? (await coordinator.getCursor(key));
const page = await graph.deltaPage(job.tenantId, job.resource, cursor);
```

`job.cursor` is the per-page continuation (a Graph `nextLink`); when it's
`null` the consumer falls back to the Resource's stored Delta Cursor (or a full
resync — a [Seed](/concepts/domain-glossary/) — if none exists). It then walks
`page.items`, and at the end of the page chooses one of two transitions:

- **`page.nextLink` present** — more pages remain for _this_ Resource. Re-enqueue
  `{ ...job, cursor: page.nextLink }` and do **not** touch the completion
  counter.
- **No `nextLink`** — the Resource is fully synced. Persist the new cursor with
  `coordinator.setCursor(key, page.deltaLink ?? null)` and then
  `coordinator.decrOutstanding()`. That single decrement is what the
  [BackupWorkflow](/architecture/backup-workflow/)'s `await-drain` loop is
  waiting on.

Either way the delivery ends with `msg.ack()`.

## Persisting items

Each non-deleted Item is downloaded and content-addressed. The path forks on
size at `MULTIPART_THRESHOLD` (8 MiB):

- **Small items (≤ 8 MiB)** — buffer the bytes, compute a true **sha-256**
  content hash, and use it as the content address. `coordinator.blobExists(hash)`
  checks the per-Tenant `blobs` table; on a hit, the existing R2 key is reused
  (dedupe) and no upload happens; on a miss, `env.BLOBS.put(r2Key, bytes)`
  stores the [Blob](/concepts/domain-glossary/). This exact byte hash is what
  makes cross-mailbox and cross-Run dedupe exact.
- **Large items (> 8 MiB)** — streamed into an R2 multipart upload so no single
  buffer ever holds the whole object (a Worker can't hold a 10 GB file in
  memory). Because the stream is never fully buffered, it can't be byte-hashed,
  so the content address is a Graph **etag surrogate** — `etag:${item.version}`.
  Dedupe here is etag-keyed: an unchanged large file has the same etag and is
  skipped, but two byte-identical large files with different etags are stored
  twice. The multipart upload aborts on failure so no orphaned parts linger.

A deleted Item (`item.isDeleted`, a delta [Tombstone](/concepts/domain-glossary/))
is indexed as a deletion with no bytes. Every Item — new, changed, or
tombstoned — ends in `coordinator.indexItem(...)`, which writes the
[Item Version](/concepts/domain-glossary/) row and reference-counts the Blob.
The R2 key layout is `${tenantId}/${resourceKey}/${item.id}/${hash}`. See
[storage and catalog](/architecture/storage-and-catalog/) for the catalog
schema and ref-counting.

## Error handling

The capture block is wrapped in a `try/catch` that classifies Graph errors:

| Condition           | Detection                                                                                      | Recovery                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Throttled (429)** | `isThrottled(e)` — status `429` or code `TooManyRequests` / `activityLimitReached`             | `msg.retry({ delaySeconds: retryAfterSeconds(e) })` — honor the `Retry-After` header (default 30s).                                                |
| **Cursor invalid**  | `isCursorInvalid(e)` — status `410 Gone`, code `syncStateNotFound`, or a `resyncChanges*` code | `coordinator.setCursor(key, null)` to drop the expired Delta Cursor, then `msg.retry({ delaySeconds: 5 })` so the next attempt does a full resync. |
| **Anything else**   | fallthrough                                                                                    | `msg.retry()` — exhausted retries dead-letter automatically to `backup-dlq`.                                                                       |

:::caution
A throttle 429 _is_ a genuine error and rightly consumes a retry with its
`Retry-After` backoff. That is different from token denial above, which is
proactive flow control that never spends the retry budget. Keeping the two
apart is what protects healthy work from being dead-lettered under load.
:::
