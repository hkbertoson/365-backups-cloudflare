import type { RestoreRow } from './catalog';
import { createGraphClient } from './graph';
import { type BackupItem, tenantStub } from './types';

// ============================================================
// restore — the reverse path. Read the tenant's catalog (a point-in-time
// temporal query, now served by the tenant's DO) for a restore point, fetch
// each referenced blob from R2, and write it back through Graph.
//
// Restore FIDELITY is the hard half (permissions, version history, folder
// placement, immutable ids, conflict handling) — the graph.writeBack gaps are
// documented at the call site; here we drive the loop and tally results.
// ============================================================

export interface RestoreParams {
	tenantId: string;
	runId: string; // the restore point (its started_at anchors the query)
	resourceKey: string;
}

export interface RestoreResult {
	itemsRestored: number;
	itemsFailed: number;
}

export async function restore(env: Env, params: RestoreParams): Promise<RestoreResult> {
	const graph = createGraphClient(env);
	const coordinator = tenantStub(env, params.tenantId);
	const results = await coordinator.pointInTime(params.runId, params.resourceKey);

	let itemsRestored = 0;
	let itemsFailed = 0;

	for (const row of results) {
		try {
			const blob = await env.BLOBS.get(row.r2_key);
			if (!blob) {
				// Index references a blob that's gone from R2 (GC bug, or a locked
				// object deleted out of band). Count as failed rather than crash.
				itemsFailed++;
				continue;
			}
			const item = rowToItem(row);
			// Stream large blobs; buffer small ones. Graph's writeBack accepts
			// either. We thread R2's body stream straight through to avoid
			// buffering multi-GB files in the isolate.
			const body = row.size > 8 * 1024 * 1024 ? blob.body : await blob.arrayBuffer();
			await graph.writeBack(params.tenantId, params.resourceKey, item, body);
			itemsRestored++;
		} catch {
			// Per-item failure (conflict, throttling, permission) shouldn't abort
			// the whole restore. Surface the count; a retry/repair pass is future
			// work (no partial-restore resume cursor in this baseline).
			itemsFailed++;
		}
	}

	return { itemsRestored, itemsFailed };
}

function rowToItem(row: RestoreRow): BackupItem {
	return {
		id: row.graph_item_id,
		version: '',
		size: row.size,
		itemType: row.item_type,
		name: row.name ?? undefined,
		parentPath: row.parent_path ?? undefined,
		metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
	};
}
