import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BackupItem } from '../src/types';

// Each tenant resolves to its own TenantCoordinator DO (one private SQLite),
// so these tests drive the catalog the same way production does: over the DO
// RPC stub. isolatedStorage (the pool default) resets DO storage per test, so
// tenant names can be reused across cases.

const fileItem = (id: string, version: string): BackupItem => ({
	id,
	version,
	size: 10,
	itemType: 'file',
	name: `${id}.txt`,
});

const stub = (tenantId: string) => env.TENANT.get(env.TENANT.idFromName(tenantId));

const FUTURE = 9_999_999_999_999; // cutoff well past any real valid_to_ts

describe('per-tenant catalog (DO SQLite)', () => {
	it('isolates blobs and items across tenants', async () => {
		const a = stub('tenant-A');
		const b = stub('tenant-B');
		const rk = 'drive:d1';

		const runA = await a.openRun('full', 1, 90);
		const runB = await b.openRun('full', 1, 90);

		// The SAME content hash indexed into both tenants — each catalog gets its
		// OWN blob row keyed to its OWN R2 object (no cross-tenant reference).
		await a.indexItem({
			runId: runA,
			resourceKey: rk,
			item: fileItem('x', 'v1'),
			contentHash: 'hash-shared',
			r2Key: 'tenant-A/drive:d1/x/hash-shared',
			size: 10,
		});
		await b.indexItem({
			runId: runB,
			resourceKey: rk,
			item: fileItem('x', 'v1'),
			contentHash: 'hash-shared',
			r2Key: 'tenant-B/drive:d1/x/hash-shared',
			size: 10,
		});

		expect(await a.blobExists('hash-shared')).toBe('tenant-A/drive:d1/x/hash-shared');
		expect(await b.blobExists('hash-shared')).toBe('tenant-B/drive:d1/x/hash-shared');

		// A blob that exists only in A must be invisible to B's catalog.
		await a.indexItem({
			runId: runA,
			resourceKey: rk,
			item: fileItem('y', 'v1'),
			contentHash: 'hash-A-only',
			r2Key: 'tenant-A/drive:d1/y/hash-A-only',
			size: 5,
		});
		expect(await a.blobExists('hash-A-only')).not.toBeNull();
		expect(await b.blobExists('hash-A-only')).toBeNull();

		// Point-in-time restore sees only the owning tenant's items.
		const rowsA = await a.pointInTime(runA, rk);
		const rowsB = await b.pointInTime(runB, rk);
		expect(rowsA.map((r) => r.graph_item_id).sort()).toEqual(['x', 'y']);
		expect(rowsB.map((r) => r.graph_item_id)).toEqual(['x']);
	});

	it('round-trips a content change and expires the closed version', async () => {
		const a = stub('tenant-C');
		const rk = 'drive:d1';

		const run1 = await a.openRun('full', 1, 90);
		await a.indexItem({
			runId: run1,
			resourceKey: rk,
			item: fileItem('f', 'v1'),
			contentHash: 'h1',
			r2Key: 'k1',
			size: 10,
		});

		const run2 = await a.openRun('incremental', 1, 90);
		await a.indexItem({
			runId: run2,
			resourceKey: rk,
			item: fileItem('f', 'v2'),
			contentHash: 'h2',
			r2Key: 'k2',
			size: 12,
		});

		// The version current at run2 is h2; v1 is closed.
		const rows = await a.pointInTime(run2, rk);
		expect(rows).toHaveLength(1);
		expect(rows[0].r2_key).toBe('k2');

		// GC: the closed v1 expires past the cutoff and its blob drops to 0 refs.
		const { expired, dead } = await a.expireVersions(FUTURE, 500);
		expect(expired).toBe(1);
		expect(dead.map((d) => d.content_hash)).toContain('h1');
	});

	it('treats an unchanged hash as a no-op (dedupe across runs)', async () => {
		const a = stub('tenant-D');
		const rk = 'drive:d1';

		const run1 = await a.openRun('full', 1, 90);
		await a.indexItem({
			runId: run1,
			resourceKey: rk,
			item: fileItem('g', 'v1'),
			contentHash: 'same',
			r2Key: 'k',
			size: 8,
		});

		// Re-observing the same content in a later run opens no new version.
		const run2 = await a.openRun('incremental', 1, 90);
		await a.indexItem({
			runId: run2,
			resourceKey: rk,
			item: fileItem('g', 'v1'),
			contentHash: 'same',
			r2Key: 'k',
			size: 8,
		});

		const rows = await a.pointInTime(run2, rk);
		expect(rows).toHaveLength(1);
		// Nothing expired: the single open version is still current.
		const { expired } = await a.expireVersions(FUTURE, 500);
		expect(expired).toBe(0);
	});
});
