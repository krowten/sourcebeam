import { test, expect } from '@playwright/test';
import { FakeHost } from './helpers/host';

const BASE = 'http://localhost:4173';

function projectId(testId: string): string {
	return `e2e-${testId}`;
}

test('invite link exchanges for a cookie: clean URL, tree visible, file opens', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		const invite = await host.mintInvite();

		await page.goto(invite);

		// The ?token=... exchange (worker/routing.ts) 302s to the clean URL.
		expect(new URL(page.url()).search).toBe('');
		expect(page.url()).toBe(`${BASE}/${project}`);

		const cookies = await page.context().cookies();
		expect(cookies.some((c) => c.name === `sb_view_${project}`)).toBe(true);

		await host.snapshot({ 'src/main.py': 'print(1)', 'README.md': '# hi' });
		await expect(page.getByTestId('tree-item')).toHaveCount(2);

		await page.locator('[data-testid="tree-item"][data-path="src/main.py"]').click();
		await expect(page.getByTestId('code')).toContainText('print(1)');
	} finally {
		host.close();
	}
});

test('no invite, no cookie: viewer sees invite-invalid, never gets code', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);

	await page.goto(`/${project}`);

	await expect(page.getByTestId('invite-invalid')).toBeVisible();
	await expect(page.getByTestId('status')).toHaveText('no access');
	await expect(page.getByTestId('code')).toHaveCount(0);
});

test('revoking invites cuts off an open tab: it says "no access", not "reconnecting"', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });
		await expect(page.getByTestId('status')).toHaveText('live');

		await host.rotateViewSecret();

		// No reload: the server closes the socket, the probe gets a 403, and the page settles.
		await expect(page.getByTestId('invite-invalid')).toBeVisible();
		await expect(page.getByTestId('status')).toHaveText('no access');
	} finally {
		host.close();
	}
});

test('rotating the view secret invalidates the old invite on reload', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });
		await expect(page.getByTestId('status')).toHaveText('live');

		await host.rotateViewSecret();

		// Same page, same (now-stale) cookie, no fresh invite: reconnect on reload must fail.
		await page.reload();

		await expect(page.getByTestId('invite-invalid')).toBeVisible();
	} finally {
		host.close();
	}
});

test('host deletes the project: viewer sees the project-deleted screen', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });
		await expect(page.getByTestId('code')).toContainText('print(1)');

		host.deleteProject();

		await expect(page.getByTestId('project-deleted')).toBeVisible();
		await expect(page.getByTestId('status')).toHaveText('deleted');
	} finally {
		host.close();
	}
});
