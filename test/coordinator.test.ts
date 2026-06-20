import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// TenantCoordinator state machinery: lease, delta cursors, token bucket, and the
// outstanding-resource counter. The catalog SQL is exercised in catalog.test.ts;
// here we drive the in-storage coordination state over the DO RPC stub.
// isolatedStorage resets DO storage per test, so tenant names can be reused.

const stub = (tenantId: string) => env.TENANT.get(env.TENANT.idFromName(tenantId));

// Drain the per-tenant token bucket until takeToken() actually denies (returns a
// wait > 0). A fixed call count is timing-sensitive: the bucket refills, so a
// slow run can leave a token available and miss the denial path under test.
async function drainUntilDenied(s: { takeToken: () => Promise<number> }): Promise<number> {
	for (let i = 0; i < 200; i++) {
		const waitMs = await s.takeToken();
		if (waitMs > 0) return waitMs;
	}
	throw new Error('Failed to reach token denial within 200 token requests');
}

describe('TenantCoordinator state', () => {
	it('serializes runs through the lease', async () => {
		const c = stub('tenant-lease');

		// First acquire wins; a second while held is denied.
		expect(await c.acquireLease()).toEqual({ acquired: true });
		expect(await c.acquireLease()).toEqual({ acquired: false });

		// After release the lease is free again. The 6h LEASE_TTL expiry can't be
		// exercised here (no clock control), only the explicit release path.
		await c.releaseLease();
		expect(await c.acquireLease()).toEqual({ acquired: true });
	});

	it('tracks independent delta cursors that clear on null', async () => {
		const c = stub('tenant-cursor');

		expect(await c.getCursor('k')).toBeNull();

		await c.setCursor('k', 'deltaLink');
		expect(await c.getCursor('k')).toBe('deltaLink');

		// A different key is independent of 'k'.
		await c.setCursor('other', 'other-link');
		expect(await c.getCursor('other')).toBe('other-link');
		expect(await c.getCursor('k')).toBe('deltaLink');

		// setCursor(key, null) forces a full resync: the cursor is gone.
		await c.setCursor('k', null);
		expect(await c.getCursor('k')).toBeNull();
		expect(await c.getCursor('other')).toBe('other-link');
	});

	it('grants the first token then denies with a positive integer wait once drained', async () => {
		const c = stub('tenant-bucket');

		// A fresh bucket starts full, so the first request goes now (0 = go).
		expect(await c.takeToken()).toBe(0);

		// Drain until denied; the denial returns ms to wait — a positive integer.
		const waitMs = await drainUntilDenied(c);
		expect(waitMs).toBeGreaterThanOrEqual(1);
		expect(Number.isInteger(waitMs)).toBe(true);
	});

	it('tracks the outstanding-resource counter with a floor at zero', async () => {
		const c = stub('tenant-outstanding');

		expect(await c.outstanding()).toBe(0);

		await c.setOutstanding(5);
		expect(await c.outstanding()).toBe(5);

		// decrOutstanding returns the new value and the getter agrees.
		expect(await c.decrOutstanding()).toBe(4);
		expect(await c.outstanding()).toBe(4);

		// Decrementing past zero floors at 0, never goes negative.
		await c.setOutstanding(0);
		expect(await c.decrOutstanding()).toBe(0);
		expect(await c.outstanding()).toBe(0);
	});
});
