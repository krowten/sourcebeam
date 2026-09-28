import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';

async function nextMessage(ws: WebSocket): Promise<{ type: string; url: string }> {
	return new Promise((resolve) =>
		ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true })
	);
}

async function mintToken(project: string): Promise<string> {
	const res = await SELF.fetch(`https://x/ws/${project}`, {
		headers: { Upgrade: 'websocket', Authorization: 'Bearer valid-host' }
	});
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	await nextMessage(ws); // policy — discard
	const mintReply = nextMessage(ws);
	ws.send(JSON.stringify({ type: 'mint_invite', ttlSeconds: 3600 }));
	const m = await mintReply;
	expect(m.type).toBe('invite');
	return new URL(m.url, 'https://x').searchParams.get('token')!;
}

describe('routing: token -> cookie exchange', () => {
	beforeAll(async () => {
		await env.HOST_TOKENS.put('valid-host', '{}');
	});

	test('GET /{project}?token=<valid> redirects and sets the viewer cookie', async () => {
		const token = await mintToken('wr-1');
		const res = await SELF.fetch(`https://x/wr-1?token=${encodeURIComponent(token)}`, {
			redirect: 'manual'
		});
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/wr-1');
		expect(res.headers.get('Set-Cookie')).toContain(`sb_view_wr-1=${token}`);
		expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
	});

	test('GET /{project}?token=<garbage> redirects without setting a cookie', async () => {
		const res = await SELF.fetch('https://x/wr-2?token=garbage', { redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/wr-2');
		expect(res.headers.get('Set-Cookie')).toBeNull();
	});

	test('the redirect strips only the token param, other query params survive', async () => {
		const token = await mintToken('wr-3');
		const res = await SELF.fetch(`https://x/wr-3?file=src%2Fmain.py&token=${token}`, {
			redirect: 'manual'
		});
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/wr-3?file=src%2Fmain.py');
		expect(res.headers.get('Set-Cookie')).toContain('sb_view_wr-3=');
	});

	test('a token minted for one project sets no cookie on another project page', async () => {
		const token = await mintToken('wr-4');
		const res = await SELF.fetch(`https://x/wr-5?token=${token}`, { redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/wr-5');
		expect(res.headers.get('Set-Cookie')).toBeNull();
	});

	test('Set-Cookie Max-Age tracks the remaining invite ttl', async () => {
		const token = await mintToken('wr-6'); // minted with ttl 3600
		const res = await SELF.fetch(`https://x/wr-6?token=${token}`, { redirect: 'manual' });
		const cookie = res.headers.get('Set-Cookie')!;
		const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
		expect(maxAge).toBeGreaterThan(3590);
		expect(maxAge).toBeLessThanOrEqual(3600);
	});

	test('paths that are not valid project ids skip the exchange entirely', async () => {
		// Uppercase fails the project-id regex, so ?token= falls through to the fallback (404
		// in the test entry) instead of spinning up a DO for a bogus name.
		const res = await SELF.fetch('https://x/UPPER?token=1.aa', { redirect: 'manual' });
		expect(res.status).toBe(404);
	});
});

describe('routing: non-upgrade /ws/:project auth probe', () => {
	// The viewer's reachability check (live-client.svelte.ts's probeThenDecide) HEADs this
	// same path the WS handshake uses, without an Upgrade header, to get a definitive
	// authorization answer instead of the ssr-disabled page shell's context-free 200.
	test('a plain GET with a valid viewer cookie gets 204, not a socket', async () => {
		const token = await mintToken('probe-1');
		const res = await SELF.fetch('https://x/ws/probe-1', {
			headers: { Cookie: `sb_view_probe-1=${token}` }
		});
		expect(res.status).toBe(204);
		expect(res.webSocket).toBeNull();
	});

	test('a plain GET with no cookie/token gets 403', async () => {
		const res = await SELF.fetch('https://x/ws/probe-2');
		expect(res.status).toBe(403);
	});

	test('a plain GET with a garbage cookie gets 403', async () => {
		const res = await SELF.fetch('https://x/ws/probe-3', {
			headers: { Cookie: 'sb_view_probe-3=garbage' }
		});
		expect(res.status).toBe(403);
	});

	test('a plain GET with a valid host token gets 204, not a socket, and does not evict the live host', async () => {
		const live = await SELF.fetch('https://x/ws/probe-4', {
			headers: { Upgrade: 'websocket', Authorization: 'Bearer valid-host' }
		});
		expect(live.status).toBe(101);
		const liveWs = live.webSocket!;
		liveWs.accept();
		const closed = new Promise<{ code: number }>((r) =>
			liveWs.addEventListener('close', (e) => r({ code: e.code }))
		);

		const probe = await SELF.fetch('https://x/ws/probe-4', {
			headers: { Authorization: 'Bearer valid-host' }
		});
		expect(probe.status).toBe(204);
		expect(probe.webSocket).toBeNull();

		// A real second host upgrade closes the first with 4000 (see project-room.ts) — prove
		// the probe above did *not* do that by still triggering it here, on the same socket.
		const second = await SELF.fetch('https://x/ws/probe-4', {
			headers: { Upgrade: 'websocket', Authorization: 'Bearer valid-host' }
		});
		expect(second.status).toBe(101);
		expect((await closed).code).toBe(4000);
	});
});
