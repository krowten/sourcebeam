import { test, expect } from '@playwright/test';
import { FakeHost } from './helpers/host';

const BASE = 'http://localhost:4173';

function projectId(testId: string): string {
	return `e2e-${testId}`;
}

async function themeCookie(context: import('@playwright/test').BrowserContext) {
	const cookies = await context.cookies();
	return cookies.find((c) => c.name === 'theme');
}

test('theme toggle flips the html class and persists a cookie', async ({
	page,
	context
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });

		const html = page.locator('html');
		const startedDark = await html.evaluate((el) => el.classList.contains('dark'));

		await page.getByTestId('theme-toggle').click();

		const nowDark = await html.evaluate((el) => el.classList.contains('dark'));
		expect(nowDark).toBe(!startedDark);

		const cookie = await themeCookie(context);
		expect(cookie?.value).toBe(nowDark ? 'dark' : 'light');
	} finally {
		host.close();
	}
});

test('reload keeps the chosen theme, applied server-side before hydration', async ({
	page,
	context
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });

		await page.getByTestId('theme-toggle').click();
		const cookie = await themeCookie(context);
		expect(cookie).toBeDefined();

		// Fetch the page directly with the cookie attached, bypassing the client-side
		// pre-paint script, to prove the server itself renders the class via hooks.server.ts.
		const res = await page.request.get(`/${project}`, {
			headers: { cookie: `theme=${cookie!.value}` }
		});
		const body = await res.text();
		if (cookie!.value === 'dark') {
			expect(body).toContain('<html lang="en" class="dark"');
		} else {
			expect(body).not.toContain('<html lang="en" class="dark"');
		}

		await page.reload();
		const stillDark = await page.locator('html').evaluate((el) => el.classList.contains('dark'));
		expect(stillDark).toBe(cookie!.value === 'dark');
	} finally {
		host.close();
	}
});

test('no cookie: starts dark when the OS prefers dark', async ({ browser }, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	const context = await browser.newContext({ colorScheme: 'dark' });
	const page = await context.newPage();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });

		await expect
			.poll(() => page.locator('html').evaluate((el) => el.classList.contains('dark')))
			.toBe(true);
	} finally {
		host.close();
		await context.close();
	}
});

test('no cookie: starts light when the OS prefers light', async ({ browser }, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	const context = await browser.newContext({ colorScheme: 'light' });
	const page = await context.newPage();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });

		await expect
			.poll(() => page.locator('html').evaluate((el) => el.classList.contains('dark')))
			.toBe(false);
	} finally {
		host.close();
		await context.close();
	}
});

test('copy button shows a checkmark for ~2s then reverts', async ({ page, context }, testInfo) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': "print('hi')" });
		await expect(page.getByTestId('code')).toContainText("print('hi')");

		const copyButton = page.getByTestId('copy');
		await expect(copyButton).toContainText('copy');

		await copyButton.click();
		await expect(copyButton).toContainText('copied');

		await expect.poll(async () => copyButton.textContent(), { timeout: 3000 }).toContain('copy');
	} finally {
		host.close();
	}
});
