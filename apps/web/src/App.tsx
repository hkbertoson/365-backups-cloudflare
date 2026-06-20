import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Dashboard } from './components/Dashboard';
import { LoginForm } from './components/LoginForm';
import { SignupForm } from './components/SignupForm';
import { authClient } from './lib/auth-client';

function RequireAuth({ children }: { children: ReactNode }) {
	const { data: session, isPending } = authClient.useSession();
	if (isPending) {
		return <p role="status">Loading…</p>;
	}
	if (!session) {
		return <Navigate to="/login" replace />;
	}
	return <>{children}</>;
}

function LoginPage() {
	const navigate = useNavigate();
	return (
		<div className="auth-page">
			<LoginForm onSuccess={() => navigate('/')} />
			<p>
				No account? <Link to="/signup">Create one</Link>
			</p>
		</div>
	);
}

function SignupPage() {
	const navigate = useNavigate();
	return (
		<div className="auth-page">
			<SignupForm onSuccess={() => navigate('/')} />
			<p>
				Already have an account? <Link to="/login">Sign in</Link>
			</p>
		</div>
	);
}

// Routes only (no router) so tests can wrap them in a MemoryRouter.
export function AppRoutes() {
	return (
		<Routes>
			<Route path="/login" element={<LoginPage />} />
			<Route path="/signup" element={<SignupPage />} />
			<Route
				path="/"
				element={
					<RequireAuth>
						<Dashboard />
					</RequireAuth>
				}
			/>
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	);
}

export function App() {
	return (
		<BrowserRouter>
			<AppRoutes />
		</BrowserRouter>
	);
}
