import { authClient } from '../lib/auth-client';

export function Dashboard() {
	const { data: session, isPending } = authClient.useSession();

	if (isPending) {
		return <p role="status">Loading…</p>;
	}
	if (!session) {
		return <p role="status">You are not signed in.</p>;
	}

	return (
		<main aria-label="Dashboard">
			<header className="dashboard-header">
				<h1>m365vault</h1>
				<div className="dashboard-user">
					<span>{session.user.email}</span>
					<button type="button" onClick={() => authClient.signOut()}>
						Sign out
					</button>
				</div>
			</header>
			<section aria-label="Restore points">
				<h2>Recent restore points</h2>
				<p>No backups yet. Your tenant's nightly runs will appear here once the backup workflow has completed a run.</p>
			</section>
		</main>
	);
}
