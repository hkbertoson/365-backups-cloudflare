import { describe, expect, it } from 'vitest';
import { authClient, signIn, signOut, signUp, useSession } from '../src/lib/auth-client';

describe('auth-client wiring', () => {
	it('exposes authClient with the expected method shape', () => {
		expect(authClient).toBeDefined();
		expect(typeof authClient.signIn.email).toBe('function');
		expect(typeof authClient.signUp.email).toBe('function');
		expect(typeof authClient.signOut).toBe('function');
		expect(typeof authClient.useSession).toBe('function');
	});

	it('re-exports the named helpers from the client', () => {
		expect(signIn).toBeDefined();
		expect(signUp).toBeDefined();
		expect(signOut).toBeDefined();
		expect(useSession).toBeDefined();
		expect(typeof signIn.email).toBe('function');
		expect(typeof signUp.email).toBe('function');
		expect(typeof signOut).toBe('function');
		expect(typeof useSession).toBe('function');
	});
});
