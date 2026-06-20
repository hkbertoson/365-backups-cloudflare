import { type FormEvent, useState } from 'react';
import { authClient } from '../lib/auth-client';

export interface SignupFormProps {
	onSuccess?: () => void;
}

export function SignupForm({ onSuccess }: SignupFormProps) {
	const [name, setName] = useState('');
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
			const { error: signUpError } = await authClient.signUp.email({ name, email, password });
			if (signUpError) {
				setError(signUpError.message ?? 'Sign up failed');
				return;
			}
			onSuccess?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Sign up failed');
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={handleSubmit} aria-label="Create account">
			<h1>Create account</h1>
			<label htmlFor="signup-name">Name</label>
			<input id="signup-name" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required />
			<label htmlFor="signup-email">Email</label>
			<input
				id="signup-email"
				type="email"
				autoComplete="email"
				value={email}
				onChange={(event) => setEmail(event.target.value)}
				required
			/>
			<label htmlFor="signup-password">Password</label>
			<input
				id="signup-password"
				type="password"
				autoComplete="new-password"
				minLength={8}
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
				{pending ? 'Creating account…' : 'Create account'}
			</button>
		</form>
	);
}
