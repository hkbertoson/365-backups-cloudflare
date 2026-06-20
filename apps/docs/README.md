# @m365vault/docs

The m365vault documentation site, built with [Astro](https://astro.build) +
[Starlight](https://starlight.astro.build). Content is sourced from the repo's
`CONTEXT.md` glossary, the `docs/adr/` decision records, and the worker source.

## Layout

```text
src/
  content.config.ts        # Astro 6 content collections (docsLoader + docsSchema)
  content/docs/
    index.mdx              # splash landing page
    getting-started.md     # provisioning runbook
    concepts/              # ubiquitous language + temporal model
    architecture/          # workflow, consumer, coordinator, storage, restore
    reference/             # bindings, data model, configuration
    adr/                   # architecture decision records
astro.config.mjs           # Starlight config + sidebar + link validator
test/                      # Vitest content lint
```

## Scripts

```bash
pnpm --filter @m365vault/docs dev      # local dev server
pnpm --filter @m365vault/docs build    # production build (+ link validation)
pnpm --filter @m365vault/docs check    # astro check (types + frontmatter)
pnpm --filter @m365vault/docs test     # astro check && astro build && vitest run
```

## Test suite

The "test" script is the full content gate:

1. **`astro check`** — type-checks `.astro`/`.ts` and validates every page's
   frontmatter against `docsSchema()`.
2. **`astro build`** — renders all pages; `starlight-links-validator` fails the
   build on any broken internal link or bad anchor.
3. **`vitest run`** — a content lint that asserts every page has a non-empty
   title and description, the homepage is a splash page, and each documented
   section is present.
