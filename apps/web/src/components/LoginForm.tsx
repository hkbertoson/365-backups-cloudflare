import { type FormEvent, useState } from 'react';
import { authClient } from '../lib/auth-client';

export interface LoginFormProps {
	onSuccess?: () => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		setPending(true);
		try {
			// better-auth resolves to { data, error } for auth failures (it does not
			// throw), but the request can still reject on a network/fetch error — so
			// the finally block guarantees the pending state is always cleared.
			const { error: signInError } = await authClient.signIn.email({ email, password });
			if (signInError) {
				setError(signInError.message ?? 'Sign in failed');
				return;
			}
			onSuccess?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Sign in failed');
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={handleSubmit} aria-label="Sign in">
			<h1>Sign in</h1>
			<label htmlFor="login-email">Email</label>
			<input id="login-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
			<label htmlFor="login-password">Password</label>
			<input
				id="login-password"
				type="password"
				autoComplete="current-password"
				value={password}
				onChange={(event) => setPassword(event.target.value)}
				required
			/>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<button type="submit" disabled={pending}>
				{pending ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	);
}
