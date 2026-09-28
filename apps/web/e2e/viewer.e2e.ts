import { test, expect } from '@playwright/test';
import { FakeHost, inviteDeepLink } from './helpers/host';

const BASE = 'http://localhost:4173';

function projectId(testId: string): string {
	return `e2e-${testId}`;
}

test('snapshot renders a tree and highlighted file content', async ({ page }, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)', 'README.md': '# hi' });

		await expect(page.getByTestId('tree-item')).toHaveCount(2);

		await page.locator('[data-testid="tree-item"][data-path="src/main.py"]').click();
		const code = page.getByTestId('code');
		await expect(code).toContainText('print(1)');
		await expect(code.locator('span')).not.toHaveCount(0);
	} finally {
		host.close();
	}
});

test('live edit updates the open file without reload', async ({ page }, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });

		const code = page.getByTestId('code');
		await expect(code).toContainText('print(1)');

		await host.put('src/main.py', 'print(2)');

		await expect.poll(async () => code.textContent()).toContain('print(2)');
	} finally {
		host.close();
	}
});

test('a new file appears in the tree; deleting the open file shows the deleted stub', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });
		await expect(page.getByTestId('tree-item')).toHaveCount(1);

		await host.put('src/utils.py', 'x = 1');
		await expect(page.locator('[data-testid="tree-item"][data-path="src/utils.py"]')).toBeVisible();

		await host.del('src/main.py');
		await expect(page.getByTestId('file-deleted')).toBeVisible();
	} finally {
		host.close();
	}
});

test('a snapshot restart that drops the open file shows the deleted stub', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)', 'src/utils.py': 'x = 1' });
		await expect(page.getByTestId('tree-item')).toHaveCount(2);

		await page.locator('[data-testid="tree-item"][data-path="src/main.py"]').click();
		await expect(page.getByTestId('code')).toContainText('print(1)');

		// Watcher restart: a brand new full snapshot that no longer includes the open file.
		await host.snapshot({ 'src/utils.py': 'x = 1' });

		await expect(page.getByTestId('file-deleted')).toBeVisible();
		await expect(page.getByTestId('tree-item')).toHaveCount(1);
	} finally {
		host.close();
	}
});

test('copy button copies the file content to the clipboard', async ({
	page,
	context
}, testInfo) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': "print('hi')" });
		await expect(page.getByTestId('code')).toContainText("print('hi')");

		await page.getByTestId('copy').click();
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toBe("print('hi')");
	} finally {
		host.close();
	}
});

test('deep link opens the linked file directly', async ({ page }, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await host.snapshot({ 'src/main.py': 'print(1)', 'README.md': '# hi' });
		await page.goto(inviteDeepLink(await host.mintInvite(), 'src/main.py'));

		await expect(page.getByTestId('code')).toContainText('print(1)');
	} finally {
		host.close();
	}
});

test("a stale deep link falls back to the tree's first file", async ({ page }, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(inviteDeepLink(await host.mintInvite(), 'no/such/file.py'));
		await host.snapshot({ 'src/main.py': 'print(1)', 'README.md': '# hi' });

		// buildTree sorts folders first, alphabetically: "src" beats "README.md".
		await expect(page.getByTestId('code')).toContainText('print(1)');
	} finally {
		host.close();
	}
});

test('two independent viewers both receive live updates', async ({ browser }, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	const pageA = await browser.newPage();
	const pageB = await browser.newPage();
	try {
		await host.connect(BASE, project);
		const invite = await host.mintInvite();
		await pageA.goto(invite);
		await pageB.goto(invite);
		await host.snapshot({ 'src/main.py': 'print(1)' });

		await expect(pageA.getByTestId('code')).toContainText('print(1)');
		await expect(pageB.getByTestId('code')).toContainText('print(1)');

		await host.put('src/main.py', 'print(2)');

		await expect.poll(async () => pageA.getByTestId('code').textContent()).toContain('print(2)');
		await expect.poll(async () => pageB.getByTestId('code').textContent()).toContain('print(2)');
	} finally {
		host.close();
		await pageA.close();
		await pageB.close();
	}
});

test("tree collapse: only the deep-linked file's ancestors are open; a click expands, switching folders collapses the old one", async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await host.snapshot({ 'a/main.py': 'print(1)', 'b/other.py': 'x = 1', 'README.md': '# hi' });
		await page.goto(inviteDeepLink(await host.mintInvite(), 'a/main.py'));

		const itemA = page.locator('[data-testid="tree-item"][data-path="a/main.py"]');
		const itemB = page.locator('[data-testid="tree-item"][data-path="b/other.py"]');

		// "a" is an ancestor of the open file: expanded automatically. "b" is not: collapsed.
		await expect(itemA).toBeVisible();
		await expect(itemB).not.toBeVisible();

		// A click on the collapsed "b" folder expands it.
		await page.getByText('b', { exact: true }).click();
		await expect(itemB).toBeVisible();

		// Opening README.md (outside both folders) collapses "a" (only ancestor-open, not
		// manually opened); "b" stays open because the earlier click was a manual toggle.
		await page.locator('[data-testid="tree-item"][data-path="README.md"]').click();
		await expect(itemA).not.toBeVisible();
		await expect(itemB).toBeVisible();
	} finally {
		host.close();
	}
});
