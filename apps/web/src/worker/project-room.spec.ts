import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
	SELF
} from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { inactivityTtlMs } from './project-room';

// Loose shape for anything the server sends; `url`/`expiresAt` are declared so invite
// replies can be used without casts, and everything else stays `unknown`.
type Msg = { type: string; url: string; expiresAt: number } & Record<string, unknown>;

type Inbox = {
	ws: WebSocket;
	next: () => Promise<Msg>;
	send: (m: object) => void;
	waitClose: () => Promise<{ code: number }>;
};

type ConnectOpts = { host?: string; viewToken?: string };

async function connect(project: string, opts: ConnectOpts = {}): Promise<Inbox> {
	const headers: Record<string, string> = { Upgrade: 'websocket' };
	if (opts.host) headers.Authorization = `Bearer ${opts.host}`;
	if (opts.viewToken) headers.Cookie = `sb_view_${project}=${opts.viewToken}`;
	const res = await SELF.fetch(`https://x/ws/${project}`, { headers });
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	const inbox: Msg[] = [];
	const waiters: ((m: Msg) => void)[] = [];
	ws.addEventListener('message', (e) => {
		const m = JSON.parse(e.data as string) as Msg;
		const w = waiters.shift();
		if (w) w(m);
		else inbox.push(m);
	});
	const next = () =>
		inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Msg>((r) => waiters.push(r));
	const send = (m: object) => ws.send(JSON.stringify(m));
	const waitClose = () =>
		new Promise<{ code: number }>((r) => ws.addEventListener('close', (e) => r({ code: e.code })));
	return { ws, next, send, waitClose };
}

// Same upgrade attempt, but for cases where the DO is expected to refuse it outright
// (no 101/webSocket to work with).
async function connectRejected(project: string, opts: { cookie?: string } = {}) {
	const headers: Record<string, string> = { Upgrade: 'websocket' };
	if (opts.cookie) headers.Cookie = opts.cookie;
	return SELF.fetch(`https://x/ws/${project}`, { headers });
}

// Has the (already connected) host mint an invite and returns the raw token, as it
// would appear in the `sb_view_<project>` cookie after the Worker's token->cookie exchange.
async function mintToken(host: Inbox, project: string, ttlSeconds = 3600): Promise<string> {
	host.send({ type: 'mint_invite', ttlSeconds });
	const m = await host.next();
	expect(m.type).toBe('invite');
	expect(m.url).toMatch(new RegExp(`^/${project}\\?token=`));
	return new URL(m.url, 'https://x').searchParams.get('token')!;
}

async function connectViewer(host: Inbox, project: string, ttlSeconds = 3600): Promise<Inbox> {
	const token = await mintToken(host, project, ttlSeconds);
	return connect(project, { viewToken: token });
}

const put = (path: string, content: string) => ({
	type: 'file_put',
	path,
	content,
	hash: content // test "hash": server never recomputes, just compares strings
});

// Sends a deliberately invalid host message and waits for the resulting `error`.
// Since messages on one WS connection are processed strictly in order, awaiting this
// response proves every earlier message sent on `host` has already been applied.
async function syncHost(host: Inbox) {
	host.send({ type: 'file_put', path: '../__sync__', content: 'x', hash: 'x' });
	const m = await host.next();
	expect(m.type).toBe('error');
}

describe('ProjectRoom', () => {
	beforeAll(async () => {
		await env.HOST_TOKENS.put('valid-host', '{}');
	});

	test('auth: no cookie/token is rejected, unknown host token is 403, valid KV token is host', async () => {
		const noCookie = await connectRejected('auth-1');
		expect(noCookie.status).toBe(403);

		const forbidden = await SELF.fetch('https://x/ws/auth-1', {
			headers: { Upgrade: 'websocket', Authorization: 'Bearer nonexistent' }
		});
		expect(forbidden.status).toBe(403);

		const host = await connect('auth-1', { host: 'valid-host' });
		expect((await host.next()).type).toBe('policy');
		// Prove no `tree` was queued for the host: send an invalid message and check
		// the very next thing the host receives is the resulting `error`.
		host.send({ type: 'subscribe', path: 'x' });
		expect((await host.next()).type).toBe('error');

		const viewer = await connectViewer(host, 'auth-1');
		expect((await viewer.next()).type).toBe('policy');
		expect((await viewer.next()).type).toBe('tree');
	});

	test('invite: mint issues a token that mints a valid cookie; rotate invalidates it; bad/foreign/missing cookies are rejected', async () => {
		const host = await connect('invite-1', { host: 'valid-host' });
		await host.next(); // policy

		const before = Math.floor(Date.now() / 1000);
		host.send({ type: 'mint_invite', ttlSeconds: 3600 });
		const invite = await host.next();
		expect(invite.type).toBe('invite');
		expect(invite.url).toMatch(/^\/invite-1\?token=\d+\.[0-9a-f]+$/);
		expect(invite.expiresAt).toBeGreaterThan(before);
		const token = new URL(invite.url, 'https://x').searchParams.get('token')!;

		const ok = await connect('invite-1', { viewToken: token });
		expect((await ok.next()).type).toBe('policy');
		expect((await ok.next()).type).toBe('tree');

		const noCookie = await connectRejected('invite-1');
		expect(noCookie.status).toBe(403);

		const garbage = await connectRejected('invite-1', { cookie: 'sb_view_invite-1=garbage' });
		expect(garbage.status).toBe(403);

		const foreignHost = await connect('invite-2', { host: 'valid-host' });
		await foreignHost.next(); // policy
		const foreignToken = await mintToken(foreignHost, 'invite-2');
		const foreign = await connectRejected('invite-1', {
			cookie: `sb_view_invite-1=${foreignToken}`
		});
		expect(foreign.status).toBe(403);

		host.send({ type: 'rotate_view_secret' });
		expect(await host.next()).toEqual({ type: 'ok' });

		const stale = await connectRejected('invite-1', { cookie: `sb_view_invite-1=${token}` });
		expect(stale.status).toBe(403);

		const fresh = await connectViewer(host, 'invite-1');
		expect((await fresh.next()).type).toBe('policy');
		expect((await fresh.next()).type).toBe('tree');
	});

	test('invite: mint immediately followed by rotate still applies in send order, not interleaved', async () => {
		// mint_invite and rotate_view_secret both read-modify-write the same persisted
		// viewSecret via independent (non-awaited) async handlers — worth a guard even though
		// nothing in this codebase serializes them explicitly: the Workers runtime's automatic
		// input gating defers delivering the next webSocketMessage to this DO until every
		// storage operation from the current one has settled, which is what actually keeps
		// mint and rotate from interleaving here. Confirmed by temporarily reverting to a naive
		// per-op queue and back — this test's outcome didn't depend on which one ran, because
		// the platform was already the thing enforcing the order.
		const host = await connect('serialize-1', { host: 'valid-host' });
		await host.next(); // policy

		host.send({ type: 'mint_invite', ttlSeconds: 3600 });
		host.send({ type: 'rotate_view_secret' });

		const invite = await host.next();
		expect(invite.type).toBe('invite');
		const token = new URL(invite.url, 'https://x').searchParams.get('token')!;

		expect(await host.next()).toEqual({ type: 'ok' });

		// The rotate that ran after mint invalidates the token mint just issued.
		const rejected = await connectRejected('serialize-1', {
			cookie: `sb_view_serialize-1=${token}`
		});
		expect(rejected.status).toBe(403);
	});

	test('invite: expiry is enforced for the life of the connection, not just at handshake', async () => {
		// A viewer can't mint itself an already-expired invite (verifyInvite rejects it before
		// the socket ever opens), so this simulates the only way one can exist: a socket that
		// connected with a still-valid invite, which then expires while the socket stays open.
		const host = await connect('expiry-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send(put('a.txt', 'A1'));
		await syncHost(host);
		const viewer = await connectViewer(host, 'expiry-1');
		await viewer.next(); // policy
		await viewer.next(); // tree
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		await viewer.next(); // file

		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('expiry-1'));
		await runInDurableObject(stub, (_instance, state) => {
			for (const ws of state.getWebSockets('viewer')) {
				const a = ws.deserializeAttachment() as { expiresAt: number | null };
				ws.serializeAttachment({ ...a, expiresAt: Math.floor(Date.now() / 1000) - 1 });
			}
		});

		// Delivery-time check: a broadcast to an already-expired viewer closes it instead of
		// sending, even though the viewer never sent another message itself.
		const viewerClosed = viewer.waitClose();
		host.send(put('b.txt', 'B1'));
		expect((await viewerClosed).code).toBe(4001);
	});

	test('invite: an expired viewer socket is also cut off on its own next inbound message', async () => {
		const host = await connect('expiry-2', { host: 'valid-host' });
		await host.next(); // policy
		const viewer = await connectViewer(host, 'expiry-2');
		await viewer.next(); // policy
		await viewer.next(); // tree

		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('expiry-2'));
		await runInDurableObject(stub, (_instance, state) => {
			for (const ws of state.getWebSockets('viewer')) {
				const a = ws.deserializeAttachment() as { expiresAt: number | null };
				ws.serializeAttachment({ ...a, expiresAt: Math.floor(Date.now() / 1000) - 1 });
			}
		});

		const viewerClosed = viewer.waitClose();
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		expect((await viewerClosed).code).toBe(4001);
	});

	test('invite: mint_invite after hibernation eviction still resolves the real project name', async () => {
		const host = await connect('hib-1', { host: 'valid-host' });
		await host.next(); // policy

		// Tears down the DO's in-memory state (incl. the projectId field) while
		// hibernating the still-open host socket, simulating an idle eviction.
		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('hib-1'));
		await evictDurableObject(stub);

		host.send({ type: 'mint_invite', ttlSeconds: 3600 });
		const invite = await host.next();
		expect(invite.type).toBe('invite');
		expect(invite.url).toMatch(/^\/hib-1\?token=\d+\.[0-9a-f]+$/);
	});

	test('invite: rotate_view_secret closes already-connected viewers, not just future ones', async () => {
		const host = await connect('rotate-1', { host: 'valid-host' });
		await host.next(); // policy

		const token = await mintToken(host, 'rotate-1');
		const viewer = await connect('rotate-1', { viewToken: token });
		await viewer.next(); // policy
		await viewer.next(); // tree

		const closed = viewer.waitClose();
		host.send({ type: 'rotate_view_secret' });
		expect(await host.next()).toEqual({ type: 'ok' });
		expect((await closed).code).toBe(4001);

		const stale = await connectRejected('rotate-1', { cookie: `sb_view_rotate-1=${token}` });
		expect(stale.status).toBe(403);
	});

	test('verify: malformed token format is rejected (401) before ever touching viewSecret storage', async () => {
		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('verify-1'));
		for (const badToken of ['not-a-token', '123.tooshort', '123.' + 'z'.repeat(64), '.deadbeef']) {
			const res = await stub.fetch(`https://do/verify?project=verify-1&token=${badToken}`);
			expect(res.status).toBe(401);
		}

		// A real invite minted afterward still verifies fine — proves the format-guard rejects
		// don't corrupt/skip legitimate viewSecret creation for later real tokens.
		const host = await connect('verify-1', { host: 'valid-host' });
		await host.next(); // policy
		const token = await mintToken(host, 'verify-1');
		const res = await stub.fetch(`https://do/verify?project=verify-1&token=${token}`);
		expect(res.status).toBe(200);
	});

	test('policy: viewer gets policy then tree, host gets policy first', async () => {
		const host = await connect('policy-1', { host: 'valid-host' });
		const policyMsg = await host.next();
		expect(policyMsg).toEqual({
			type: 'policy',
			maxBytes: 524288
		});

		const viewer = await connectViewer(host, 'policy-1');
		expect(await viewer.next()).toEqual(policyMsg);
		expect((await viewer.next()).type).toBe('tree');
	});

	test('policy: binary content and git internals are rejected', async () => {
		const host = await connect('policy-2', { host: 'valid-host' });
		await host.next(); // policy
		host.send(put('data.bin', 'x\0y'));
		expect((await host.next()).type).toBe('error');
		host.send(put('sub/.git/config', '[core]'));
		expect((await host.next()).type).toBe('error');

		const viewer = await connectViewer(host, 'policy-2');
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: [] });
	});

	test('policy: file_put over maxBytes is rejected', async () => {
		const host = await connect('policy-3', { host: 'valid-host' });
		await host.next(); // policy
		host.send(put('big.txt', 'x'.repeat(524289)));
		expect((await host.next()).type).toBe('error');
	});

	test('snapshot + subscribe', async () => {
		const host = await connect('snap-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A'));
		host.send(put('b.txt', 'B'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'snap-1');
		await viewer.next(); // policy
		const tree = await viewer.next();
		expect(tree).toEqual({ type: 'tree', paths: ['a.txt', 'b.txt'] });

		viewer.send({ type: 'subscribe', path: 'a.txt' });
		const file = await viewer.next();
		expect(file).toEqual({ type: 'file', path: 'a.txt', hash: 'A', content: 'A' });
	});

	test('snapshot stale cleanup removes files missing from the new snapshot', async () => {
		const host = await connect('snap-2', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A'));
		host.send(put('b.txt', 'B'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		host.send({ type: 'snapshot_begin' });
		host.send(put('b.txt', 'B'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'snap-2');
		await viewer.next(); // policy
		const tree = await viewer.next();
		expect(tree).toEqual({ type: 'tree', paths: ['b.txt'] });
	});

	test('live update: only the subscribed viewer receives the new file content', async () => {
		const host = await connect('live-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A1'));
		host.send(put('b.txt', 'B1'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewerA = await connectViewer(host, 'live-1');
		await viewerA.next(); // policy
		await viewerA.next(); // tree
		viewerA.send({ type: 'subscribe', path: 'a.txt' });
		await viewerA.next(); // initial file

		const viewerB = await connectViewer(host, 'live-1');
		await viewerB.next(); // policy
		await viewerB.next(); // tree
		viewerB.send({ type: 'subscribe', path: 'b.txt' });
		await viewerB.next(); // initial file

		host.send(put('a.txt', 'A2'));
		expect(await viewerA.next()).toEqual({
			type: 'file',
			path: 'a.txt',
			hash: 'A2',
			content: 'A2'
		});

		// Prove viewerB never got the a.txt update: send a marker put for a brand-new
		// path (broadcast to all viewers as tree_update) and check it's the very next
		// message viewerB sees.
		host.send(put('marker.txt', 'M'));
		expect(await viewerB.next()).toEqual({
			type: 'tree_update',
			added: ['marker.txt'],
			removed: []
		});
	});

	test('subscribe replaces the previous subscription', async () => {
		const host = await connect('sub-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A1'));
		host.send(put('b.txt', 'B1'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'sub-1');
		await viewer.next(); // policy
		await viewer.next(); // tree
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		await viewer.next(); // initial file for a
		viewer.send({ type: 'subscribe', path: 'b.txt' });
		await viewer.next(); // initial file for b

		host.send(put('a.txt', 'A2'));
		host.send(put('b.txt', 'B2'));
		// If the a.txt update had (incorrectly) been sent, it would arrive first.
		expect(await viewer.next()).toEqual({ type: 'file', path: 'b.txt', hash: 'B2', content: 'B2' });
	});

	test('file_delete broadcasts tree_update and removes the file from future trees', async () => {
		const host = await connect('del-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'del-1');
		await viewer.next(); // policy
		await viewer.next(); // tree

		host.send({ type: 'file_delete', path: 'a.txt' });
		expect(await viewer.next()).toEqual({ type: 'tree_update', added: [], removed: ['a.txt'] });

		const laterViewer = await connectViewer(host, 'del-1');
		await laterViewer.next(); // policy
		expect(await laterViewer.next()).toEqual({ type: 'tree', paths: [] });
	});

	test('validation: bad role, bad path, oversized content, and error flood', async () => {
		const host = await connect('val-1', { host: 'valid-host' });
		await host.next(); // policy

		// file_put from a viewer is invalid for its role
		const viewer = await connectViewer(host, 'val-1');
		await viewer.next(); // policy
		await viewer.next(); // tree
		viewer.send(put('a.txt', 'A'));
		expect((await viewer.next()).type).toBe('error');

		// path traversal is rejected and creates nothing
		host.send(put('../evil', 'x'));
		expect((await host.next()).type).toBe('error');
		host.send({ type: 'snapshot_begin' });
		host.send({ type: 'snapshot_end' });
		await syncHost(host);
		const checkViewer = await connectViewer(host, 'val-1');
		await checkViewer.next(); // policy
		expect(await checkViewer.next()).toEqual({ type: 'tree', paths: [] });

		// oversized content is rejected
		host.send(put('big.txt', 'x'.repeat(524289)));
		expect((await host.next()).type).toBe('error');

		// 10 consecutive invalid viewer messages close the connection
		const flood = await connectViewer(host, 'val-1');
		await flood.next(); // policy
		await flood.next(); // tree
		const closed = flood.waitClose();
		for (let i = 0; i < 10; i++) {
			flood.send(put(`x${i}.txt`, 'x')); // file_put is invalid coming from a viewer
		}
		const close = await closed;
		expect(close.code).toBe(1008);
	});

	test('host replaced: second host connection closes the first', async () => {
		const first = await connect('teach-1', { host: 'valid-host' });
		await first.next(); // policy
		const closed = first.waitClose();
		const second = await connect('teach-1', { host: 'valid-host' });
		await second.next(); // policy
		const close = await closed;
		expect(close.code).toBe(4000);

		// second is still usable
		second.send({ type: 'snapshot_begin' });
		second.send({ type: 'snapshot_end' });
		await syncHost(second);
	});

	test('delete_project notifies viewers, clears storage and closes all connections', async () => {
		const host = await connect('del-project-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A'));
		host.send(put('b.txt', 'B'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewerToken = await mintToken(host, 'del-project-1');
		const viewer = await connect('del-project-1', { viewToken: viewerToken });
		await viewer.next(); // policy
		await viewer.next(); // tree

		const hostClosed = host.waitClose();
		const viewerClosed = viewer.waitClose();

		host.send({ type: 'delete_project' });

		expect(await viewer.next()).toEqual({ type: 'project_deleted' });
		expect((await hostClosed).code).toBe(4001);
		expect((await viewerClosed).code).toBe(4001);

		// old viewer cookie is invalid now (viewSecret was wiped by deleteAll)
		const staleViewer = await connectRejected('del-project-1', {
			cookie: `sb_view_del-project-1=${viewerToken}`
		});
		expect(staleViewer.status).toBe(403);

		// a fresh host connection sees an empty room
		const newHost = await connect('del-project-1', { host: 'valid-host' });
		await newHost.next(); // policy
		const newViewer = await connectViewer(newHost, 'del-project-1');
		await newViewer.next(); // policy
		expect(await newViewer.next()).toEqual({ type: 'tree', paths: [] });
	});

	test('delete_project on a live instance re-persists projectId for the surviving host socket', async () => {
		const host = await connect('del-project-2', { host: 'valid-host' });
		await host.next(); // policy

		// delete_project closes every socket (incl. this host's), so reconnect to get
		// a fresh, still-open socket on the same DO instance (in-memory state survives).
		const closed = host.waitClose();
		host.send({ type: 'delete_project' });
		await closed;

		const host2 = await connect('del-project-2', { host: 'valid-host' });
		await host2.next(); // policy

		// Tears down in-memory state (incl. projectId) while hibernating the still-open
		// socket, simulating an idle eviction — same pattern as the mint_invite hibernation
		// test above.
		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('del-project-2'));
		await evictDurableObject(stub);

		host2.send({ type: 'mint_invite', ttlSeconds: 3600 });
		const invite = await host2.next();
		expect(invite.type).toBe('invite');
		expect(invite.url).toMatch(/^\/del-project-2\?token=\d+\.[0-9a-f]+$/);
	});

	test('role guard: viewer sending mint_invite or delete_project gets an error, not the action', async () => {
		const host = await connect('guard-1', { host: 'valid-host' });
		await host.next(); // policy
		const viewer = await connectViewer(host, 'guard-1');
		await viewer.next(); // policy
		await viewer.next(); // tree

		viewer.send({ type: 'mint_invite', ttlSeconds: 60 });
		expect((await viewer.next()).type).toBe('error');

		viewer.send({ type: 'delete_project' });
		expect((await viewer.next()).type).toBe('error');

		// project is intact: host can still put files and a new viewer sees them
		host.send({ type: 'snapshot_begin' });
		host.send(put('still.txt', 'X'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);
		const check = await connectViewer(host, 'guard-1');
		await check.next(); // policy
		expect(await check.next()).toEqual({ type: 'tree', paths: ['still.txt'] });
	});

	test('malformed: garbage frames from the host error out but never close the socket', async () => {
		const host = await connect('mal-1', { host: 'valid-host' });
		await host.next(); // policy

		// Well past the viewer flood threshold (10): the error counter only applies to viewers.
		const garbage = ['not json {', '[]', '"just a string"', 'null', ''];
		for (let i = 0; i < 12; i++) host.ws.send(garbage[i % garbage.length]);
		for (let i = 0; i < 12; i++) expect((await host.next()).type).toBe('error');

		// Still open and fully functional.
		const token = await mintToken(host, 'mal-1');
		expect(token).toMatch(/^\d+\.[0-9a-f]+$/);
	});

	test('malformed: garbage frames from a viewer count toward the too-many-errors close', async () => {
		const host = await connect('mal-2', { host: 'valid-host' });
		await host.next(); // policy
		const viewer = await connectViewer(host, 'mal-2');
		await viewer.next(); // policy
		await viewer.next(); // tree

		const closed = viewer.waitClose();
		const garbage = ['�', '[1,2]', 'null', '{broken', '42'];
		for (let i = 0; i < 10; i++) viewer.ws.send(garbage[i % garbage.length]);
		expect((await closed).code).toBe(1008);
	});

	test('binary frames: a subscribe sent as bytes works the same as text', async () => {
		const host = await connect('bin-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'bin-1');
		await viewer.next(); // policy
		await viewer.next(); // tree
		viewer.ws.send(new TextEncoder().encode(JSON.stringify({ type: 'subscribe', path: 'a.txt' })));
		expect(await viewer.next()).toEqual({ type: 'file', path: 'a.txt', hash: 'A', content: 'A' });
	});

	test('file_put: missing or non-string fields are rejected and create nothing', async () => {
		const host = await connect('put-1', { host: 'valid-host' });
		await host.next(); // policy

		host.send({ type: 'file_put', path: 'a.txt', content: 42, hash: 'h' });
		expect((await host.next()).type).toBe('error');
		host.send({ type: 'file_put', path: 'a.txt', content: 'x' }); // hash missing
		expect((await host.next()).type).toBe('error');
		host.send({ type: 'file_put', path: 42, content: 'x', hash: 'h' });
		expect((await host.next()).type).toBe('error');
		host.send({ type: 'file_put', content: 'x', hash: 'h' }); // path missing
		expect((await host.next()).type).toBe('error');
		host.send({ type: 'file_put', path: 'a.txt', content: null, hash: null });
		expect((await host.next()).type).toBe('error');

		const viewer = await connectViewer(host, 'put-1');
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: [] });
	});

	test('file_put: empty content is stored and served, not treated as missing', async () => {
		const host = await connect('put-2', { host: 'valid-host' });
		await host.next(); // policy
		host.send(put('empty.txt', ''));
		await syncHost(host);

		const viewer = await connectViewer(host, 'put-2');
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: ['empty.txt'] });
		viewer.send({ type: 'subscribe', path: 'empty.txt' });
		expect(await viewer.next()).toEqual({ type: 'file', path: 'empty.txt', hash: '', content: '' });
	});

	test('file_put: content exactly at maxBytes is accepted; byte length (not char count) decides', async () => {
		const host = await connect('put-3', { host: 'valid-host' });
		await host.next(); // policy

		host.send({ type: 'file_put', path: 'max.txt', content: 'x'.repeat(524288), hash: 'max' });
		// '€' is 3 UTF-8 bytes: 174763 chars is 524289 bytes — one over, despite the short string.
		host.send({ type: 'file_put', path: 'multi.txt', content: '€'.repeat(174763), hash: 'm' });
		expect((await host.next()).type).toBe('error');

		const viewer = await connectViewer(host, 'put-3');
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: ['max.txt'] });
	});

	test('file_put: a new hash with identical content still counts as an update', async () => {
		const host = await connect('hash-2', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'file_put', path: 'a.txt', content: 'same', hash: 'h1' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'hash-2');
		await viewer.next(); // policy
		await viewer.next(); // tree
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		expect(await viewer.next()).toEqual({
			type: 'file',
			path: 'a.txt',
			hash: 'h1',
			content: 'same'
		});

		// The server compares hashes only — a changed hash is a change, whatever the content.
		host.send({ type: 'file_put', path: 'a.txt', content: 'same', hash: 'h2' });
		expect(await viewer.next()).toEqual({
			type: 'file',
			path: 'a.txt',
			hash: 'h2',
			content: 'same'
		});
	});

	test('snapshot_end without snapshot_begin is a no-op, not a wipe', async () => {
		const host = await connect('snap-3', { host: 'valid-host' });
		await host.next(); // policy
		host.send(put('keep.txt', 'K'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'snap-3');
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: ['keep.txt'] });
	});

	test('an empty snapshot wipes previously synced files (full re-sync semantics)', async () => {
		const host = await connect('snap-4', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		host.send({ type: 'snapshot_begin' });
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'snap-4');
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: [] });
	});

	test('file_delete: a nonexistent path is idempotent but still broadcasts the removal', async () => {
		const host = await connect('del-2', { host: 'valid-host' });
		await host.next(); // policy
		const viewer = await connectViewer(host, 'del-2');
		await viewer.next(); // policy
		await viewer.next(); // tree

		// Documents current behavior: no existence check before the broadcast. Harmless for
		// clients (removing an unknown path from the tree is a no-op there).
		host.send({ type: 'file_delete', path: 'ghost.txt' });
		expect(await viewer.next()).toEqual({ type: 'tree_update', added: [], removed: ['ghost.txt'] });

		host.send({ type: 'file_delete', path: '../evil' });
		expect((await host.next()).type).toBe('error');
	});

	test('mint_invite: ttl clamps to [60s, 30d]; zero/absent/non-numeric fall back to 1h', async () => {
		const host = await connect('ttl-1', { host: 'valid-host' });
		await host.next(); // policy

		const cases: [unknown, number][] = [
			[60, 60], // lower bound passes through
			[30, 60], // below minimum clamps up
			[-5, 60], // negative clamps up
			[30 * 24 * 3600, 30 * 24 * 3600], // upper bound passes through
			[1e15, 30 * 24 * 3600], // absurdly huge clamps down
			['abc', 3600], // non-numeric -> default
			[0, 3600], // current behavior: 0 is falsy, so it means "default", not "minimum"
			[undefined, 3600] // absent -> default
		];
		for (const [ttlSeconds, expected] of cases) {
			const now = Math.floor(Date.now() / 1000);
			host.send({ type: 'mint_invite', ttlSeconds });
			const m = await host.next();
			expect(m.type).toBe('invite');
			expect(m.expiresAt).toBeGreaterThanOrEqual(now + expected - 2);
			expect(m.expiresAt).toBeLessThanOrEqual(now + expected + 2);
		}
	});

	test('mint_invite: fractional ttl still mints a usable invite (expiry stays integral)', async () => {
		const host = await connect('ttl-2', { host: 'valid-host' });
		await host.next(); // policy

		// Regression: an unfloored fractional ttl made `expiry` fractional, so the token was
		// "<int>.<frac>.<mac>" — verifyInvite split it on the first '.' and could never match.
		host.send({ type: 'mint_invite', ttlSeconds: 90.7 });
		const invite = await host.next();
		expect(invite.type).toBe('invite');
		expect(Number.isInteger(invite.expiresAt)).toBe(true);
		expect(invite.url).toMatch(/^\/ttl-2\?token=\d+\.[0-9a-f]{64}$/);

		const token = new URL(invite.url, 'https://x').searchParams.get('token')!;
		const viewer = await connect('ttl-2', { viewToken: token });
		expect((await viewer.next()).type).toBe('policy');
		expect((await viewer.next()).type).toBe('tree');
	});

	test('files persist across hibernation eviction (SQLite outlives the instance)', async () => {
		const host = await connect('evict-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A'));
		host.send(put('b.txt', 'B'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);
		const token = await mintToken(host, 'evict-1');

		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('evict-1'));
		await evictDurableObject(stub);

		// The pre-eviction invite still works (viewSecret persisted) and the tree is intact.
		const viewer = await connect('evict-1', { viewToken: token });
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: ['a.txt', 'b.txt'] });
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		expect(await viewer.next()).toEqual({ type: 'file', path: 'a.txt', hash: 'A', content: 'A' });
	});

	test('delete_project twice in a row leaves a working, empty room', async () => {
		const first = await connect('del-project-3', { host: 'valid-host' });
		await first.next(); // policy
		first.send(put('a.txt', 'A'));
		const firstClosed = first.waitClose();
		first.send({ type: 'delete_project' });
		expect((await firstClosed).code).toBe(4001);

		const second = await connect('del-project-3', { host: 'valid-host' });
		await second.next(); // policy
		const secondClosed = second.waitClose();
		second.send({ type: 'delete_project' }); // deleting an already-empty room
		expect((await secondClosed).code).toBe(4001);

		const third = await connect('del-project-3', { host: 'valid-host' });
		await third.next(); // policy
		const viewer = await connectViewer(third, 'del-project-3');
		await viewer.next(); // policy
		expect(await viewer.next()).toEqual({ type: 'tree', paths: [] });
	});

	test('subscribe: non-string/missing/unknown paths error without breaking the session', async () => {
		const host = await connect('sub-2', { host: 'valid-host' });
		await host.next(); // policy
		host.send(put('a.txt', 'A'));
		await syncHost(host);

		const viewer = await connectViewer(host, 'sub-2');
		await viewer.next(); // policy
		await viewer.next(); // tree

		viewer.send({ type: 'subscribe', path: 42 });
		expect((await viewer.next()).type).toBe('error');
		viewer.send({ type: 'subscribe' });
		expect((await viewer.next()).type).toBe('error');
		viewer.send({ type: 'subscribe', path: 'nope.txt' });
		expect((await viewer.next()).type).toBe('error');
		viewer.send({ type: 'subscribe', path: 'a.txt/../a.txt' });
		expect((await viewer.next()).type).toBe('error');

		viewer.send({ type: 'subscribe', path: 'a.txt' });
		expect(await viewer.next()).toEqual({ type: 'file', path: 'a.txt', hash: 'A', content: 'A' });
	});

	test('a successful subscribe resets the viewer error counter', async () => {
		const host = await connect('sub-3', { host: 'valid-host' });
		await host.next(); // policy
		host.send(put('a.txt', 'A'));
		await syncHost(host);

		const viewer = await connectViewer(host, 'sub-3');
		await viewer.next(); // policy
		await viewer.next(); // tree

		// 9 + 9 bad messages would close at 10 if the good subscribe in between didn't reset.
		for (let i = 0; i < 9; i++) {
			viewer.send({ type: 'subscribe', path: 'missing.txt' });
			expect((await viewer.next()).type).toBe('error');
		}
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		expect((await viewer.next()).type).toBe('file');
		for (let i = 0; i < 9; i++) {
			viewer.send({ type: 'subscribe', path: 'missing.txt' });
			expect((await viewer.next()).type).toBe('error');
		}
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		expect((await viewer.next()).type).toBe('file');
	});

	test('verify: missing params and cross-project token claims are rejected', async () => {
		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('verify-2'));
		expect((await stub.fetch(`https://do/verify?token=1.${'a'.repeat(64)}`)).status).toBe(401);
		expect((await stub.fetch('https://do/verify?project=verify-2')).status).toBe(401);

		const host = await connect('verify-2', { host: 'valid-host' });
		await host.next(); // policy
		const token = await mintToken(host, 'verify-2');

		const ok = await stub.fetch(`https://do/verify?project=verify-2&token=${token}`);
		expect(ok.status).toBe(200);
		const { maxAge } = (await ok.json()) as { maxAge: number };
		expect(maxAge).toBeGreaterThan(3590);
		expect(maxAge).toBeLessThanOrEqual(3600);

		// Well-formed token, but the mac was signed for verify-2 — claiming another project fails.
		const wrong = await stub.fetch(`https://do/verify?project=other&token=${token}`);
		expect(wrong.status).toBe(401);
	});

	test('hash skip: repeating the same hash does not notify subscribers', async () => {
		const host = await connect('hash-1', { host: 'valid-host' });
		await host.next(); // policy
		host.send({ type: 'snapshot_begin' });
		host.send(put('a.txt', 'A1'));
		host.send({ type: 'snapshot_end' });
		await syncHost(host);

		const viewer = await connectViewer(host, 'hash-1');
		await viewer.next(); // policy
		await viewer.next(); // tree
		viewer.send({ type: 'subscribe', path: 'a.txt' });
		await viewer.next(); // initial file

		host.send(put('a.txt', 'A1')); // same hash as before
		// Marker put on a different, new path broadcasts tree_update to every viewer. If
		// the unchanged a.txt put had (incorrectly) sent `file` to the subscriber, that
		// would arrive first instead of this tree_update.
		host.send(put('marker.txt', 'M'));
		expect(await viewer.next()).toEqual({
			type: 'tree_update',
			added: ['marker.txt'],
			removed: []
		});
	});

	// wrangler.test.jsonc sets PROJECT_TTL_DAYS=30; alarms only ever run when a test
	// drives them with runDurableObjectAlarm(), so this is inert for every other suite.
	describe('idle-project TTL', () => {
		const DAY = 24 * 60 * 60 * 1000;

		// Rewinds both activity signals — the host-connect stamp and files.updated_at — so
		// the alarm sees a project that has been untouched for `ageMs`.
		async function backdateActivity(project: string, ageMs: number) {
			const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(project));
			await runInDurableObject(stub, async (_instance, state) => {
				const when = Date.now() - ageMs;
				await state.storage.put('lastActivityAt', when);
				state.storage.sql.exec('UPDATE files SET updated_at = ?', when);
			});
		}

		const alarmAt = (project: string) =>
			runInDurableObject(env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(project)), (_i, state) =>
				state.storage.getAlarm()
			);

		test('only a positive number enables expiry; anything else means never', () => {
			expect(inactivityTtlMs({})).toBeNull();
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: '' })).toBeNull();
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: '0' })).toBeNull();
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: '-5' })).toBeNull();
			// A typo has to fail safe: "never expire", never "expire immediately".
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: '7d' })).toBeNull();
			// Spelled-out forms, for a config that states the policy instead of omitting it.
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: 'never' })).toBeNull();
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: 'unlimited' })).toBeNull();
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: '7' })).toBe(7 * DAY);
			expect(inactivityTtlMs({ PROJECT_TTL_DAYS: '30' })).toBe(30 * DAY);
		});

		test('a project idle past the TTL is deleted, and its viewers are told', async () => {
			const host = await connect('ttl-expired', { host: 'valid-host' });
			await host.next(); // policy
			host.send(put('a.txt', 'A'));
			await syncHost(host);
			const viewer = await connectViewer(host, 'ttl-expired');
			await viewer.next(); // policy
			await viewer.next(); // tree

			await backdateActivity('ttl-expired', 31 * DAY);
			const viewerClosed = viewer.waitClose();
			const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('ttl-expired'));
			expect(await runDurableObjectAlarm(stub)).toBe(true);

			expect(await viewer.next()).toEqual({ type: 'project_deleted' });
			expect((await viewerClosed).code).toBe(4001);

			// same end state as an explicit delete_project: an empty room, no leftover alarm
			const newHost = await connect('ttl-expired', { host: 'valid-host' });
			await newHost.next(); // policy
			const newViewer = await connectViewer(newHost, 'ttl-expired');
			await newViewer.next(); // policy
			expect(await newViewer.next()).toEqual({ type: 'tree', paths: [] });
		});

		test('a project touched within the TTL survives and re-arms the alarm', async () => {
			const host = await connect('ttl-active', { host: 'valid-host' });
			await host.next(); // policy
			host.send(put('a.txt', 'A'));
			await syncHost(host);

			await backdateActivity('ttl-active', 29 * DAY); // idle, but not long enough
			const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName('ttl-active'));
			expect(await runDurableObjectAlarm(stub)).toBe(true);

			const viewer = await connectViewer(host, 'ttl-active');
			await viewer.next(); // policy
			expect(await viewer.next()).toEqual({ type: 'tree', paths: ['a.txt'] });

			// and it comes back to re-check at the point it *would* fall idle: ~1 day out
			// (30 - 29), not a fresh full TTL.
			const scheduled = await alarmAt('ttl-active');
			expect(scheduled).not.toBeNull();
			expect(scheduled! - Date.now()).toBeGreaterThan(0);
			expect(scheduled! - Date.now()).toBeLessThanOrEqual(DAY + 60_000);
		});

		test('delete_project clears the pending alarm', async () => {
			const host = await connect('ttl-cleared', { host: 'valid-host' });
			await host.next(); // policy
			expect(await alarmAt('ttl-cleared')).not.toBeNull();

			const closed = host.waitClose();
			host.send({ type: 'delete_project' });
			await closed;

			// Pins the outcome, not the mechanism: deleteAll() alone already clears the alarm
			// under Miniflare, so this passes with or without wipe()'s explicit deleteAlarm().
			// It's here to catch a deleted project that keeps waking on a stale alarm.
			expect(await alarmAt('ttl-cleared')).toBeNull();
		});
	});
});
