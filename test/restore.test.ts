import { adminSecretsStore, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restore } from '../src/restore';
import type { BackupItem } from '../src/types';

const RESOURCE_KEY = 'drive:d1';

// Route a stubbed global fetch by URL substring (first match wins). The writeBack
// PUT (...:/content) returns a NON-JSON 200 body; the OAuth token route returns
// JSON. Records every call so tests can assert the PUT fired (or didn't).
type Route = { when: string; json?: unknown; raw?: Response; status?: number };
function stubFetch(routes: Route[]) {
	const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		const route = routes.find((r) => url.includes(r.when));
		if (!route) throw new Error(`unexpected fetch: ${url}`);
		if (route.raw) return route.raw.clone();
		return new Response(JSON.stringify(route.json), {
			status: route.status ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

const TOKEN_ROUTE: Route = { when: '/oauth2/v2.0/token', json: { access_token: 'tok', expires_in: 3600 } };
// writeBack PUTs to ${GRAPH}/drives/d1/root:/<path>:/content (drive id from the
// 'drive:d1' resourceKey split). Non-JSON 200 body.
const WRITEBACK_ROUTE: Route = { when: '/drives/d1/root:', raw: new Response(null, { status: 200 }) };

const fileItem: BackupItem = { id: 'i1', version: 'v1', size: 10, itemType: 'file', name: 'a.txt' };

const stub = (tenantId: string) => env.TENANT.get(env.TENANT.idFromName(tenantId));

// Seed the token inputs for a tenant (KV client id + Secrets Store app secret).
async function seedAuth(tenantId: string): Promise<void> {
	await env.CONFIG.put(`graph:client_id:${tenantId}`, 'client-abc');
	await adminSecretsStore(env.GRAPH_APP_SECRET).create('app-secret');
}

// Open a run and index the file item under it, returning the run id (the restore
// point the item is current in).
async function seedRun(tenantId: string, r2Key: string): Promise<string> {
	const s = stub(tenantId);
	const runId = await s.openRun('full', 1, 90);
	await s.indexItem({ runId, resourceKey: RESOURCE_KEY, item: fileItem, contentHash: 'h', r2Key, size: 10 });
	return runId;
}

describe('restore (integration: DO catalog + R2 + stubbed Graph)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('happy path: restores the file and PUTs it back to the drive content URL', async () => {
		const tenantId = 'tenant-restore-ok';
		await seedAuth(tenantId);
		const runId = await seedRun(tenantId, 'rk-ok');
		await env.BLOBS.put('rk-ok', new Uint8Array(10));
		const spy = stubFetch([TOKEN_ROUTE, WRITEBACK_ROUTE]);

		const result = await restore(env, { tenantId, runId, resourceKey: RESOURCE_KEY });

		expect(result).toEqual({ itemsRestored: 1, itemsFailed: 0 });

		const put = spy.mock.calls.find(([input, init]) => String(input).includes('/drives/d1/root:') && init?.method === 'PUT');
		expect(put).toBeDefined();
		expect(String(put?.[0])).toContain('/drives/d1/root:/a.txt:/content');
	});

	it('missing blob: counts the item failed and never attempts a writeBack PUT', async () => {
		const tenantId = 'tenant-restore-missing';
		await seedAuth(tenantId);
		// Index references r2 key 'rk-missing' but we never put bytes there — the
		// catalog points at a blob that's gone from R2.
		const runId = await seedRun(tenantId, 'rk-missing');
		const spy = stubFetch([TOKEN_ROUTE, WRITEBACK_ROUTE]);

		const result = await restore(env, { tenantId, runId, resourceKey: RESOURCE_KEY });

		expect(result).toEqual({ itemsRestored: 0, itemsFailed: 1 });

		const put = spy.mock.calls.find(([input]) => String(input).includes('/drives/d1/root:'));
		expect(put).toBeUndefined();
	});

	it('empty restore point: a run/resource with no current items restores nothing', async () => {
		const tenantId = 'tenant-restore-empty';
		await seedAuth(tenantId);
		// Open a run but index no items, so pointInTime returns zero rows.
		const runId = await stub(tenantId).openRun('full', 1, 90);
		const spy = stubFetch([TOKEN_ROUTE, WRITEBACK_ROUTE]);

		const result = await restore(env, { tenantId, runId, resourceKey: RESOURCE_KEY });

		expect(result).toEqual({ itemsRestored: 0, itemsFailed: 0 });

		const put = spy.mock.calls.find(([input]) => String(input).includes('/drives/d1/root:'));
		expect(put).toBeUndefined();
	});
});
