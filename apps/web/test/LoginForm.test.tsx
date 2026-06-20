import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { signInEmail, signUpEmail, useSession } = vi.hoisted(() => ({
	signInEmail: vi.fn(),
	signUpEmail: vi.fn(),
	useSession: vi.fn(),
}));

vi.mock('../src/lib/auth-client', () => ({
	authClient: {
		signIn: { email: signInEmail },
		signUp: { email: signUpEmail },
		signOut: vi.fn(),
		useSession,
	},
}));

import { LoginForm } from '../src/components/LoginForm';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('LoginForm', () => {
	it('renders email + password fields and a Sign in button', () => {
		render(<LoginForm />);

		expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
	});

	it('submits typed credentials and calls onSuccess', async () => {
		const user = userEvent.setup();
		signInEmail.mockResolvedValue({ data: { user: {} }, error: null });
		const onSuccess = vi.fn();

		render(<LoginForm onSuccess={onSuccess} />);

		await user.type(screen.getByLabelText(/email/i), 'user@example.com');
		await user.type(screen.getByLabelText(/password/i), 'hunter2');
		await user.click(screen.getByRole('button', { name: /sign in/i }));

		await waitFor(() => {
			expect(signInEmail).toHaveBeenCalledWith({
				email: 'user@example.com',
				password: 'hunter2',
			});
		});
		await waitFor(() => {
			expect(onSuccess).toHaveBeenCalledTimes(1);
		});
	});

	it('shows an alert and does not call onSuccess on error', async () => {
		const user = userEvent.setup();
		signInEmail.mockResolvedValue({
			data: null,
			error: { message: 'Invalid credentials' },
		});
		const onSuccess = vi.fn();

		render(<LoginForm onSuccess={onSuccess} />);

		await user.type(screen.getByLabelText(/email/i), 'user@example.com');
		await user.type(screen.getByLabelText(/password/i), 'wrong');
		await user.click(screen.getByRole('button', { name: /sign in/i }));

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('Invalid credentials');
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('disables the button and shows pending text while in-flight', async () => {
		const user = userEvent.setup();
		let resolveSignIn: (value: { data: unknown; error: null }) => void = () => {};
		signInEmail.mockReturnValue(
			new Promise((resolve) => {
				resolveSignIn = resolve;
			}),
		);

		render(<LoginForm />);

		await user.type(screen.getByLabelText(/email/i), 'user@example.com');
		await user.type(screen.getByLabelText(/password/i), 'hunter2');
		await user.click(screen.getByRole('button', { name: /sign in/i }));

		const pendingButton = await screen.findByRole('button', { name: /signing in/i });
		expect(pendingButton).toBeDisabled();

		resolveSignIn({ data: { user: {} }, error: null });

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
		});
	});
});
