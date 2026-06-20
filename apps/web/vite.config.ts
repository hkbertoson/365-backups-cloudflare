/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The better-auth dev server is mounted lazily in `configureServer` (dev only),
// so neither `vite build` nor `tsc` ever load the SQLite-backed auth server —
// keeping the build + test gate free of the native better-sqlite3 binary.
export default defineConfig({
	plugins: [
		react(),
		{
			name: 'better-auth-dev',
			async configureServer(server) {
				const { toNodeHandler } = await import('better-auth/node');
				const { auth } = await import('./src/lib/auth');
				server.middlewares.use('/api/auth', toNodeHandler(auth));
			},
		},
	],
	test: {
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./test/setup.ts'],
		css: false,
	},
});
