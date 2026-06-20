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
		// better-auth resolves to { data, error } — it does not throw on auth
		// failures, so branch on `error` rather than try/catch.
		const { error: signInError } = await authClient.signIn.email({ email, password });
		setPending(false);
		if (signInError) {
			setError(signInError.message ?? 'Sign in failed');
			return;
		}
		onSuccess?.();
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
