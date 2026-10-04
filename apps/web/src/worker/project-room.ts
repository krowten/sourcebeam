import { DurableObject } from 'cloudflare:workers';
import {
	DEFAULT_POLICY,
	inviteExpiry,
	isAllowedFile,
	isValidPath,
	parseJson,
	PING,
	PONG,
	signInvite,
	verifyInvite,
	VIEWER_SESSION_SECONDS,
	type ServerMessage
} from '@sourcebeam/protocol';

export type Env = {
	HOST_TOKENS: KVNamespace;
	PROJECT_ROOM: DurableObjectNamespace;
	// Days a project may sit idle before it deletes itself. Unset = never, see wrangler.jsonc.
	PROJECT_TTL_DAYS?: string;
};

// expiresAt is unix seconds from the invite that authenticated this socket, null for hosts
// (a host token doesn't expire on its own — see HOST_TOKENS/KV revocation instead).
type Attachment = {
	role: 'host' | 'viewer';
	subscribedPath: string | null;
	errors: number;
	expiresAt: number | null;
};

const MAX_VIEWER_ERRORS = 10;

/**
 * Idle lifetime from `PROJECT_TTL_DAYS`, or null for "keep forever" (the default).
 *
 * `"never"`/`"unlimited"` say that explicitly, for a config that would rather state the
 * policy than imply it by omission. Anything else that isn't a positive, finite number —
 * unset, empty, `"0"`, a typo like `"7d"` — means the same thing. Erring the other way would
 * let one bad character in a config file quietly delete a self-hoster's projects, which is
 * the worst failure this feature could have.
 */
export function inactivityTtlMs(env: Pick<Env, 'PROJECT_TTL_DAYS'>): number | null {
	const days = Number(env.PROJECT_TTL_DAYS);
	if (!Number.isFinite(days) || days <= 0) return null;
	return days * 24 * 60 * 60 * 1000;
}

// signInvite() always produces `<unix-expiry>.<64-hex-char HMAC-SHA256>` (see invite.ts) —
// anything else can never verify.
const TOKEN_FORMAT = /^\d+\.[0-9a-f]{64}$/;

export class ProjectRoom extends DurableObject<Env> {
	// Snapshot progress (seenPaths) lives only in instance memory, not in the
	// attachment. Persisting it per file_put would mean a storage write on every single
	// file during a snapshot. If the DO gets evicted mid-snapshot, stale-path cleanup is
	// simply deferred to the next snapshot — the watcher always re-syncs a full snapshot
	// on reconnect, so nothing is lost, just delayed.
	private seenPaths: Set<string> | null = null;

	// The DO doesn't know its own name; the Worker passes it as `?project=` on every
	// proxied request (WS upgrade and the internal /verify check), see routing.ts.
	private projectId = '';

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ensureFilesTable();
		// Viewer heartbeats are answered by the runtime itself, so they never wake a hibernating DO.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	private ensureFilesTable() {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS files (
			   path TEXT PRIMARY KEY, content TEXT NOT NULL,
			   hash TEXT NOT NULL, updated_at INTEGER NOT NULL)`
		);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const project = url.searchParams.get('project');
		// In-memory only here — no storage write, so an unauthenticated /verify scan (any
		// project name, any garbage token) never touches storage. Persisted below, once we
		// know the caller is an authenticated host (see host-upgrade branch).
		if (project && project !== this.projectId) {
			this.projectId = project;
		}

		if (url.pathname === '/verify') {
			return this.handleVerify(url);
		}

		// Authorization is resolved before the Upgrade check (not after, as this used to be)
		// so that a plain, non-upgrading request to this same path can serve as an auth probe:
		// the viewer's reachability check (live-client.svelte.ts's probeThenDecide) needs to
		// tell "your invite is bad" (403) apart from "something else about the WS handshake
		// failed" (cold start, transient 503, network blip) without spinning up a socket, and
		// the page shell it used to HEAD instead never checks the invite at all (ssr disabled).
		const auth = request.headers.get('Authorization');
		let role: 'host' | 'viewer' = 'viewer';
		let expiresAt: number | null = null;
		if (auth !== null) {
			const token = auth.replace(/^Bearer\s+/, '');
			if (!token || (await this.env.HOST_TOKENS.get(token)) === null) {
				return new Response('forbidden', { status: 403 });
			}
			role = 'host';
		}

		if (role === 'viewer') {
			const token = this.cookieToken(request.headers.get('Cookie'), this.projectId);
			const now = Math.floor(Date.now() / 1000);
			if (!token || !(await verifyInvite(token, this.projectId, await this.viewSecret(), now))) {
				return new Response('invite required', { status: 403 });
			}
			// Guaranteed non-null: verifyInvite just accepted this exact token, which means
			// inviteExpiry() already parsed a finite, still-in-the-future expiry out of it.
			expiresAt = inviteExpiry(token);
		}

		if (request.headers.get('Upgrade') !== 'websocket') {
			// Authorization already succeeded above (this request would 403 otherwise) — this
			// is a probe, not an error. Answer without opening a socket or touching activity.
			return new Response(null, { status: 204 });
		}

		if (role === 'host') {
			// Persisted only for a real (about-to-open) host connection, not every probe:
			// needed so projectName() (mint_invite) survives a hibernation eviction, without
			// giving an unauthenticated /verify scan a free storage write per request.
			await this.ctx.storage.put('projectId', this.projectId);
			await this.touchActivity();
			for (const ws of this.ctx.getWebSockets('host')) {
				ws.close(4000, 'replaced by new host connection');
			}
		}

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [role]);
		const attachment: Attachment = { role, subscribedPath: null, errors: 0, expiresAt };
		server.serializeAttachment(attachment);

		server.send(
			JSON.stringify({
				type: 'policy',
				maxBytes: DEFAULT_POLICY.maxBytes
			} satisfies ServerMessage)
		);
		if (role === 'viewer') {
			server.send(JSON.stringify(this.treeMessage()));
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		const attachment = ws.deserializeAttachment() as Attachment;
		// Expiry was only checked once, at handshake — a viewer connected before its invite
		// expired would otherwise stay subscribed (and keep receiving broadcasts, see
		// trySend()) for as long as the socket happens to stay open. Cut it off here too, on
		// its own next message, in addition to the passive check on outbound delivery.
		if (attachment.role === 'viewer' && this.isExpired(attachment)) {
			ws.close(4001, 'invite expired');
			return;
		}
		const msg = parseJson(raw);
		if (!msg) {
			this.reject(ws, attachment, 'invalid message: not JSON');
			return;
		}
		if (attachment.role === 'host') {
			this.handleHostMessage(ws, msg);
		} else {
			this.handleViewerMessage(ws, attachment, msg);
		}
	}

	async webSocketClose() {
		// no-op: attachment (role/subscribedPath/errors) dies with the socket,
		// there is no server-side state that needs releasing on disconnect.
	}

	/**
	 * Collects the project once it has gone `PROJECT_TTL_DAYS` without activity.
	 *
	 * The alarm is armed on host connect and then re-arms itself from here, so a project in
	 * regular use (a class broadcast every week) keeps pushing its own deadline out and is
	 * never collected — only genuinely abandoned ones are. That also means the common case
	 * costs one alarm wake per TTL period, not one per edit.
	 */
	async alarm(): Promise<void> {
		const ttl = inactivityTtlMs(this.env);
		// TTL switched off after this alarm was armed: leave the data alone, stop rescheduling.
		if (ttl === null) return;

		const idle = Date.now() - (await this.lastActivityAt());
		if (idle < ttl) {
			await this.ctx.storage.setAlarm(Date.now() + (ttl - idle));
			return;
		}

		this.broadcast({ type: 'project_deleted' }, (a) => a.role === 'viewer');
		await this.wipe();
		for (const s of this.ctx.getWebSockets()) s.close(4001, 'project expired');
	}

	private handleHostMessage(ws: WebSocket, msg: Record<string, unknown>) {
		switch (msg.type) {
			case 'snapshot_begin':
				this.seenPaths = new Set();
				return;
			case 'file_put':
				this.handleFilePut(ws, msg);
				return;
			case 'file_delete':
				this.handleFileDelete(ws, msg);
				return;
			case 'snapshot_end':
				this.handleSnapshotEnd();
				return;
			case 'mint_invite':
				void this.handleMintInvite(ws, msg).catch((e) => this.sendError(ws, String(e)));
				return;
			case 'rotate_view_secret':
				void this.handleRotateViewSecret(ws).catch((e) => this.sendError(ws, String(e)));
				return;
			case 'delete_project':
				void this.handleDeleteProject(ws).catch((e) => this.sendError(ws, String(e)));
				return;
			default:
				this.sendError(ws, `unknown message type: ${String(msg.type)}`);
		}
	}

	private handleViewerMessage(ws: WebSocket, attachment: Attachment, msg: Record<string, unknown>) {
		if (msg.type !== 'subscribe') {
			this.reject(ws, attachment, `unexpected message type: ${String(msg.type)}`);
			return;
		}

		const path = msg.path;
		if (!isValidPath(path)) {
			this.reject(ws, attachment, 'invalid path');
			return;
		}

		const row = this.ctx.storage.sql
			.exec('SELECT content, hash FROM files WHERE path = ?', path)
			.toArray()[0] as { content: string; hash: string } | undefined;
		if (!row) {
			this.reject(ws, attachment, `file not found: ${path}`);
			return;
		}

		attachment.subscribedPath = path;
		attachment.errors = 0;
		ws.serializeAttachment(attachment);
		ws.send(
			JSON.stringify({
				type: 'file',
				path,
				hash: row.hash,
				content: row.content
			} satisfies ServerMessage)
		);
	}

	private handleFilePut(ws: WebSocket, msg: Record<string, unknown>) {
		const { path, content, hash } = msg;
		if (!isValidPath(path) || typeof content !== 'string' || typeof hash !== 'string') {
			this.sendError(ws, 'invalid file_put message');
			return;
		}
		const bytes = new TextEncoder().encode(content).length;
		if (!isAllowedFile(path, bytes, content)) {
			this.sendError(ws, `file rejected by policy: ${path}`);
			return;
		}

		const existing = this.ctx.storage.sql
			.exec('SELECT hash FROM files WHERE path = ?', path)
			.toArray()[0] as { hash: string } | undefined;

		if (existing && existing.hash === hash) {
			// content unchanged since last snapshot/put: nothing to store or broadcast,
			// just mark the path as seen if we're mid-snapshot.
			this.seenPaths?.add(path);
			return;
		}

		const isNewPath = !existing;
		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO files (path, content, hash, updated_at) VALUES (?, ?, ?, ?)',
			path,
			content,
			hash,
			Date.now()
		);
		this.seenPaths?.add(path);

		this.broadcastToSubscribers(path, { type: 'file', path, hash, content });

		// tree_update only makes sense outside a snapshot: during a snapshot the final
		// tree is broadcast once, in full, on snapshot_end.
		if (this.seenPaths === null && isNewPath) {
			this.broadcast(
				{ type: 'tree_update', added: [path], removed: [] },
				(a) => a.role === 'viewer'
			);
		}
	}

	private handleFileDelete(ws: WebSocket, msg: Record<string, unknown>) {
		const path = msg.path;
		if (!isValidPath(path)) {
			this.sendError(ws, 'invalid file_delete message');
			return;
		}
		this.ctx.storage.sql.exec('DELETE FROM files WHERE path = ?', path);
		this.broadcast({ type: 'tree_update', added: [], removed: [path] }, (a) => a.role === 'viewer');
	}

	private handleSnapshotEnd() {
		if (this.seenPaths === null) return; // snapshot_end without snapshot_begin: ignore
		const seen = this.seenPaths;
		this.seenPaths = null;

		for (const path of this.listPaths()) {
			if (!seen.has(path)) {
				this.ctx.storage.sql.exec('DELETE FROM files WHERE path = ?', path);
			}
		}

		this.broadcast(this.treeMessage(), (a) => a.role === 'viewer');
	}

	// Defense in depth: handleHostMessage is the only current call site and already
	// gates on role, but a future refactor could wire a sensitive handler to a viewer
	// path by mistake. Each sensitive handler re-checks the role itself.
	private async handleMintInvite(ws: WebSocket, msg: Record<string, unknown>) {
		const a = ws.deserializeAttachment() as Attachment;
		if (a.role !== 'host') {
			this.sendError(ws, 'forbidden');
			return;
		}
		const project = await this.projectName();
		// Math.floor matters: a fractional ttl would make `expiry` fractional, and both
		// verifyInvite (splits the token on its first '.') and TOKEN_FORMAT would then
		// reject the minted token — a well-formed-looking invite that never grants access.
		const ttl = Math.max(60, Math.min(Math.floor(Number(msg.ttlSeconds)) || 3600, 30 * 24 * 3600));
		const expiry = Math.floor(Date.now() / 1000) + ttl;
		const token = await signInvite(project, expiry, await this.viewSecret());
		ws.send(
			JSON.stringify({
				type: 'invite',
				url: `/${project}?token=${token}`,
				expiresAt: expiry
			} satisfies ServerMessage)
		);
	}

	private async handleRotateViewSecret(ws: WebSocket) {
		const a = ws.deserializeAttachment() as Attachment;
		if (a.role !== 'host') {
			this.sendError(ws, 'forbidden');
			return;
		}
		await this.rotateViewSecret();
		for (const s of this.ctx.getWebSockets('viewer')) s.close(4001, 'invites revoked');
		ws.send(JSON.stringify({ type: 'ok' } satisfies ServerMessage));
	}

	private async handleDeleteProject(ws: WebSocket) {
		const a = ws.deserializeAttachment() as Attachment;
		if (a.role !== 'host') {
			this.sendError(ws, 'forbidden');
			return;
		}
		this.broadcast({ type: 'project_deleted' }, (attachment) => attachment.role === 'viewer');
		await this.wipe();
		for (const s of this.ctx.getWebSockets()) s.close(4001, 'project deleted');
	}

	// storage.deleteAll() clears the files table, the persisted viewSecret, and the
	// persisted projectId in one shot; any viewer reconnecting afterward gets a fresh
	// (empty) room under a new secret, so pre-deletion invite cookies stop working too.
	// Shared by the explicit delete_project command and the idle-TTL alarm, so the two
	// can't drift into deleting different subsets of the room's state.
	private async wipe(): Promise<void> {
		await this.ctx.storage.deleteAll();
		// Belt and braces: under Miniflare deleteAll() already drops the pending alarm (the
		// spec test passes without this line), but the alarm docs never state that, so
		// production is not guaranteed to agree. A surviving alarm would quietly wake an
		// empty DO once per TTL forever, so pay one call rather than bet on undocumented
		// behaviour matching between the emulator and workerd.
		await this.ctx.storage.deleteAlarm();
		// deleteAll() drops the `files` table too; the constructor only creates it once
		// per DO instance lifetime, so a reconnect after deletion needs it recreated here.
		this.ensureFilesTable();
		// deleteAll() also wipes the persisted `projectId` key, but this.projectId (memory)
		// survives on a live instance. Clear it so the next fetch() (still-open host
		// reconnecting, or the Worker's ?project= on any request) re-persists it — otherwise
		// a later hibernation eviction would find nothing in storage and projectName()
		// would resolve to '', breaking mint_invite (empty-project invite URL).
		this.projectId = '';
		this.seenPaths = null;
	}

	private async handleVerify(url: URL): Promise<Response> {
		const project = url.searchParams.get('project');
		const token = url.searchParams.get('token');
		// Cheap reject before viewSecret(): a malformed token can never verify, so bail here
		// instead of touching storage (viewSecret() creates+persists a secret on first read) —
		// otherwise an unauthenticated scan of `?token=garbage` across many project names would
		// spin up a fresh DO + storage row per guess.
		if (!project || !token || !TOKEN_FORMAT.test(token)) {
			return new Response('invalid', { status: 401 });
		}
		const now = Math.floor(Date.now() / 1000);
		if (!(await verifyInvite(token, project, await this.viewSecret(), now))) {
			return new Response('invalid', { status: 401 });
		}
		// Trade the invite for a long-lived viewer session, see VIEWER_SESSION_SECONDS.
		const session = await signInvite(
			project,
			now + VIEWER_SESSION_SECONDS,
			await this.viewSecret()
		);
		return Response.json({ token: session, maxAge: VIEWER_SESSION_SECONDS });
	}

	// this.projectId is in-memory only; it's lost across hibernation eviction (the DO can
	// wake up on webSocketMessage without going through fetch again, where the Worker's
	// `?project=` would repopulate it). Fall back to the copy fetch() persisted to storage.
	private async projectName(): Promise<string> {
		if (!this.projectId) {
			this.projectId = (await this.ctx.storage.get<string>('projectId')) ?? '';
		}
		return this.projectId;
	}

	// Called only on host connect — a rare event that already writes to storage anyway.
	// Deliberately NOT called per file_put: that would add a storage write per file, and a
	// 500-file snapshot would pay for 500 of them (the same reasoning that keeps seenPaths
	// in memory). The alarm reads MAX(files.updated_at) instead, which file_put already
	// maintains for free.
	private async touchActivity(): Promise<void> {
		const ttl = inactivityTtlMs(this.env);
		if (ttl === null) return;
		const now = Date.now();
		await this.ctx.storage.put('lastActivityAt', now);
		await this.ctx.storage.setAlarm(now + ttl);
	}

	// Newest of "a host was here" and "a file changed". Viewer traffic deliberately doesn't
	// count: the host is the one who owns the project, and otherwise anyone holding a live
	// invite could keep an abandoned project alive indefinitely just by watching it.
	private async lastActivityAt(): Promise<number> {
		const lastHostConnect = (await this.ctx.storage.get<number>('lastActivityAt')) ?? 0;
		const row = this.ctx.storage.sql
			.exec('SELECT MAX(updated_at) AS latest FROM files')
			.toArray()[0] as { latest: number | null } | undefined;
		return Math.max(lastHostConnect, row?.latest ?? 0);
	}

	private async viewSecret(): Promise<ArrayBuffer> {
		let secret = await this.ctx.storage.get<ArrayBuffer>('viewSecret');
		if (!secret) {
			secret = crypto.getRandomValues(new Uint8Array(32)).buffer;
			await this.ctx.storage.put('viewSecret', secret);
		}
		return secret;
	}

	private async rotateViewSecret(): Promise<void> {
		await this.ctx.storage.put('viewSecret', crypto.getRandomValues(new Uint8Array(32)).buffer);
	}

	private cookieToken(cookieHeader: string | null, project: string): string | null {
		if (!cookieHeader) return null;
		for (const part of cookieHeader.split(';')) {
			const [k, v] = part.trim().split('=');
			if (k === `sb_view_${project}`) return v ?? null;
		}
		return null;
	}

	private sendError(ws: WebSocket, message: string) {
		ws.send(JSON.stringify({ type: 'error', message } satisfies ServerMessage));
	}

	// Sends the error and, for viewers only, counts it toward the too-many-errors close
	// (protects the room from a misbehaving/malicious viewer client spamming garbage).
	private reject(ws: WebSocket, attachment: Attachment, message: string) {
		this.sendError(ws, message);
		if (attachment.role !== 'viewer') return;
		attachment.errors += 1;
		if (attachment.errors >= MAX_VIEWER_ERRORS) {
			ws.close(1008, 'too many errors');
			return;
		}
		ws.serializeAttachment(attachment);
	}

	private listPaths(): string[] {
		return this.ctx.storage.sql
			.exec('SELECT path FROM files ORDER BY path')
			.toArray()
			.map((r) => r.path as string);
	}

	private treeMessage(): ServerMessage {
		return { type: 'tree', paths: this.listPaths() };
	}

	private broadcast(msg: ServerMessage, filter?: (a: Attachment) => boolean) {
		const payload = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets()) {
			const a = ws.deserializeAttachment() as Attachment;
			if (this.dropIfExpired(ws, a)) continue;
			if (!filter || filter(a)) this.trySend(ws, payload);
		}
	}

	private broadcastToSubscribers(path: string, msg: ServerMessage) {
		const payload = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets('viewer')) {
			const a = ws.deserializeAttachment() as Attachment;
			if (this.dropIfExpired(ws, a)) continue;
			if (a.subscribedPath === path) this.trySend(ws, payload);
		}
	}

	private isExpired(a: Attachment): boolean {
		return a.expiresAt !== null && a.expiresAt <= Math.floor(Date.now() / 1000);
	}

	// Delivery-time enforcement of invite expiry (see webSocketMessage for the inbound side):
	// a purely passive viewer tab never sends another message after `subscribe`, so without
	// this check it would keep receiving `file`/`tree_update` broadcasts past its invite's
	// expiry for as long as the socket happens to stay open. Returns true if the socket was
	// expired (and closed), so the caller can skip it instead of sending.
	private dropIfExpired(ws: WebSocket, a: Attachment): boolean {
		if (a.role !== 'viewer' || !this.isExpired(a)) return false;
		ws.close(4001, 'invite expired');
		return true;
	}

	// A socket can flip to CLOSED between getWebSockets() and send() (client disconnected
	// mid-broadcast); swallow that so one dead peer doesn't abort delivery to the rest.
	private trySend(ws: WebSocket, payload: string) {
		try {
			ws.send(payload);
		} catch {
			// ignore: socket closed concurrently
		}
	}
}
