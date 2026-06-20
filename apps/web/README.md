# @m365vault/web

The m365vault dashboard — a React + Vite single-page app with email/password
authentication powered by [better-auth](https://www.better-auth.com).

## Stack

- **React 19** + **Vite 6** (TypeScript)
- **better-auth** — `better-auth/react` client in the browser, the
  `betterAuth()` server mounted on the Vite dev server at `/api/auth`
- **react-router-dom 7** — `/login`, `/signup`, and a session-gated `/`
- **Vitest** + **Testing Library** (jsdom) for the test suite

## Layout

```
src/
  lib/
    auth.ts          # better-auth server (SQLite via better-sqlite3) — dev/server only
    auth-client.ts   # better-auth React client used by the browser
  components/
    LoginForm.tsx
    SignupForm.tsx
    Dashboard.tsx
  App.tsx            # AppRoutes (routes only) + App (BrowserRouter wrapper)
  main.tsx           # entry
test/                # Vitest + Testing Library specs
```

The server (`src/lib/auth.ts`) is imported **only** by the dev middleware in
`vite.config.ts` (`configureServer`), loaded lazily so neither `vite build` nor
`tsc` pull in the native `better-sqlite3` binary — the production bundle and the
CI test gate stay free of it.

## Scripts

```bash
pnpm --filter @m365vault/web dev        # Vite dev server + /api/auth handler
pnpm --filter @m365vault/web build      # tsc --noEmit && vite build
pnpm --filter @m365vault/web typecheck  # tsc --noEmit
pnpm --filter @m365vault/web test       # vitest run
```

## Environment

| Variable             | Where  | Purpose                                                            |
| -------------------- | ------ | ------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET` | server | Signing secret (required in production; `openssl rand -base64 32`) |
| `BETTER_AUTH_URL`    | server | The auth server's own base URL                                     |
| `DATABASE_PATH`      | server | SQLite file path for the auth tables (defaults to `auth.db`)       |
| `VITE_AUTH_URL`      | client | Auth API origin; omit when same-origin as the SPA                  |

See `.env.example`.

## Testing approach

Component tests mock the `auth-client` module (better-auth's recommended
pattern), so they run in pure jsdom with no server or native binary. A separate
server integration test drives a real in-memory better-auth instance.
