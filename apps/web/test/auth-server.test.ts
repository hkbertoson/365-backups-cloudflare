// @vitest-environment node
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';

const makeAuth = () =>
	betterAuth({
		database: new Database(':memory:'),
		emailAndPassword: { enabled: true },
		secret: 'test-secret-test-secret-test-secret-32',
		baseURL: 'http://localhost:3000',
	});

describe('better-auth email/password server flow', () => {
	const auth = makeAuth();

	beforeAll(async () => {
		const { runMigrations } = await getMigrations(auth.options);
		await runMigrations();
	});

	it('signs a user up and returns their account', async () => {
		const result = await auth.api.signUpEmail({
			body: { name: 'U', email: 'u@example.com', password: 'password123' },
		});

		expect(result.user.email).toBe('u@example.com');
		expect(result.user.name).toBe('U');
		expect(typeof result.token).toBe('string');
	});

	it('signs the user in with the correct password', async () => {
		const result = await auth.api.signInEmail({
			body: { email: 'u@example.com', password: 'password123' },
		});

		expect(result.user.email).toBe('u@example.com');
		expect(result.token).toBeTruthy();
	});

	it('rejects a sign-in with the wrong password', async () => {
		await expect(
			auth.api.signInEmail({
				body: { email: 'u@example.com', password: 'wrong-password' },
			}),
		).rejects.toThrow();
	});

	it('rejects a sign-in for an unknown email', async () => {
		await expect(
			auth.api.signInEmail({
				body: { email: 'nobody@example.com', password: 'password123' },
			}),
		).rejects.toThrow();
	});
});
