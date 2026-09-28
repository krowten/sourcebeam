import type { ServerMessage, HostMessage } from '@sourcebeam/protocol';

async function sha256Hex(content: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Seeded into HOST_TOKENS (local KV) by `bun run preview` (package.json), see wrangler.jsonc.
const DEV_HOST_TOKEN = 'dev-host';

/** Rewrites an invite URL (`/project?token=...`) into a deep link (`/project/a/b.py?token=...`).
 * The token→cookie exchange (worker/routing.ts) preserves whatever path it was hit on. */
export function inviteDeepLink(inviteUrl: string, filePath: string): string {
	const [path, query] = inviteUrl.split('?');
	return `${path}/${filePath}?${query}`;
}

/** Fake watcher: drives a project room's host WebSocket for e2e tests. */
export class FakeHost {
	private ws: WebSocket | null = null;
	// Resolved once the server's first message (the `policy` broadcast every fresh
	// connection gets) lands — mint_invite/rotate/delete replies race it otherwise.
	private ready: Promise<void> | null = null;

	connect(base: string, project: string, token = DEV_HOST_TOKEN): Promise<void> {
		const url = `${base.replace(/^http/, 'ws')}/ws/${project}`;
		const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
		this.ws = ws;
		this.ready = new Promise((resolve) => {
			ws.onmessage = () => resolve();
		});
		return new Promise((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error(`FakeHost: failed to connect to ${url}`));
		});
	}

	private send(msg: HostMessage): void {
		if (!this.ws) throw new Error('FakeHost: not connected');
		this.ws.send(JSON.stringify(msg));
	}

	/** Sends `mint_invite` and waits for the matching `invite` reply; returns its URL. */
	async mintInvite(ttlSeconds = 3600): Promise<string> {
		await this.ready;
		const ws = this.ws;
		if (!ws) throw new Error('FakeHost: not connected');
		const reply = new Promise<string>((resolve, reject) => {
			const onMessage = (ev: MessageEvent) => {
				const msg = JSON.parse(ev.data as string) as ServerMessage;
				if (msg.type === 'invite') {
					ws.removeEventListener('message', onMessage);
					resolve(msg.url);
				} else if (msg.type === 'error') {
					ws.removeEventListener('message', onMessage);
					reject(new Error(`FakeHost: mint_invite failed: ${msg.message}`));
				}
			};
			ws.addEventListener('message', onMessage);
		});
		this.send({ type: 'mint_invite', ttlSeconds });
		return reply;
	}

	/** Sends `rotate_view_secret` and waits for the `ok` reply, so callers can rely on the
	 * DO having already persisted the new secret before touching an old invite/cookie. */
	async rotateViewSecret(): Promise<void> {
		await this.ready;
		return this.waitForOk('rotate_view_secret');
	}

	deleteProject(): void {
		this.send({ type: 'delete_project' });
	}

	private waitForOk(type: 'rotate_view_secret'): Promise<void> {
		const ws = this.ws;
		if (!ws) throw new Error('FakeHost: not connected');
		const reply = new Promise<void>((resolve, reject) => {
			const onMessage = (ev: MessageEvent) => {
				const msg = JSON.parse(ev.data as string) as ServerMessage;
				if (msg.type === 'ok') {
					ws.removeEventListener('message', onMessage);
					resolve();
				} else if (msg.type === 'error') {
					ws.removeEventListener('message', onMessage);
					reject(new Error(`FakeHost: ${type} failed: ${msg.message}`));
				}
			};
			ws.addEventListener('message', onMessage);
		});
		this.send({ type });
		return reply;
	}

	async snapshot(files: Record<string, string>): Promise<void> {
		this.send({ type: 'snapshot_begin' });
		for (const [path, content] of Object.entries(files)) {
			this.send({ type: 'file_put', path, hash: await sha256Hex(content), content });
		}
		this.send({ type: 'snapshot_end' });
	}

	// Not `void` per the brief's sketch: the hash has to go through crypto.subtle, which is
	// only async. Callers await it.
	async put(path: string, content: string): Promise<void> {
		this.send({ type: 'file_put', path, hash: await sha256Hex(content), content });
	}

	del(path: string): void {
		this.send({ type: 'file_delete', path });
	}

	close(): void {
		this.ws?.close();
		this.ws = null;
	}
}
