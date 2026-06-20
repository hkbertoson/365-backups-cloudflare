import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runRetention } from '../src/retention';
import type { BackupItem } from '../src/types';

// Integration test for runRetention: it walks the control-plane `tenants` table
// in env.DB (D1) to decide which tenants to GC + at what retention, then drives
// each tenant's TenantCoordinator DO to expire closed versions and delete the
// now-orphaned blobs from env.BLOBS (R2).
//
// Determinism trick (see catalog.ts openRun): openRun stamps started_at ~ now,
// so a freshly-closed version's valid_to_ts ~ now. runRetention's cutoff is
// now - retention_days*DAY. A positive retention_days puts the cutoff in the
// PAST, so nothing expires. We seed retention_days = -1 (cutoff = now + 1 day),
// putting the just-closed version BEFORE the cutoff so it expires immediately.
// The migration's CHECK (retention_days > 0) would reject -1, so the test
// creates its OWN tenants table WITHOUT that constraint.

const stub = (tenantId: string) => env.TENANT.get(env.TENANT.idFromName(tenantId));

const fileItem = (id: string, version: string, size: number): BackupItem => ({
	id,
	version,
	size,
	itemType: 'file',
	name: `${id}.txt`,
});

const deletedItem = (id: string): BackupItem => ({
	id,
	version: '',
	size: 0,
	itemType: 'file',
	isDeleted: true,
});

// The control-plane registry without the CHECK constraints, so we can seed a
// negative retention_days and force the GC cutoff into the future.
async function createTenantsTable(): Promise<void> {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS tenants (
			tenant_id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			backup_enabled INTEGER NOT NULL DEFAULT 1,
			schedule_cron TEXT,
			retention_days INTEGER NOT NULL DEFAULT 90,
			last_run_id TEXT,
			last_run_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	).run();
}

async function insertTenant(tenantId: string, retentionDays: number, backupEnabled = 1): Promise<void> {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO tenants (tenant_id, display_name, backup_enabled, retention_days, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(tenantId, tenantId, backupEnabled, retentionDays, now, now)
		.run();
}

// Seed one closed, content-bearing version + its R2 blob: index 'h1' under a
// full run, then a deletion tombstone under a later incremental run closes the
// h1 version (valid_to_ts ~ run2.started_at) and opens a blobless tombstone, so
// h1's blob drops to zero refs once the closed version expires.
async function seedClosedVersion(tenantId: string, r2Key: string, size: number): Promise<void> {
	const s = stub(tenantId);
	const rk = 'drive:d1';
	const run1 = await s.openRun('full', 1, 90);
	await env.BLOBS.put(r2Key, new Uint8Array(Array.from({ length: size }, (_, i) => i + 1)));
	await s.indexItem({ runId: run1, resourceKey: rk, item: fileItem('f', 'v1', size), contentHash: 'h1', r2Key, size });

	const run2 = await s.openRun('incremental', 1, 90);
	await s.indexItem({ runId: run2, resourceKey: rk, item: deletedItem('f') });
}

describe('runRetention (D1 + DO + R2 integration)', () => {
	beforeEach(async () => {
		await createTenantsTable();
		// D1 storage is not reset between tests in this file, so clear any rows
		// seeded by a prior case before re-using tenant ids.
		await env.DB.prepare('DELETE FROM tenants').run();
	});

	it('expires closed versions and deletes orphaned blobs for an enabled tenant', async () => {
		await insertTenant('tenant-gc', -1);
		await seedClosedVersion('tenant-gc', 'k1', 3);

		expect(await env.BLOBS.get('k1')).not.toBeNull();

		const result = await runRetention(env);

		expect(result.versionsExpired).toBeGreaterThanOrEqual(1);
		expect(result.blobsDeleted).toBeGreaterThanOrEqual(1);
		expect(result.bytesReclaimed).toBe(3);

		// The R2 object backing the dead blob is gone.
		expect(await env.BLOBS.get('k1')).toBeNull();

		// The catalog row was removed (no surviving zero-ref blob to re-collect).
		expect(await stub('tenant-gc').blobExists('h1')).toBeNull();
	});

	it('honors the explicit single-tenant form runRetention(env, tenantId)', async () => {
		await insertTenant('tenant-gc', -1);
		await seedClosedVersion('tenant-gc', 'k1', 3);

		const result = await runRetention(env, 'tenant-gc');

		expect(result.versionsExpired).toBeGreaterThanOrEqual(1);
		expect(result.blobsDeleted).toBeGreaterThanOrEqual(1);
		expect(result.bytesReclaimed).toBe(3);
		expect(await env.BLOBS.get('k1')).toBeNull();
	});

	it('is a no-op when the cutoff is in the past (positive retention)', async () => {
		// retention_days = 90 -> cutoff = now - 90d, far before any valid_to_ts.
		await insertTenant('tenant-keep', 90);
		await seedClosedVersion('tenant-keep', 'k1', 3);

		const result = await runRetention(env);

		expect(result).toEqual({ versionsExpired: 0, blobsDeleted: 0, bytesReclaimed: 0 });
		// The closed version survives, so its blob's R2 object is untouched.
		expect(await env.BLOBS.get('k1')).not.toBeNull();
		expect(await stub('tenant-keep').blobExists('h1')).not.toBeNull();
	});

	it('returns zeros for a tenant with no closed versions to expire', async () => {
		await insertTenant('tenant-empty', -1);
		// One open version, never closed -> nothing past the cutoff.
		const s = stub('tenant-empty');
		const run1 = await s.openRun('full', 1, 90);
		await env.BLOBS.put('open-key', new Uint8Array([9]));
		await s.indexItem({
			runId: run1,
			resourceKey: 'drive:d1',
			item: fileItem('g', 'v1', 1),
			contentHash: 'hopen',
			r2Key: 'open-key',
			size: 1,
		});

		const result = await runRetention(env, 'tenant-empty');

		expect(result).toEqual({ versionsExpired: 0, blobsDeleted: 0, bytesReclaimed: 0 });
		expect(await env.BLOBS.get('open-key')).not.toBeNull();
	});
});
