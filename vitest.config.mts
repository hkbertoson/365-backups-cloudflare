import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs tests inside the Workers runtime (workerd) with the project's bindings
// simulated locally by Miniflare, so Durable Objects + their SQLite behave as
// in production. Bindings are read from wrangler.jsonc; placeholder remote ids
// (database_id, store_id, ...) are irrelevant since storage is local.
// (.mts so Vite loads this ESM-only plugin as a native module, not via require.)
export default defineConfig({
	// Scope to the worker's own suite. Workspace packages (apps/*) run their own
	// Vitest with their own environment (e.g. apps/web uses jsdom), so the root
	// Workers pool must not glob their *.test.tsx files into workerd.
	test: {
		include: ['test/**/*.test.ts'],
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
});
