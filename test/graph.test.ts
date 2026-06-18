import { adminSecretsStore, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphClient } from '../src/graph';
import { type Resource, resourceKey } from '../src/types';

const TENANT = 'test-tenant';

// resourceKey is the contract that makes per-folder Resources work: a mailfolder
// key must be unique tenant-wide (folder ids are mailbox-scoped) yet still split
// cleanly on ':' so writeBack and the cursor/blob keys are unaffected.
describe('resourceKey', () => {
	it('namespaces a mailfolder key by owner and stays single-split-safe', () => {
		const r: Resource = { kind: 'mailfolder', id: 'AAA', ownerId: 'user-1' };
		expect(resourceKey(r)).toBe('mailfolder:user-1:AAA');
		const [kind, id] = resourceKey(r).split(':');
		expect(kind).toBe('mailfolder');
		// The second segment is the OWNER (used by writeBack's message POST), not
		// the folder id — recover the folder id from r.id, never from split(':').
		expect(id).toBe('user-1');
	});

	it('leaves drive/site keys as <kind>:<id>', () => {
		expect(resourceKey({ kind: 'drive', id: 'd1' })).toBe('drive:d1');
		expect(resourceKey({ kind: 'site', id: 's1' })).toBe('site:s1');
	});
});

// Route a stubbed global fetch by URL substring (first match wins). Records every
// call so tests can assert request headers.
type Route = { when: string; body: unknown; status?: number };
function stubFetch(routes: Route[]) {
	const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		const route = routes.find((r) => url.includes(r.when));
		if (!route) throw new Error(`unexpected fetch: ${url}`);
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

const TOKEN_ROUTE: Route = { when: '/oauth2/v2.0/token', body: { access_token: 'tok', expires_in: 3600 } };

describe('graph client (stubbed fetch)', () => {
	beforeEach(async () => {
		// isolatedStorage resets bindings per test, so re-seed the token inputs.
		await env.CONFIG.put(`graph:client_id:${TENANT}`, 'client-abc');
		await adminSecretsStore(env.GRAPH_APP_SECRET).create('app-secret');
	});

	afterEach(() => vi.unstubAllGlobals());

	it('enumerates the full folder tree: recursion + pagination + msgfolderroot', async () => {
		stubFetch([
			TOKEN_ROUTE,
			// page 2 of the root listing (must precede the root match — it shares the path)
			{ when: '$skiptoken=PAGE2', body: { value: [{ id: 'f3', childFolderCount: 0 }] } },
			// f1's children (recursion)
			{ when: '/mailFolders/f1/childFolders', body: { value: [{ id: 'f1a', childFolderCount: 0 }] } },
			// root children, page 1: f1 (has a child) + f2 (leaf), then a next page
			{
				when: '/mailFolders/msgfolderroot/childFolders',
				body: {
					value: [
						{ id: 'f1', childFolderCount: 1 },
						{ id: 'f2', childFolderCount: 0 },
					],
					'@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/user-1/mailFolders/msgfolderroot/childFolders?$skiptoken=PAGE2',
				},
			},
		]);

		const folders = await createGraphClient(env).listMailFolders(TENANT, 'user-1');

		expect(folders.map((f) => f.id).sort()).toEqual(['f1', 'f1a', 'f2', 'f3', 'msgfolderroot']);
		expect(folders.every((f) => f.kind === 'mailfolder' && f.ownerId === 'user-1')).toBe(true);
	});

	it('maps a mail delta page stamping the USER id as ownerId, with immutable-id headers', async () => {
		const spy = stubFetch([
			TOKEN_ROUTE,
			{
				when: '/messages/delta',
				body: { value: [{ id: 'm1', '@odata.etag': 'W/"e1"' }], '@odata.deltaLink': 'https://graph.microsoft.com/delta-next' },
			},
		]);

		const resource: Resource = { kind: 'mailfolder', id: 'FOLDER', ownerId: 'user-1' };
		const page = await createGraphClient(env).deltaPage(TENANT, resource, null);

		expect(page.items).toHaveLength(1);
		expect(page.items[0].id).toBe('m1');
		expect(page.items[0].metadata?.ownerId).toBe('user-1'); // the bug #3 fixes
		expect(page.deltaLink).toBe('https://graph.microsoft.com/delta-next');

		// Cold-start delta carries ImmutableId + page size on the Prefer header.
		const deltaCall = spy.mock.calls.find(([input]) => String(input).includes('/messages/delta'));
		const headers = deltaCall?.[1]?.headers as Headers | undefined;
		const prefer = headers?.get('prefer') ?? '';
		expect(prefer).toContain('IdType="ImmutableId"');
		expect(prefer).toContain('odata.maxpagesize=50');
		expect(String(deltaCall?.[0])).toBe('https://graph.microsoft.com/v1.0/users/user-1/mailFolders/FOLDER/messages/delta');
	});

	it('re-asserts ImmutableId on follow-up pages but drops the page-size pref', async () => {
		const cursor = 'https://graph.microsoft.com/v1.0/users/user-1/mailFolders/FOLDER/messages/delta?$deltatoken=ABC';
		const spy = stubFetch([
			TOKEN_ROUTE,
			{ when: '/messages/delta', body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta-2' } },
		]);

		const resource: Resource = { kind: 'mailfolder', id: 'FOLDER', ownerId: 'user-1' };
		await createGraphClient(env).deltaPage(TENANT, resource, cursor);

		// A follow-up reuses the cursor URL verbatim and re-sends ImmutableId (it's
		// per-request) but NOT odata.maxpagesize (that's baked into the delta token).
		const followUp = spy.mock.calls.find(([input]) => String(input).includes('$deltatoken=ABC'));
		const prefer = (followUp?.[1]?.headers as Headers | undefined)?.get('prefer') ?? '';
		expect(prefer).toContain('IdType="ImmutableId"');
		expect(prefer).not.toContain('odata.maxpagesize');
		expect(String(followUp?.[0])).toBe(cursor);
	});
});
