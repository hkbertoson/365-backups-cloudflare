import { createGraphClient, type GraphClient, isCursorInvalid, isThrottled, retryAfterSeconds } from './graph';
import { type BackupItem, type BackupJob, MULTIPART_THRESHOLD, resourceKey, tenantStub } from './types';

// The per-tenant DO stub — the catalog now lives in the tenant's DO SQLite,
// so blobExists/indexItem are RPC methods on this stub (ADR 0003).
type Coordinator = ReturnType<typeof tenantStub>;

// ============================================================
// consumer — the queue consumer that does the real work:
// Graph -> R2 (bytes) + D1 (index). One message == one PAGE of one resource.
// Pages re-enqueue themselves; the last page advances the delta cursor.
// ============================================================

const MULTIPART_PART_SIZE = MULTIPART_THRESHOLD; // 8 MiB parts for large items

export async function handleBackupBatch(batch: MessageBatch<BackupJob>, env: Env): Promise<void> {
	const graph = createGraphClient(env);

	for (const msg of batch.messages) {
		const job = msg.body;
		const coordinator = tenantStub(env, job.tenantId);
		const key = resourceKey(job.resource);

		// Spend a rate token before touching Graph. No token -> back off & retry.
		const waitMs = await coordinator.takeToken();
		if (waitMs > 0) {
			msg.retry({ delaySeconds: Math.ceil(waitMs / 1000) });
			continue;
		}

		try {
			const cursor = job.cursor ?? (await coordinator.getCursor(key));
			const page = await graph.deltaPage(job.tenantId, job.resource, cursor);

			for (const item of page.items) {
				if (item.isDeleted) {
					// Tombstone: source removed it. Index the deletion, no bytes.
					await coordinator.indexItem({ runId: job.runId, resourceKey: key, item });
					continue;
				}
				await persistItem(env, graph, coordinator, job, key, item);
			}

			if (page.nextLink) {
				// More pages for THIS resource — re-enqueue, do NOT tick the counter.
				await env.BACKUP_QUEUE.send({ ...job, cursor: page.nextLink });
			} else {
				// Resource fully synced — save the new delta cursor + decrement.
				await coordinator.setCursor(key, page.deltaLink ?? null);
				await coordinator.decrOutstanding();
			}
			msg.ack();
		} catch (e) {
			if (isThrottled(e)) {
				msg.retry({ delaySeconds: retryAfterSeconds(e) });
			} else if (isCursorInvalid(e)) {
				// Delta token expired/invalid — drop it so the next attempt resyncs.
				await coordinator.setCursor(key, null);
				msg.retry({ delaySeconds: 5 });
			} else {
				msg.retry(); // exhausted retries dead-letter automatically
			}
		}
	}
}

// Download an item's bytes, dedupe on content hash, write to R2 if new, index it.
async function persistItem(
	env: Env,
	graph: GraphClient,
	coordinator: Coordinator,
	job: BackupJob,
	key: string,
	item: BackupItem,
): Promise<void> {
	if (item.size > MULTIPART_THRESHOLD) {
		await persistLargeItem(env, graph, coordinator, job, key, item);
		return;
	}

	// Small item: buffer the bytes and content-address them with a true
	// sha-256 of the content — this is what makes cross-mailbox / cross-run
	// dedupe exact.
	const bytes = await graph.download(job.tenantId, item);
	const hash = await sha256Hex(bytes);

	const existing = await coordinator.blobExists(hash);
	const r2Key = existing ?? blobKey(job, key, item, hash);
	if (!existing) await env.BLOBS.put(r2Key, bytes);

	await coordinator.indexItem({
		runId: job.runId,
		resourceKey: key,
		item,
		contentHash: hash,
		r2Key,
		size: item.size,
	});
}

// Large item: stream to an R2 multipart upload so no single buffer ever holds
// the whole object (Workers can't hold a 10 GB file in memory). Buffering the
// full stream just to content-hash it would defeat that, so large items use
// Graph's etag/cTag (`item.version`) as identity instead of a byte hash:
// dedupe here is version-keyed, not content-keyed. Unchanged large files still
// dedupe (same version => skip), but two byte-identical large files with
// different etags are stored twice. The hash column stays populated so the
// catalog/ref-count machinery is uniform across both paths.
async function persistLargeItem(
	env: Env,
	graph: GraphClient,
	coordinator: Coordinator,
	job: BackupJob,
	key: string,
	item: BackupItem,
): Promise<void> {
	const hash = `etag:${item.version}`;
	const existing = await coordinator.blobExists(hash);
	let r2Key = existing;

	if (!existing) {
		r2Key = blobKey(job, key, item, hash);
		const stream = await graph.downloadStream(job.tenantId, item);
		await streamToMultipart(env.BLOBS, r2Key, stream);
	}

	await coordinator.indexItem({
		runId: job.runId,
		resourceKey: key,
		item,
		contentHash: hash,
		r2Key: r2Key!,
		size: item.size,
	});
}

// Pump a byte stream into an R2 multipart upload, buffering up to one part at
// a time. Aborts the upload on failure so no orphaned parts linger.
async function streamToMultipart(bucket: R2Bucket, key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
	const upload = await bucket.createMultipartUpload(key);
	try {
		const parts: R2UploadedPart[] = [];
		const reader = stream.getReader();
		let buffered: Uint8Array[] = [];
		let bufferedBytes = 0;
		let partNumber = 1;

		const flush = async () => {
			const part = await upload.uploadPart(partNumber, concat(buffered));
			parts.push(part);
			partNumber++;
			buffered = [];
			bufferedBytes = 0;
		};

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered.push(value);
			bufferedBytes += value.byteLength;
			if (bufferedBytes >= MULTIPART_PART_SIZE) await flush();
		}
		if (bufferedBytes > 0 || parts.length === 0) await flush();

		await upload.complete(parts);
	} catch (e) {
		await upload.abort();
		throw e;
	}
}

const blobKey = (job: BackupJob, key: string, item: BackupItem, hash: string): string => `${job.tenantId}/${key}/${item.id}/${hash}`;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}
