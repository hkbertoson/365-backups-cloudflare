import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';

// The better-auth server. Email/password only for this slice. The SQLite file
// backs the user/session/account tables (better-auth's built-in Kysely adapter
// owns the schema — run `pnpm --filter @m365vault/web exec better-auth migrate`
// or let it auto-create in dev). This module is imported ONLY by the dev
// middleware (vite.config `configureServer`), never by the browser bundle, so
// the native better-sqlite3 binary never reaches the client or the build.
const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:5173';

// Trusted origins default to the configured auth origin so they track baseURL
// rather than assuming a single hard-coded host/port. Override with a
// comma-separated BETTER_AUTH_TRUSTED_ORIGINS when the SPA is served from a
// different origin (e.g. 127.0.0.1, a Vite auto-selected port, or prod).
const trustedOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',')
	.map((origin) => origin.trim())
	.filter(Boolean) ?? [baseURL];

export const auth = betterAuth({
	database: new Database(process.env.DATABASE_PATH ?? 'auth.db'),
	emailAndPassword: {
		enabled: true,
	},
	baseURL,
	secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-change-me-in-production-0000',
	trustedOrigins,
});
