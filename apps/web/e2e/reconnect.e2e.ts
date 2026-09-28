import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { FakeHost } from './helpers/host';

const BASE = 'http://localhost:4173';

function projectId(testId: string): string {
	return `e2e-${testId}`;
}

// Intercepts the viewer's WebSocket at the Playwright layer instead of reaching into the app:
// closing the routed connection fires a real 'close' event on the page's WebSocket object,
// same as an actual network drop would, without needing any test-only hook in the client code.
async function interceptClientSocket(page: Page): Promise<() => Promise<void>> {
	let active: WebSocketRoute | null = null;
	await page.routeWebSocket(/\/ws\//, (ws) => {
		active = ws;
		ws.connectToServer();
	});
	return async () => {
		await active?.close();
	};
}

test('dropped socket flips status to reconnecting, then back to live', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	const dropClientSocket = await interceptClientSocket(page);
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });

		const status = page.getByTestId('status');
		await expect(status).toHaveText('live');

		await dropClientSocket();

		await expect(status).toHaveText('reconnecting…');
		await expect(status).toHaveText('live', { timeout: 10_000 });
	} finally {
		host.close();
	}
});

test('an edit made while the client is disconnected arrives after reconnect', async ({
	page
}, testInfo) => {
	const project = projectId(testInfo.testId);
	const host = new FakeHost();
	const dropClientSocket = await interceptClientSocket(page);
	try {
		await host.connect(BASE, project);
		await page.goto(await host.mintInvite());
		await host.snapshot({ 'src/main.py': 'print(1)' });

		const code = page.getByTestId('code');
		const status = page.getByTestId('status');
		await expect(code).toContainText('print(1)');

		await dropClientSocket();
		await expect(status).toHaveText('reconnecting…');

		// The host's own connection is a separate Node WebSocket, untouched by the route
		// above — it can keep editing while the viewer is down. The DO just stores the put;
		// the viewer picks up the new content once it reconnects and re-subscribes.
		await host.put('src/main.py', 'print(2)');

		await expect(status).toHaveText('live', { timeout: 10_000 });
		await expect(code).toContainText('print(2)');
	} finally {
		host.close();
	}
});
