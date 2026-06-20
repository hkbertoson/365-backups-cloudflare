import { adminSecretsStore, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphClient, GraphError, isCursorInvalid, isThrottled, retryAfterSeconds } from '../src/graph';
import type { BackupItem, Resource } from '../src/types';

const TENANT = 'test-tenant';

// Route a stubbed global fetch by URL substring (first match wins). Records every
// call so tests can assert request headers/methods/bodies. Tolerates non-JSON
// bodies (strings/ArrayBuffers) so download/writeBack content routes work.
type Route = { when: string; body: unknown; status?: number };
function stubFetch(routes: Route[]) {
	const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		const route = routes.find((r) => url.includes(r.when));
		if (!route) throw new Error(`unexpected fetch: ${url}`);
		const { body, status } = route;
		if (typeof body === 'string' || body instanceof ArrayBuffer) {
			return new Response(body, { status: status ?? 200 });
		}
		return new Response(JSON.stringify(body), {
			status: status ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

const TOKEN_ROUTE: Route = { when: '/oauth2/v2.0/token', body: { access_token: 'tok', expires_in: 3600 } };

function callFor(spy: ReturnType<typeof stubFetch>, substr: string) {
	return spy.mock.calls.find(([input]) => String(input).includes(substr));
}

describe('graph client — drive/site/download/writeBack/auth (stubbed fetch)', () => {
	beforeEach(async () => {
		await env.CONFIG.put(`graph:client_id:${TENANT}`, 'client-abc');
		await adminSecretsStore(env.GRAPH_APP_SECRET).create('app-secret');
	});

	afterEach(() => vi.unstubAllGlobals());

	it('maps a drive delta page: folders filtered, cTag wins, driveId stamped as ownerId', async () => {
		stubFetch([
			TOKEN_ROUTE,
			{
				when: '/drives/d1/root/delta',
				body: {
					value: [
						{
							id: 'fileA',
							name: 'a.txt',
							size: 10,
							eTag: 'e1',
							cTag: 'c1',
							file: { mimeType: 'text/plain' },
							parentReference: { driveId: 'd1' },
						},
						{ id: 'folderB', name: 'sub', folder: {} },
					],
					'@odata.deltaLink': 'https://x/delta-2',
				},
			},
		]);

		const resource: Resource = { kind: 'drive', id: 'd1' };
		const page = await createGraphClient(env).deltaPage(TENANT, resource, null);

		expect(page.items).toHaveLength(1);
		expect(page.items[0].id).toBe('fileA');
		expect(page.items[0].version).toBe('c1');
		expect(page.items[0].metadata?.ownerId).toBe('d1');
		expect(page.deltaLink).toBe('https://x/delta-2');
	});

	it('download(message) hits /$value with ImmutableId Prefer and decodes the bytes', async () => {
		const spy = stubFetch([TOKEN_ROUTE, { when: '/users/user-1/messages/m1/$value', body: 'MIME' }]);

		const item: BackupItem = { id: 'm1', version: '', size: 0, itemType: 'message', metadata: { ownerId: 'user-1' } };
		const buf = await createGraphClient(env).download(TENANT, item);

		expect(new TextDecoder().decode(buf)).toBe('MIME');
		const call = callFor(spy, '/users/user-1/messages/m1/$value');
		const prefer = (call?.[1]?.headers as Headers | undefined)?.get('prefer') ?? '';
		expect(prefer).toContain('IdType="ImmutableId"');
	});

	it('download(file) hits /drives/{id}/items/{id}/content', async () => {
		const spy = stubFetch([TOKEN_ROUTE, { when: '/drives/d1/items/fileA/content', body: 'BYTES' }]);

		const item: BackupItem = { id: 'fileA', version: '', size: 0, itemType: 'file', metadata: { ownerId: 'd1' } };
		await createGraphClient(env).download(TENANT, item);

		expect(callFor(spy, '/drives/d1/items/fileA/content')).toBeDefined();
	});

	it('download rejects with GraphError(missingOwnerId) when metadata absent', async () => {
		stubFetch([TOKEN_ROUTE]);

		const item: BackupItem = { id: 'fileA', version: '', size: 0, itemType: 'file' };
		await expect(createGraphClient(env).download(TENANT, item)).rejects.toThrow(GraphError);
		await expect(createGraphClient(env).download(TENANT, item)).rejects.toMatchObject({ code: 'missingOwnerId' });
	});

	it('writeBack(file) PUTs bytes to the drive-root content path', async () => {
		const spy = stubFetch([TOKEN_ROUTE, { when: '/drives/d1/root:', body: {} }]);

		const item: BackupItem = { id: 'fileA', version: '', size: 0, itemType: 'file', name: 'a.txt' };
		await createGraphClient(env).writeBack(TENANT, 'drive:d1', item, new ArrayBuffer(4));

		const call = callFor(spy, '/drives/d1/root:/');
		expect(call?.[1]?.method).toBe('PUT');
		expect(String(call?.[0])).toContain('/drives/d1/root:/');
		expect(String(call?.[0]).endsWith(':/content')).toBe(true);
	});

	it('writeBack(message) POSTs base64 MIME with text/plain to the owner mailbox', async () => {
		const spy = stubFetch([TOKEN_ROUTE, { when: '/users/user-1/messages', body: {} }]);

		const bytes = new Uint8Array([77, 73, 77, 69]); // "MIME"
		const item: BackupItem = { id: 'm1', version: '', size: 0, itemType: 'message', metadata: { ownerId: 'user-1' } };
		await createGraphClient(env).writeBack(TENANT, 'mailfolder:user-1:F', item, bytes.buffer);

		const call = callFor(spy, '/users/user-1/messages');
		expect(call?.[1]?.method).toBe('POST');
		const headers = new Headers(call?.[1]?.headers as HeadersInit);
		expect(headers.get('content-type')).toBe('text/plain');
		expect(call?.[1]?.body).toBe(btoa('MIME'));
	});

	it('writeBack(message) rejects with GraphError(missingOwnerId) when metadata absent', async () => {
		stubFetch([TOKEN_ROUTE]);

		const item: BackupItem = { id: 'm1', version: '', size: 0, itemType: 'message' };
		await expect(createGraphClient(env).writeBack(TENANT, 'mailfolder:user-1:F', item, new ArrayBuffer(2))).rejects.toMatchObject({
			code: 'missingOwnerId',
		});
	});

	it('writeBack(event) rejects with GraphError(notImplemented, 501)', async () => {
		stubFetch([TOKEN_ROUTE]);

		const item: BackupItem = { id: 'ev1', version: '', size: 0, itemType: 'event' };
		await expect(createGraphClient(env).writeBack(TENANT, 'drive:d1', item, new ArrayBuffer(2))).rejects.toMatchObject({
			code: 'notImplemented',
			status: 501,
		});
	});

	it('listUsers follows nextLink across pages', async () => {
		stubFetch([
			TOKEN_ROUTE,
			{ when: 'users-page2', body: { value: [{ id: 'u2' }] } },
			{ when: '/users?', body: { value: [{ id: 'u1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users-page2' } },
		]);

		const users = await createGraphClient(env).listUsers(TENANT);
		expect(users).toEqual(['u1', 'u2']);
	});

	it('listSites maps getAllSites results to site Resources', async () => {
		stubFetch([TOKEN_ROUTE, { when: '/sites/getAllSites', body: { value: [{ id: 's1' }, { id: 's2' }] } }]);

		const sites = await createGraphClient(env).listSites(TENANT);
		expect(sites).toEqual([
			{ kind: 'site', id: 's1' },
			{ kind: 'site', id: 's2' },
		]);
	});

	it('caches the token across calls — one /token POST for two requests', async () => {
		const spy = stubFetch([TOKEN_ROUTE, { when: '/sites/getAllSites', body: { value: [] } }]);

		const client = createGraphClient(env);
		await client.listSites(TENANT);
		await client.listSites(TENANT);

		const tokenCalls = spy.mock.calls.filter(([input]) => String(input).includes('/oauth2/v2.0/token'));
		expect(tokenCalls).toHaveLength(1);
	});

	it('surfaces a non-ok Graph response as GraphError with parsed status/code', async () => {
		stubFetch([TOKEN_ROUTE, { when: '/sites/getAllSites', body: { error: { code: 'Forbidden', message: 'no' } }, status: 403 }]);

		try {
			await createGraphClient(env).listSites(TENANT);
			throw new Error('expected listSites to reject');
		} catch (e) {
			expect(e).toBeInstanceOf(GraphError);
			expect((e as GraphError).status).toBe(403);
			expect((e as GraphError).code).toBe('Forbidden');
		}
	});
});

describe('graph error classification helpers (pure)', () => {
	it('isThrottled matches 429 / TooManyRequests / activityLimitReached only', () => {
		expect(isThrottled(new GraphError(429, 'x', 'y'))).toBe(true);
		expect(isThrottled(new GraphError(500, 'TooManyRequests', 'y'))).toBe(true);
		expect(isThrottled(new GraphError(500, 'activityLimitReached', 'y'))).toBe(true);
		expect(isThrottled(new Error('x'))).toBe(false);
	});

	it('isCursorInvalid matches 410 / syncStateNotFound / resyncChanges* only', () => {
		expect(isCursorInvalid(new GraphError(410, 'Gone', 'y'))).toBe(true);
		expect(isCursorInvalid(new GraphError(400, 'syncStateNotFound', 'y'))).toBe(true);
		expect(isCursorInvalid(new GraphError(400, 'resyncChangesApplyDifferences', 'y'))).toBe(true);
		expect(isCursorInvalid(new GraphError(400, 'other', 'y'))).toBe(false);
	});

	it('retryAfterSeconds uses retryAfter or defaults to 30', () => {
		expect(retryAfterSeconds(new GraphError(429, 'x', 'y', 17))).toBe(17);
		expect(retryAfterSeconds(new GraphError(429, 'x', 'y'))).toBe(30);
		expect(retryAfterSeconds(new Error('x'))).toBe(30);
	});
});
