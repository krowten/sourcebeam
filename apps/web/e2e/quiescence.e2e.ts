import { test, expect } from '@playwright/test';
import { FakeHost } from './helpers/host';

const BASE = 'http://localhost:4173';

// Quiescence invariant for the viewer: an open, idle page must send the server
// NOTHING. Any background traffic at rest is a feedback loop (subscribe -> file ->
// subscribe etc.) burning through Cloudflare limits.
test('idle viewer sends zero client→server frames', async ({ page }, testInfo) => {
	const project = `e2e-${testInfo.testId}`;
	let clientFrames = 0;

	await page.routeWebSocket(/\/ws\//, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			clientFrames++;
			server.send(message);
		});
		server.onMessage((message) => ws.send(message));
	});

	const host = new FakeHost();
	try {
		await host.connect(BASE, project);
		await host.snapshot({ 'src/main.py': 'print(1)', 'README.md': '# hi' });

		await page.goto(await host.mintInvite());
		await expect(page.getByTestId('status')).toHaveText('live');
		await expect(page.getByTestId('code')).toContainText('print(1)');

		// The only legitimate frame is the subscribe sent when the file is opened.
		const afterOpen = clientFrames;
		expect(afterOpen).toBeGreaterThan(0);

		// Does a live update provoke response traffic? It shouldn't: file is a one-way push.
		host.put('src/main.py', 'print(2)');
		await expect(page.getByTestId('code')).toContainText('print(2)');

		// Two seconds of quiet — not a single new frame from the client.
		await page.waitForTimeout(2000);
		expect(clientFrames).toBe(afterOpen);
	} finally {
		host.close();
	}
});
