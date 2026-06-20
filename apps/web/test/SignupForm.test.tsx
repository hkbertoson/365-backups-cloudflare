import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { signUpEmail } = vi.hoisted(() => ({ signUpEmail: vi.fn() }));

vi.mock('../src/lib/auth-client', () => ({
	authClient: {
		signIn: { email: vi.fn() },
		signUp: { email: signUpEmail },
		signOut: vi.fn(),
		useSession: vi.fn(),
	},
}));

import { SignupForm } from '../src/components/SignupForm';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('SignupForm', () => {
	it('renders Name, Email, Password fields and a Create account button', () => {
		render(<SignupForm />);
		expect(screen.getByLabelText('Name')).toBeInTheDocument();
		expect(screen.getByLabelText('Email')).toBeInTheDocument();
		expect(screen.getByLabelText('Password')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
	});

	it('submits typed values and calls onSuccess on success', async () => {
		signUpEmail.mockResolvedValue({ data: {}, error: null });
		const onSuccess = vi.fn();
		const user = userEvent.setup();
		render(<SignupForm onSuccess={onSuccess} />);

		await user.type(screen.getByLabelText('Name'), 'Ada Lovelace');
		await user.type(screen.getByLabelText('Email'), 'ada@example.com');
		await user.type(screen.getByLabelText('Password'), 'supersecret');
		await user.click(screen.getByRole('button', { name: 'Create account' }));

		await waitFor(() => {
			expect(signUpEmail).toHaveBeenCalledWith({
				name: 'Ada Lovelace',
				email: 'ada@example.com',
				password: 'supersecret',
			});
		});
		await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
	});

	it('shows an alert and does not call onSuccess on error', async () => {
		signUpEmail.mockResolvedValue({ data: null, error: { message: 'Email already exists' } });
		const onSuccess = vi.fn();
		const user = userEvent.setup();
		render(<SignupForm onSuccess={onSuccess} />);

		await user.type(screen.getByLabelText('Name'), 'Ada Lovelace');
		await user.type(screen.getByLabelText('Email'), 'ada@example.com');
		await user.type(screen.getByLabelText('Password'), 'supersecret');
		await user.click(screen.getByRole('button', { name: 'Create account' }));

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('Email already exists');
		expect(onSuccess).not.toHaveBeenCalled();
	});
});
