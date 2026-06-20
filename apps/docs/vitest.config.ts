import { defineConfig } from 'vitest/config';

// The docs suite layered on top of `astro check` + `astro build`: a content
// lint that reads the markdown on disk (node env, no Astro runtime) and checks
// things the build does not enforce — e.g. every page carries a description.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
	},
});
