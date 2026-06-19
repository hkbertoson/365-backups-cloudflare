import type { BackupItem, DeltaPage, ItemType, Resource } from './types';

// ============================================================
// graph — Microsoft Graph client: client-credentials auth, delta paging,
// download (small + ranged), scope discovery, write-back.
//
// All requests are app-only (client-credentials). The app registration's
// client secret comes from Secrets Store; the per-tenant client id lives in
// KV. Tokens are cached in-memory per tenant until ~60s before expiry.
//
// Errors are surfaced as typed GraphError so the consumer's throttling /
// cursor-expiry helpers (isThrottled / isCursorInvalid / retryAfterSeconds)
// can classify them without re-parsing responses.
// ============================================================

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_SKEW_MS = 60_000; // refresh 60s before real expiry

// Outlook immutable ids: message ids survive folder moves between syncs. Must
// ride EVERY mail request (initial delta, each nextLink/deltaLink follow-up,
// the $value content fetch) AND the folder enumeration, so the stored folder
// ids are immutable and match the id type the delta requests are sent under.
const IMMUTABLE_ID = 'IdType="ImmutableId"';
// odata.maxpagesize is baked into the issued delta tokens, so it's sent only on
// the cold-start delta request, never on follow-up pages.
const MAIL_PAGE_SIZE = 'odata.maxpagesize=50';

type AuthedOpts = { prefer?: string[] };

// KV key holding a tenant's Azure AD app (client) id. The app secret is the
// single shared Secrets Store binding; the client id can differ per tenant
// (multi-app deployments) so it lives in KV alongside other tenant config.
const clientIdKey = (tenantId: string) => `graph:client_id:${tenantId}`;

export class GraphError extends Error {
	constructor(
		readonly status: number,
		readonly code: string, // Graph error.code, e.g. "TooManyRequests"
		message: string,
		readonly retryAfter?: number, // seconds, from Retry-After header
	) {
		super(message);
		this.name = 'GraphError';
	}
}

type TokenResponse = { access_token: string; expires_in: number };
type CachedToken = { value: string; expiresAt: number };

// --- Graph object shapes (only the fields we read) ---
type ODataPage<T> = {
	value: T[];
	'@odata.nextLink'?: string;
	'@odata.deltaLink'?: string;
};

type Removed = { reason: 'deleted' | 'changed' };

type GraphMessage = {
	id: string;
	'@odata.etag'?: string;
	subject?: string;
	parentFolderId?: string;
	hasAttachments?: boolean;
	internetMessageId?: string;
	receivedDateTime?: string;
	'@removed'?: Removed;
};

type GraphDriveItem = {
	id: string;
	name?: string;
	eTag?: string;
	cTag?: string;
	size?: number;
	file?: { mimeType?: string };
	folder?: unknown;
	parentReference?: { path?: string; driveId?: string };
	'@microsoft.graph.downloadUrl'?: string;
	deleted?: { state?: string };
	'@removed'?: Removed;
};

type GraphUser = { id: string; userPrincipalName?: string; mail?: string };
type GraphSite = { id: string; name?: string; webUrl?: string };
type GraphMailFolder = { id: string; childFolderCount?: number; isHidden?: boolean };

// The message content fetch ($value) takes the stored immutable id, so it must
// declare ImmutableId too; drive files take no Prefer header.
const preferFor = (item: BackupItem): AuthedOpts => (item.itemType === 'message' ? { prefer: [IMMUTABLE_ID] } : {});

export function createGraphClient(env: Env): GraphClient {
	// Per-tenant token cache. In-memory only: lives for the isolate's lifetime,
	// which is fine for a single batch but not shared across invocations.
	// TODO(hardening): move to the tenant Durable Object or KV so concurrent
	// consumers don't each mint a token and so it survives isolate recycling.
	const tokens = new Map<string, CachedToken>();

	async function token(tenantId: string): Promise<string> {
		const cached = tokens.get(tenantId);
		if (cached && cached.expiresAt > Date.now()) return cached.value;

		const clientId = await env.CONFIG.get(clientIdKey(tenantId));
		if (!clientId) {
			throw new GraphError(500, 'configMissing', `no client id in KV for tenant ${tenantId}`);
		}
		const clientSecret = await env.GRAPH_APP_SECRET.get();
		if (!clientSecret) {
			throw new GraphError(500, 'configMissing', `no client secret in Secrets Store`);
		}

		const body = new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: clientId,
			client_secret: clientSecret,
			scope: 'https://graph.microsoft.com/.default',
		});
		const res = await fetch(`${LOGIN}/${tenantId}/oauth2/v2.0/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
		});
		if (!res.ok) throw await graphError(res);

		const json = (await res.json()) as TokenResponse;
		tokens.set(tenantId, {
			value: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000 - TOKEN_SKEW_MS,
		});
		return json.access_token;
	}

	async function authed(tenantId: string, url: string, init: RequestInit = {}, opts: AuthedOpts = {}): Promise<Response> {
		const accessToken = await token(tenantId);
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${accessToken}`);
		if (opts.prefer?.length) headers.set('prefer', opts.prefer.join(', '));
		const res = await fetch(url, { ...init, headers });
		if (!res.ok) throw await graphError(res);
		return res;
	}

	// Resolve the absolute Graph delta-root URL for a resource. Subsequent pages
	// follow the server-issued nextLink/deltaLink verbatim, so this only runs on
	// a cold start (cursor === null).
	async function deltaRoot(tenantId: string, resource: Resource): Promise<string> {
		switch (resource.kind) {
			case 'mailfolder':
				// Per-folder mail delta (the only delta Graph documents for mail).
				// ownerId = mailbox user id, id = folder id. The cold-start Prefer
				// headers (ImmutableId + page size) are applied in deltaPage.
				return `${GRAPH}/users/${resource.ownerId}/mailFolders/${resource.id}/messages/delta`;
			case 'drive':
				return `${GRAPH}/drives/${resource.id}/root/delta`;
			case 'site': {
				// A site has no delta root; back it up via its default document
				// library drive. Resolve it once, then page that drive.
				const res = await authed(tenantId, `${GRAPH}/sites/${resource.id}/drive?$select=id`);
				const drive = (await res.json()) as { id: string };
				return `${GRAPH}/drives/${drive.id}/root/delta`;
			}
		}
	}

	async function deltaPage(tenantId: string, resource: Resource, cursor: string | null): Promise<DeltaPage> {
		const isMail = resource.kind === 'mailfolder';
		// Cold start builds the delta root and sets the page size; follow-up pages
		// reuse the server-issued link but must STILL re-assert ImmutableId (it's
		// per-request, not baked into the token, unlike odata.maxpagesize).
		const url = cursor ?? (await deltaRoot(tenantId, resource));
		const prefer = isMail ? (cursor ? [IMMUTABLE_ID] : [IMMUTABLE_ID, MAIL_PAGE_SIZE]) : undefined;
		const res = await authed(tenantId, url, {}, { prefer });

		// The owning resource id (mailbox user id / drive id) is the delta
		// request context, not a field on each Graph object. Stamp it onto every
		// item so download()/downloadStream() can build a content URL from the
		// item alone (the frozen download signature takes no resource).
		// For a "site" resource, ownerId is the resolved drive id, recoverable
		// from the driveItem's own parentReference.driveId.
		// A message moved between folders appears as @removed in the source
		// folder's delta and an add in the destination folder's — same immutable
		// id in both, so content dedupe avoids re-download.
		if (resource.kind === 'mailfolder') {
			const page = (await res.json()) as ODataPage<GraphMessage>;
			return {
				items: page.value.map((m) => mapMessage(m, resource.ownerId)),
				nextLink: page['@odata.nextLink'],
				deltaLink: page['@odata.deltaLink'],
			};
		}
		const page = (await res.json()) as ODataPage<GraphDriveItem>;
		return {
			items: page.value.filter((i) => !i.folder).map(mapDriveItem),
			nextLink: page['@odata.nextLink'],
			deltaLink: page['@odata.deltaLink'],
		};
	}

	async function download(tenantId: string, item: BackupItem): Promise<ArrayBuffer> {
		const res = await authed(tenantId, contentUrl(tenantId, item), {}, preferFor(item));
		return res.arrayBuffer();
	}

	async function downloadStream(tenantId: string, item: BackupItem): Promise<ReadableStream<Uint8Array>> {
		// The caller (multipart uploader) reads this stream and slices it into
		// R2 parts. We hand back Graph's body stream directly; Graph + the CDN
		// download URL both honor Range, so a failed part can be re-fetched with
		// a Range header by the caller. We don't pre-range here because the
		// multipart threshold (8 MiB) is small enough to stream in one GET.
		const res = await authed(tenantId, contentUrl(tenantId, item), {}, preferFor(item));
		// biome-ignore lint: Graph always returns a body for $value/content.
		return res.body!;
	}

	// Users are Scope Containers, not Resources: each id expands into mail-folder
	// Resources (listMailFolders) and — issue #4 — a OneDrive `drive` Resource.
	async function listUsers(tenantId: string): Promise<string[]> {
		const out: string[] = [];
		let url: string | undefined = `${GRAPH}/users?$select=id&$top=999`;
		while (url) {
			const res = await authed(tenantId, url);
			const page = (await res.json()) as ODataPage<GraphUser>;
			for (const u of page.value) out.push(u.id);
			url = page['@odata.nextLink'];
		}
		return out;
	}

	// Enumerate a mailbox's full folder tree as mailfolder Resources. Recurse
	// childFolders (Graph's $expand=childFolders nests only one level); descend
	// only where childFolderCount > 0. Starts at the well-known msgfolderroot —
	// the true top of the tree and itself a delta-able folder. includeHiddenFolders
	// surfaces system folders so no folder is silently skipped. ImmutableId is
	// sent so stored folder ids match the id type the per-folder delta is
	// requested under.
	async function listMailFolders(tenantId: string, userId: string): Promise<Resource[]> {
		const out: Resource[] = [{ kind: 'mailfolder', id: 'msgfolderroot', ownerId: userId }];
		const prefer = [IMMUTABLE_ID];

		const walk = async (folderId: string): Promise<void> => {
			let url: string | undefined =
				`${GRAPH}/users/${userId}/mailFolders/${folderId}/childFolders?$select=id,childFolderCount,isHidden&$top=100&includeHiddenFolders=true`;
			while (url) {
				const res = await authed(tenantId, url, {}, { prefer });
				const page = (await res.json()) as ODataPage<GraphMailFolder>;
				for (const f of page.value) {
					out.push({ kind: 'mailfolder', id: f.id, ownerId: userId });
					if ((f.childFolderCount ?? 0) > 0) await walk(f.id);
				}
				url = page['@odata.nextLink'];
			}
		};

		await walk('msgfolderroot');
		return out;
	}

	async function listSites(tenantId: string): Promise<Resource[]> {
		const out: Resource[] = [];
		// getAllSites enumerates every site in the tenant (vs. the old
		// search=* heuristic which missed sites without an indexed title).
		let url: string | undefined = `${GRAPH}/sites/getAllSites?$select=id`;
		while (url) {
			const res = await authed(tenantId, url);
			const page = (await res.json()) as ODataPage<GraphSite>;
			for (const s of page.value) out.push({ kind: 'site', id: s.id });
			url = page['@odata.nextLink'];
		}
		return out;
	}

	async function writeBack(
		tenantId: string,
		resourceKey: string,
		item: BackupItem,
		body: ReadableStream<Uint8Array> | ArrayBuffer,
	): Promise<void> {
		const [kind, id] = resourceKey.split(':');

		if (item.itemType === 'file') {
			// Simple-upload path: PUT bytes to a path under the drive root. Works
			// up to 250 MiB; larger files need createUploadSession + ranged PUTs.
			//
			// FIDELITY GAPS (intentionally not handled in this baseline):
			//  - permissions / sharing links are NOT reapplied
			//  - version history collapses to a single new version
			//  - conflict handling defaults to Graph's @microsoft.graph
			//    .conflictBehavior; we don't detect or merge concurrent edits
			//  - the restored item gets a NEW Graph id (ids are immutable)
			const driveId = kind === 'site' ? await siteDriveId(tenantId, id) : id;
			const fileName = item.name ?? item.id;
			const pathSegments = item.parentPath ? [...item.parentPath.split('/'), fileName] : [fileName];
			const encodedPath = pathSegments.map((s) => encodeURIComponent(s)).join('/');
			await authed(tenantId, `${GRAPH}/drives/${driveId}/root:/${encodedPath}:/content`, { method: 'PUT', body });
			return;
		}

		if (item.itemType === 'message') {
			// Re-import a mail message from its raw MIME. Graph accepts a MIME
			// payload on POST /messages when Content-Type is text/plain and the
			// body is base64-encoded RFC-822.
			//
			// FIDELITY GAPS: a plain POST /messages creates the item in the
			// Drafts folder as a NEW item (new Graph id). Restoring to the
			// original folder requires POST /mailFolders/{id}/messages with the
			// mapped destination folder; read/flag state, categories, and the
			// sent/received timestamps are best-effort from the MIME headers.
			// Reconstructing the source folder tree is future work.
			// Owner is the mailbox user id stamped by mapMessage — not derivable
			// from the (folder-scoped) resourceKey.
			const ownerId = item.metadata?.ownerId as string;
			const buf = body instanceof ArrayBuffer ? body : await streamToBuffer(body);
			await authed(tenantId, `${GRAPH}/users/${ownerId}/messages`, {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: base64(buf),
			});
			return;
		}

		// events / contacts restore is out of scope for the baseline slice.
		throw new GraphError(501, 'notImplemented', `writeBack for itemType ${item.itemType} not implemented`);
	}

	async function siteDriveId(tenantId: string, siteId: string): Promise<string> {
		const res = await authed(tenantId, `${GRAPH}/sites/${siteId}/drive?$select=id`);
		return ((await res.json()) as { id: string }).id;
	}

	function contentUrl(_tenantId: string, item: BackupItem): string {
		// Owning resource id is stamped into metadata by the delta mappers.
		// Messages serialize to raw MIME via $value; drive files via /content.
		const ownerId = item.metadata?.ownerId as string | undefined;
		if (!ownerId) {
			throw new GraphError(500, 'missingOwnerId', `item ${item.id} missing ownerId in metadata`);
		}
		if (item.itemType === 'message') {
			return `${GRAPH}/users/${ownerId}/messages/${item.id}/$value`;
		}
		return `${GRAPH}/drives/${ownerId}/items/${item.id}/content`;
	}

	return {
		token,
		deltaPage,
		download,
		downloadStream,
		listUsers,
		listMailFolders,
		listSites,
		writeBack,
	};
}

// --- mappers: Graph object -> BackupItem ---

function mapMessage(m: GraphMessage, ownerId: string): BackupItem {
	return {
		id: m.id,
		version: m['@odata.etag'] ?? '',
		size: 0, // Graph doesn't return MIME size on the delta page; fixed post-download.
		itemType: 'message',
		name: m.subject,
		parentPath: m.parentFolderId,
		metadata: {
			ownerId, // mailbox user id — used to build the $value content URL
			internetMessageId: m.internetMessageId,
			receivedDateTime: m.receivedDateTime,
			hasAttachments: m.hasAttachments,
		},
		isDeleted: m['@removed'] !== undefined,
	};
}

function mapDriveItem(d: GraphDriveItem): BackupItem {
	const itemType: ItemType = 'file';
	return {
		id: d.id,
		version: d.cTag ?? d.eTag ?? '',
		size: d.size ?? 0,
		itemType,
		name: d.name,
		// NOTE: delta responses don't populate parentReference.path (Graph says
		// "track items by id" under delta). parentPath is therefore usually
		// undefined here; restore layout falls back to name-only. Resolving the
		// full path requires a follow-up GET per item — future work.
		parentPath: d.parentReference?.path,
		metadata: {
			ownerId: d.parentReference?.driveId, // drive id — content URL owner
			mimeType: d.file?.mimeType,
			downloadUrl: d['@microsoft.graph.downloadUrl'],
		},
		// driveItem v1.0 delta signals deletion with the `deleted` facet (often
		// an empty object), not @removed. We accept either to be safe.
		isDeleted: d.deleted !== undefined || d['@removed'] !== undefined,
	};
}

// --- error construction + classification ---

async function graphError(res: Response): Promise<GraphError> {
	const retryAfterHeader = res.headers.get('retry-after');
	const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
	let code = String(res.status);
	let message = res.statusText;
	try {
		const body = (await res.json()) as {
			error?: { code?: string; message?: string };
		};
		if (body.error?.code) code = body.error.code;
		if (body.error?.message) message = body.error.message;
	} catch {
		// non-JSON error body; keep status-derived defaults
	}
	return new GraphError(res.status, code, message, retryAfter);
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
	return new Response(stream).arrayBuffer();
}

function base64(buf: ArrayBuffer): string {
	let binary = '';
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

export interface GraphClient {
	token(tenantId: string): Promise<string>;
	deltaPage(tenantId: string, resource: Resource, cursor: string | null): Promise<DeltaPage>;
	download(tenantId: string, item: BackupItem): Promise<ArrayBuffer>;
	downloadStream(tenantId: string, item: BackupItem): Promise<ReadableStream<Uint8Array>>;
	listUsers(tenantId: string): Promise<string[]>;
	listMailFolders(tenantId: string, userId: string): Promise<Resource[]>;
	listSites(tenantId: string): Promise<Resource[]>;
	writeBack(tenantId: string, resourceKey: string, item: BackupItem, body: ReadableStream<Uint8Array> | ArrayBuffer): Promise<void>;
}

// Graph 429: explicit status OR activityLimitReached/TooManyRequests codes.
export function isThrottled(e: unknown): boolean {
	if (!(e instanceof GraphError)) return false;
	return e.status === 429 || e.code === 'TooManyRequests' || e.code === 'activityLimitReached';
}

// Delta cursor invalid -> caller resets the stored cursor to null and re-runs
// a full resync. Real shapes (confirmed against Graph docs, per resource):
//   - sync reset (any): 410 Gone (+ Location header w/ empty $deltatoken)
//   - Outlook token expiry: a 40x with error code "syncStateNotFound"
//   - driveItem delta: 410 Gone with code resyncChangesApplyDifferences /
//     resyncChangesUploadDifferences (matched by the resyncChanges prefix)
export function isCursorInvalid(e: unknown): boolean {
	if (!(e instanceof GraphError)) return false;
	return e.status === 410 || e.code === 'syncStateNotFound' || e.code.startsWith('resyncChanges');
}

export function retryAfterSeconds(e: unknown): number {
	if (e instanceof GraphError && e.retryAfter !== undefined) return e.retryAfter;
	return 30;
}
