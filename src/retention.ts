import { tenantStub } from './types';

// ============================================================
// retention — scheduled GC, run per-tenant. The tenant list + retention_days
// come from the control-plane registry (env.DB); the actual expiry runs inside
// each tenant's DO (no D1 1k-query/invocation cap there). Each page: the DO
// expires closed versions past retention and decrements blobs.ref_count, then
// returns zero-ref blobs; we delete those R2 objects and tell the DO to drop
// the rows. R2 Object Lock enforces an independent immutability floor, so a
// delete inside the locked window is tolerated and the blob row is left in
// place (never orphaning a still-present R2 object from the catalog).
// ============================================================

const DAY_MS = 86_400_000;
const PAGE = 500; // expired versions settled per DO call

export interface RetentionResult {
	versionsExpired: number;
	blobsDeleted: number;
	bytesReclaimed: number;
}

// Run GC for one tenant (or all enabled tenants if tenantId omitted).
export async function runRetention(env: Env, tenantId?: string): Promise<RetentionResult> {
	const result: RetentionResult = {
		versionsExpired: 0,
		blobsDeleted: 0,
		bytesReclaimed: 0,
	};

	const tenants = tenantId
		? await env.DB.prepare('SELECT tenant_id, retention_days FROM tenants WHERE tenant_id = ?')
				.bind(tenantId)
				.all<{ tenant_id: string; retention_days: number }>()
		: await env.DB.prepare('SELECT tenant_id, retention_days FROM tenants WHERE backup_enabled = 1').all<{
				tenant_id: string;
				retention_days: number;
			}>();

	for (const t of tenants.results) {
		await gcTenant(env, t.tenant_id, Date.now() - t.retention_days * DAY_MS, result);
	}

	return result;
}

async function gcTenant(env: Env, tenantId: string, cutoff: number, result: RetentionResult): Promise<void> {
	const coordinator = tenantStub(env, tenantId);

	for (;;) {
		const { expired, dead } = await coordinator.expireVersions(cutoff, PAGE);
		result.versionsExpired += expired;

		if (dead.length > 0) {
			const deleted: string[] = [];
			for (const b of dead) {
				try {
					await env.BLOBS.delete(b.r2_key);
				} catch {
					continue; // Object Lock window — leave the blob row in place
				}
				deleted.push(b.content_hash);
				result.blobsDeleted += 1;
				result.bytesReclaimed += b.size;
			}
			await coordinator.removeBlobs(deleted);
		}

		if (expired < PAGE) break;
	}
}
