import type { BackupItem, ItemType } from './types';

// ============================================================
// catalog — the per-tenant D1-shaped write/read path over the R2 blob store,
// running against the owning TenantCoordinator DO's SQLite (ADR 0003). Every
// function takes the DO's `storage` handle; the DO exposes them as RPC.
//
// Atomicity model: the DO SQL API (storage.sql.exec) is SYNCHRONOUS, so the
// read-then-decide and the mutations run with no await between them. The whole
// sequence is wrapped in ctx.storage.transactionSync(...) — one transaction
// that rolls back on any throw. Cursors are drained with .toArray() before the
// next exec to preserve snapshot isolation.
// ============================================================

// Full input for one observed item. The consumer guarantees the bytes are
// already in R2 at `r2Key` before calling indexItem (unless item.isDeleted).
export interface IndexItemInput {
	runId: string;
	resourceKey: string;
	item: BackupItem;
	contentHash?: string; // sha-256 of the bytes — required unless item.isDeleted
	r2Key?: string; // R2 object key — required unless item.isDeleted
	size?: number; // byte size for the blobs row
}

// Open a new run row (status=running) and return its run_id. retention_days is
// passed in (it lives in the control-plane `tenants` registry, not the DO).
export function openRun(
	storage: DurableObjectStorage,
	kind: 'full' | 'incremental',
	totalResources: number,
	retentionDays: number,
): string {
	const runId = crypto.randomUUID();
	const startedAt = Date.now();
	const expiresAt = startedAt + retentionDays * 86400000;

	storage.sql.exec(
		`INSERT INTO runs (run_id, kind, status, started_at, expires_at, total_resources)
     VALUES (?, ?, 'running', ?, ?, ?)`,
		runId,
		kind,
		startedAt,
		expiresAt,
		totalResources,
	);

	return runId;
}

// Seal the run: status=completed, finished_at set, rollups computed.
export function finalizeRun(storage: DurableObjectStorage, runId: string): void {
	storage.sql.exec(
		`UPDATE runs SET
       status = 'completed',
       finished_at = ?,
       item_count = (
         SELECT COUNT(*) FROM item_versions WHERE valid_from_run = ?
       ),
       bytes_logical = (
         SELECT COALESCE(SUM(b.size), 0)
         FROM item_versions v JOIN blobs b ON b.content_hash = v.content_hash
         WHERE v.valid_from_run = ? AND v.is_deleted = 0
       ),
       bytes_stored = (
         SELECT COALESCE(SUM(b.size), 0)
         FROM blobs b WHERE b.created_at >= (SELECT started_at FROM runs WHERE run_id = ?)
       )
     WHERE run_id = ?`,
		Date.now(),
		runId,
		runId,
		runId,
		runId,
	);
}

// Dedupe pre-check: returns the existing R2 key for a content hash, else null.
// Lets the consumer skip re-downloading/re-storing unchanged bytes.
export function blobExists(storage: DurableObjectStorage, contentHash: string): string | null {
	const row = storage.sql.exec<{ r2_key: string }>('SELECT r2_key FROM blobs WHERE content_hash = ?', contentHash).toArray()[0];
	return row?.r2_key ?? null;
}

// The atomic temporal upsert (close-old-version / open-new-version), blob
// ref_count maintenance, and tombstones — one synchronous DO transaction.
export function indexItem(storage: DurableObjectStorage, input: IndexItemInput): void {
	const { runId, resourceKey, item } = input;
	const sql = storage.sql;

	storage.transactionSync(() => {
		// Temporal anchor comes from the run row.
		const run = sql.exec<{ started_at: number }>('SELECT started_at FROM runs WHERE run_id = ?', runId).toArray()[0];
		if (!run) throw new Error(`indexItem: run ${runId} not found`);
		const ts = run.started_at;

		// Ensure the logical item row and bump last_seen_run.
		sql.exec(
			`INSERT INTO items (resource_key, graph_item_id, item_type, first_seen_run, last_seen_run)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(resource_key, graph_item_id) DO UPDATE SET last_seen_run = excluded.last_seen_run`,
			resourceKey,
			item.id,
			item.itemType,
			runId,
			runId,
		);

		const row = sql
			.exec<{ item_uid: number; content_hash: string | null }>(
				`SELECT i.item_uid AS item_uid, v.content_hash AS content_hash
         FROM items i
         LEFT JOIN item_versions v
           ON v.item_uid = i.item_uid AND v.valid_to_ts IS NULL
         WHERE i.resource_key = ? AND i.graph_item_id = ?`,
				resourceKey,
				item.id,
			)
			.toArray()[0]!;
		const itemUid = row.item_uid;
		const currentHash = row.content_hash ?? null;

		const closeCurrent = () =>
			sql.exec(
				`UPDATE item_versions SET valid_to_ts = ?, valid_to_run = ?
         WHERE item_uid = ? AND valid_to_ts IS NULL`,
				ts,
				runId,
				itemUid,
			);

		// deletion — close the live version and open a tombstone carrying the
		// prior content_hash (the FK is NOT NULL; no new blob/R2 write).
		if (item.isDeleted) {
			if (!currentHash) return; // nothing live to tombstone
			closeCurrent();
			sql.exec('UPDATE blobs SET ref_count = ref_count + 1 WHERE content_hash = ?', currentHash);
			sql.exec(
				`INSERT INTO item_versions
           (item_uid, content_hash, name, parent_path, metadata, valid_from_run, valid_from_ts, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
				itemUid,
				currentHash,
				item.name ?? null,
				item.parentPath ?? null,
				item.metadata ? JSON.stringify(item.metadata) : null,
				runId,
				ts,
			);
			return;
		}

		const contentHash = input.contentHash!;

		// hash unchanged: nothing new to store; last_seen_run already bumped.
		if (currentHash === contentHash) return;

		// hash changed: close the prior version first.
		if (currentHash) closeCurrent();

		sql.exec(
			`INSERT INTO blobs (content_hash, r2_key, size, ref_count, created_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(content_hash) DO UPDATE SET ref_count = ref_count + 1`,
			contentHash,
			input.r2Key!,
			input.size ?? item.size,
			ts,
		);

		sql.exec(
			`INSERT INTO item_versions
         (item_uid, content_hash, name, parent_path, metadata, valid_from_run, valid_from_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
			itemUid,
			contentHash,
			item.name ?? null,
			item.parentPath ?? null,
			item.metadata ? JSON.stringify(item.metadata) : null,
			runId,
			ts,
		);
	});
}

// --- restore read path -------------------------------------------------------

export type RestoreRow = {
	graph_item_id: string;
	item_type: ItemType;
	name: string | null;
	parent_path: string | null;
	metadata: string | null;
	r2_key: string;
	size: number;
};

// Point-in-time query: the version that was CURRENT at the instant of run
// :runId (valid_from_ts <= started_at < valid_to_ts), excluding tombstones.
// Placeholders bind in appearance order: (resourceKey, runId).
const POINT_IN_TIME_QUERY = `
  SELECT i.graph_item_id, i.item_type, v.name, v.parent_path,
         v.metadata, b.r2_key, b.size
  FROM runs r
  JOIN items i         ON i.resource_key = ?
  JOIN item_versions v ON v.item_uid = i.item_uid
  JOIN blobs b         ON b.content_hash = v.content_hash
  WHERE r.run_id = ?
    AND v.valid_from_ts <= r.started_at
    AND (v.valid_to_ts IS NULL OR v.valid_to_ts > r.started_at)
    AND v.is_deleted = 0
`;

export function pointInTime(storage: DurableObjectStorage, runId: string, resourceKey: string): RestoreRow[] {
	return storage.sql.exec<RestoreRow>(POINT_IN_TIME_QUERY, resourceKey, runId).toArray();
}

// --- retention/GC ------------------------------------------------------------

export type DeadBlob = {
	content_hash: string;
	r2_key: string;
	size: number;
};

// One GC page: expire closed versions past `cutoff` (decrement each blob's
// ref_count and delete the version row atomically), then return up to `limit`
// zero-ref blob candidates for the caller to delete from R2. Blob rows are NOT
// removed here — the caller deletes R2 first (tolerating Object Lock) then
// calls removeBlobs, so the catalog never orphans a still-present R2 object.
export function expireVersions(storage: DurableObjectStorage, cutoff: number, limit: number): { expired: number; dead: DeadBlob[] } {
	const sql = storage.sql;
	return storage.transactionSync(() => {
		const versions = sql
			.exec<{ version_id: number; content_hash: string }>(
				`SELECT version_id, content_hash FROM item_versions
         WHERE valid_to_ts IS NOT NULL AND valid_to_ts < ? LIMIT ?`,
				cutoff,
				limit,
			)
			.toArray();

		for (const v of versions) {
			sql.exec('UPDATE blobs SET ref_count = ref_count - 1 WHERE content_hash = ?', v.content_hash);
			sql.exec('DELETE FROM item_versions WHERE version_id = ?', v.version_id);
		}

		const dead = sql.exec<DeadBlob>('SELECT content_hash, r2_key, size FROM blobs WHERE ref_count <= 0 LIMIT ?', limit).toArray();

		return { expired: versions.length, dead };
	});
}

// Delete the catalog rows for blobs whose R2 objects the caller has removed.
export function removeBlobs(storage: DurableObjectStorage, hashes: string[]): void {
	if (hashes.length === 0) return;
	const sql = storage.sql;
	storage.transactionSync(() => {
		for (const h of hashes) {
			sql.exec('DELETE FROM blobs WHERE content_hash = ?', h);
		}
	});
}
