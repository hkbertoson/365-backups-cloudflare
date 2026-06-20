import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { defineCollection } from 'astro:content';

// Astro 6 content collections: the docs collection loads every .md/.mdx under
// src/content/docs via Starlight's loader and validates frontmatter against
// docsSchema(). (Config lives at src/content.config.ts in Astro 6, not the
// legacy src/content/config.ts.)
export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
