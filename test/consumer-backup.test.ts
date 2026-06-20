import { adminSecretsStore, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBackupBatch } from '../src/consumer';
import type { BackupJob } from '../src/types';

// A one-message batch with spy-able ack/retry, shaped like a real MessageBatch.
function oneMessageBatch(body: BackupJob) {
	const ack = vi.fn();
	const retry = vi.fn();
	const batch = {
		queue: 'backup-queue',
		messages: [{ id: '1', timestamp: new Date(0), body, attempts: 1, ack, retry }],
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<BackupJob>;
	return { batch, ack, retry };
}

// Route a stubbed global fetch by URL substring (first match wins). The download
// route returns RAW BYTES; token/delta routes return JSON. Records every call.
type Route = { when: string; body: unknown; status?: number; raw?: boolean };
function stubFetch(routes: Route[]) {
	const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		const route = routes.find((r) => url.includes(r.when));
		if (!route) throw new Error(`unexpected fetch: ${url}`);
		if (route.raw) {
			return new Response(route.body as string, { status: route.status ?? 200 });
		}
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

const TOKEN_ROUTE: Route = { when: '/oauth2/v2.0/token', body: { access_token: 'tok', expires_in: 3600 } };

// A single drive file on the cold-start delta page. mapDriveItem stamps
// metadata.ownerId = parentReference.driveId, so the content URL is
// GRAPH/drives/d1/items/i1/content.
const DRIVE_ITEM = { id: 'i1', name: 'a.txt', size: 10, file: { mimeType: 'text/plain' }, eTag: 'e1', parentReference: { driveId: 'd1' } };
const DELTA_LINK = 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=NEXT';
const NEXT_LINK = 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=MORE';
const CONTENT_ROUTE: Route = { when: '/drives/d1/items/i1/content', body: 'hello', raw: true };

async function openIncrementalRun(tenant: string) {
	const stub = env.TENANT.get(env.TENANT.idFromName(tenant));
	const runId = await stub.openRun('incremental', 1, 90);
	await stub.setOutstanding(1);
	return { stub, runId };
}

describe('consumer backup path (#5)', () => {
	beforeEach(async () => {
		// isolatedStorage resets bindings per test, so re-seed the token inputs.
		await env.CONFIG.put('graph:client_id:tenant-drive-happy', 'client-abc');
		await env.CONFIG.put('graph:client_id:tenant-drive-next', 'client-abc');
		await env.CONFIG.put('graph:client_id:tenant-drive-throttle', 'client-abc');
		await env.CONFIG.put('graph:client_id:tenant-drive-stale', 'client-abc');
		await adminSecretsStore(env.GRAPH_APP_SECRET).create('app-secret');
	});

	afterEach(() => vi.unstubAllGlobals());

	it('happy path: writes bytes, advances cursor, decrements outstanding, acks', async () => {
		const tenant = 'tenant-drive-happy';
		const { stub, runId } = await openIncrementalRun(tenant);
		const job: BackupJob = { tenantId: tenant, runId, resource: { kind: 'drive', id: 'd1' }, cursor: null };

		stubFetch([
			TOKEN_ROUTE,
			{ when: '/drives/d1/root/delta', body: { value: [DRIVE_ITEM], '@odata.deltaLink': DELTA_LINK } },
			CONTENT_ROUTE,
		]);

		const { batch, ack, retry } = oneMessageBatch(job);
		await handleBackupBatch(batch, env);

		// One item landed in the catalog for this run at this resource.
		expect((await stub.pointInTime(runId, 'drive:d1')).length).toBe(1);
		// Last page advanced the stored delta cursor to the deltaLink.
		expect(await stub.getCursor('drive:d1')).toBe(DELTA_LINK);
		// Resource fully synced -> outstanding ticked to 0.
		expect(await stub.outstanding()).toBe(0);
		expect(ack).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
	});

	it('nextLink: re-enqueues the next page, does not advance cursor or decrement', async () => {
		const tenant = 'tenant-drive-next';
		const { stub, runId } = await openIncrementalRun(tenant);
		const job: BackupJob = { tenantId: tenant, runId, resource: { kind: 'drive', id: 'd1' }, cursor: null };

		stubFetch([TOKEN_ROUTE, { when: '/drives/d1/root/delta', body: { value: [DRIVE_ITEM], '@odata.nextLink': NEXT_LINK } }, CONTENT_ROUTE]);

		const send = vi.fn();
		const testEnv = { ...env, BACKUP_QUEUE: { send, sendBatch: vi.fn() } } as unknown as Env;
		const { batch, ack, retry } = oneMessageBatch(job);
		await handleBackupBatch(batch, testEnv);

		// More pages -> re-enqueue the SAME job with the nextLink cursor.
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toEqual({ ...job, cursor: NEXT_LINK });
		// Not the last page: outstanding untouched and stored cursor unchanged.
		expect(await stub.outstanding()).toBe(1);
		expect(await stub.getCursor('drive:d1')).toBe(null);
		expect(ack).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
	});

	it('throttled: retries with a delay and does not ack', async () => {
		const tenant = 'tenant-drive-throttle';
		const { runId } = await openIncrementalRun(tenant);
		const job: BackupJob = { tenantId: tenant, runId, resource: { kind: 'drive', id: 'd1' }, cursor: null };

		stubFetch([TOKEN_ROUTE, { when: '/drives/d1/root/delta', body: { error: { code: 'TooManyRequests' } }, status: 429 }]);

		const { batch, ack, retry } = oneMessageBatch(job);
		await handleBackupBatch(batch, env);

		expect(retry).toHaveBeenCalledTimes(1);
		expect(retry.mock.calls[0][0].delaySeconds).toBeGreaterThan(0);
		expect(ack).not.toHaveBeenCalled();
	});

	it('cursor invalid: resets the stored cursor to null and retries', async () => {
		const tenant = 'tenant-drive-stale';
		const { stub, runId } = await openIncrementalRun(tenant);
		await stub.setCursor('drive:d1', 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=STALE');
		// Job carries no cursor so the consumer reads the (stale) stored cursor.
		const job: BackupJob = { tenantId: tenant, runId, resource: { kind: 'drive', id: 'd1' }, cursor: null };

		stubFetch([TOKEN_ROUTE, { when: '/drives/d1/root/delta', body: { error: { code: 'syncStateNotFound' } }, status: 410 }]);

		const { batch, ack, retry } = oneMessageBatch(job);
		await handleBackupBatch(batch, env);

		// Delta token invalid -> stored cursor dropped so the next attempt resyncs.
		expect(await stub.getCursor('drive:d1')).toBe(null);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(ack).not.toHaveBeenCalled();
	});
});
