import { createAuthClient } from 'better-auth/react';

// The browser-side auth client. `baseURL` is optional when the SPA is served
// from the same origin as the auth API (the Vite dev server mounts the handler
// at /api/auth); set VITE_AUTH_URL to point at a separate auth origin in prod.
// `credentials: 'include'` ensures the session cookie rides cross-origin.
export const authClient = createAuthClient({
	baseURL: import.meta.env.VITE_AUTH_URL,
	fetchOptions: {
		credentials: 'include',
	},
});

export const { signIn, signUp, signOut, useSession } = authClient;
