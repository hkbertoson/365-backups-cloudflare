import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useSession, signOut } = vi.hoisted(() => ({
	useSession: vi.fn(),
	signOut: vi.fn(),
}));

vi.mock('../src/lib/auth-client', () => ({
	authClient: {
		signIn: { email: vi.fn() },
		signUp: { email: vi.fn() },
		signOut,
		useSession,
	},
}));

import { Dashboard } from '../src/components/Dashboard';

describe('Dashboard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('shows a loading status while the session is pending', () => {
		useSession.mockReturnValue({ data: null, isPending: true });

		render(<Dashboard />);

		const status = screen.getByRole('status');
		expect(status).toHaveTextContent('Loading…');
	});

	it('shows a signed-out status when there is no session', () => {
		useSession.mockReturnValue({ data: null, isPending: false });

		render(<Dashboard />);

		const status = screen.getByRole('status');
		expect(status).toHaveTextContent('You are not signed in.');
	});

	it('renders the dashboard and signs out when a session exists', async () => {
		useSession.mockReturnValue({
			data: { user: { email: 'a@b.com' } },
			isPending: false,
		});

		render(<Dashboard />);

		expect(screen.getByRole('main', { name: 'Dashboard' })).toBeInTheDocument();
		expect(screen.getByText('a@b.com')).toBeInTheDocument();

		await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

		await waitFor(() => {
			expect(signOut).toHaveBeenCalledTimes(1);
		});
	});
});
