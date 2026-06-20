import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

import { AppRoutes } from '../src/App';

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<AppRoutes />
		</MemoryRouter>,
	);
}

describe('AppRoutes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSession.mockReturnValue({ data: null, isPending: false });
	});

	it('renders the Sign in form at /login', () => {
		renderAt('/login');
		expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
	});

	it('redirects to /login when unauthenticated at /', () => {
		useSession.mockReturnValue({ data: null, isPending: false });
		renderAt('/');
		expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
	});

	it('renders the Dashboard when authenticated at /', () => {
		useSession.mockReturnValue({
			data: { user: { email: 'a@b.com' } },
			isPending: false,
		});
		renderAt('/');
		expect(screen.getByRole('main', { name: 'Dashboard' })).toBeInTheDocument();
		expect(screen.getByText('a@b.com')).toBeInTheDocument();
	});

	it('renders the Create account form at /signup', () => {
		renderAt('/signup');
		expect(screen.getByRole('form', { name: 'Create account' })).toBeInTheDocument();
	});
});
