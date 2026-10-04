import {
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	PING,
	PONG,
	RECONNECT_MIN_MS,
	RECONNECT_MAX_MS,
	parseJson,
	type Policy,
	type ServerMessage,
	type ViewerMessage
} from '@sourcebeam/protocol';
import { buildTree, firstFile } from './tree';

export type LiveFile = { path: string; hash: string; content: string };

/** Pure function for testing: the invite is invalid if the socket closed before the first
 * message of this attempt and it isn't a close following `project_deleted`. */
export function shouldMarkInviteInvalid(state: {
	gotMessageThisAttempt: boolean;
	projectDeleted: boolean;
}): boolean {
	return !state.gotMessageThisAttempt && !state.projectDeleted;
}

/** Pure function for testing: close-before-first-message only *suspects* invite-invalid — that's
 * just as true for a revoked cookie as for a network drop before/during the handshake (cold
 * start, 503, offline viewer, a Cloudflare edge hiccup that only affects WS upgrades). Disambiguate
 * with an HTTP probe against the same `/ws/:project` path the DO itself authorizes (see
 * project-room.ts's fetch(): it resolves the invite check before deciding whether to upgrade, so a
 * plain GET/HEAD gets a definitive answer without a socket). Only an explicit 403 means the
 * invite is actually bad; any other status (200/204/404/503/...) or a thrown fetch is just as
 * consistent with a transient failure, so it falls back to a normal reconnect instead of a false
 * "invalid" that would strand the viewer needing a manual reload. */
export function resolveCloseBeforeMessage(probeStatus: number | null): 'invalid' | 'reconnect' {
	return probeStatus === 403 ? 'invalid' : 'reconnect';
}

export type LiveClient = {
	readonly status: 'connecting' | 'live' | 'reconnecting';
	readonly paths: string[];
	readonly treeReceived: boolean;
	readonly openPath: string | null;
	readonly file: LiveFile | null;
	readonly deleted: boolean;
	readonly policy: Policy | null;
	readonly projectDeleted: boolean;
	readonly inviteInvalid: boolean;
	open(path: string): void;
	close(): void;
};

export function createLiveClient(projectId: string): LiveClient {
	let status = $state<'connecting' | 'live' | 'reconnecting'>('connecting');
	let paths = $state<string[]>([]);
	// Set once the first `tree` message lands, never reset — a reconnect gets a fresh `tree`
	// too, so the empty-project stub should keep waiting for it rather than flash empty first.
	let treeReceived = $state(false);
	let openPath = $state<string | null>(null);
	let file = $state<LiveFile | null>(null);
	let deleted = $state(false);
	let policy = $state<Policy | null>(null);
	let projectDeleted = $state(false);
	let inviteInvalid = $state(false);

	let ws: WebSocket | null = null;
	let closed = false;
	let attempt = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	// Armed by a ping, disarmed by any inbound frame; firing means the link is dead.
	let pongTimer: ReturnType<typeof setTimeout> | null = null;
	// Per-attempt (not sticky, unlike treeReceived): true as soon as the current socket has
	// received its first message (policy or tree). Reset at the start of every connect(), otherwise
	// an invite revoked after a successful session would be indistinguishable from a first
	// connection without a cookie — invite-invalid would get masked by last attempt's
	// treeReceived=true and spiral into a reconnect storm.
	let gotMessageThisAttempt = false;

	function wsUrl(): string {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${location.host}/ws/${projectId}`;
	}

	function send(msg: ViewerMessage): void {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
	}

	function handleMessage(msg: ServerMessage): void {
		gotMessageThisAttempt = true;
		switch (msg.type) {
			case 'policy':
				// The file policy isn't load-bearing for the viewer right now — stored for possible future UI.
				policy = msg;
				return;
			case 'project_deleted':
				projectDeleted = true;
				return;
			case 'tree': {
				paths = msg.paths;
				treeReceived = true;
				// Snapshot restart replaces the tree wholesale (no removed/added diff like
				// tree_update): if the file the viewer has open didn't survive, flag it
				// deleted the same way tree_update does — keep `file` around so the stale
				// content stays visible under the "deleted" banner instead of blanking out.
				if (openPath && !msg.paths.includes(openPath)) deleted = true;
				return;
			}
			case 'tree_update': {
				// Throwaway lookup sets local to this handler, never stored in $state — no UI
				// reactivity needed, so plain Sets (not SvelteSet) are correct here.
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				const removed = new Set(msg.removed);
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				const kept = new Set(paths.filter((p) => !removed.has(p)));
				for (const p of msg.added) kept.add(p);
				paths = [...kept].sort();
				if (openPath && removed.has(openPath)) deleted = true;
				return;
			}
			case 'file':
				if (msg.path === openPath) {
					if (!file || file.hash !== msg.hash) {
						file = { path: msg.path, hash: msg.hash, content: msg.content };
					}
					deleted = false;
				}
				return;
			case 'error': {
				// Stale deep-link (subscribe on a path the server doesn't have): fall back to
				// the first file of the current tree, same as an empty-path deep link would.
				const fallback = firstFile(buildTree(paths));
				if (fallback && fallback !== openPath) open(fallback);
				return;
			}
		}
	}

	async function probeThenDecide(): Promise<void> {
		const status = await fetch(`/ws/${projectId}`, {
			method: 'HEAD',
			cache: 'no-store',
			// It can ride a keep-alive connection that died with the network and hang for good.
			signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS)
		})
			.then((res) => res.status)
			// network unreachable — not our call to make, treat like any transient failure
			.catch(() => null);
		if (closed) return; // close() ran while the probe was in flight
		if (resolveCloseBeforeMessage(status) === 'invalid') {
			inviteInvalid = true;
		} else {
			scheduleReconnect();
		}
	}

	function connect(): void {
		status = attempt === 0 ? 'connecting' : 'reconnecting';
		gotMessageThisAttempt = false;
		const socket = new WebSocket(wsUrl());
		ws = socket;
		// A handshake sent into a dead network can hang as long as a dead open socket can.
		const handshakeTimer = setTimeout(() => {
			if (ws === socket && socket.readyState === WebSocket.CONNECTING) abandon(socket);
		}, HEARTBEAT_TIMEOUT_MS);

		socket.addEventListener('open', () => {
			clearTimeout(handshakeTimer);
			attempt = 0;
			status = 'live';
			if (openPath) send({ type: 'subscribe', path: openPath });
			startHeartbeat(socket);
		});
		socket.addEventListener('message', (ev) => {
			if (pongTimer) clearTimeout(pongTimer);
			pongTimer = null;
			if (ev.data === PONG) return;
			const msg = parseJson(ev.data as string | ArrayBuffer);
			if (msg) handleMessage(msg as ServerMessage);
		});
		socket.addEventListener('close', () => {
			clearTimeout(handshakeTimer);
			// An abandoned socket may still report its close much later.
			if (closed || ws !== socket) return;
			stopHeartbeat();
			// Invite-only viewer without a valid cookie never gets past the HTTP upgrade (403):
			// the socket closes/errors before any message (policy/tree) ever arrives. Same signal
			// covers an invite revoked mid-session (server closes the *next* connect attempt before
			// sending anything) — per-attempt flag, not the sticky `treeReceived`, so a past
			// successful session doesn't mask this and send us into a reconnect storm. But the same
			// signal is also what a transient network blip (cold start, 503, offline viewer) looks
			// like — so before giving up permanently, probe reachability with a plain HTTP request
			// the WS handshake doesn't gate on cookies.
			if (shouldMarkInviteInvalid({ gotMessageThisAttempt, projectDeleted })) {
				void probeThenDecide();
				return;
			}
			if (projectDeleted) return;
			scheduleReconnect();
		});
		socket.addEventListener('error', () => socket.close());
	}

	function startHeartbeat(socket: WebSocket): void {
		stopHeartbeat();
		heartbeatTimer = setInterval(() => {
			socket.send(PING);
			// No pong in time: the link is dead even though the socket still says OPEN.
			pongTimer ??= setTimeout(() => abandon(socket), HEARTBEAT_TIMEOUT_MS);
		}, HEARTBEAT_INTERVAL_MS);
	}

	/** Give up on a socket without waiting for its close event — on a dead network the browser
	 * may take minutes to fire it. */
	function abandon(socket: WebSocket): void {
		ws = null;
		stopHeartbeat();
		socket.close();
		scheduleReconnect();
	}

	function stopHeartbeat(): void {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (pongTimer) clearTimeout(pongTimer);
		heartbeatTimer = null;
		pongTimer = null;
	}

	// Back online: retry now instead of sitting out the remaining backoff.
	function onOnline(): void {
		if (closed || !reconnectTimer) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
		attempt = 0;
		connect();
	}

	function scheduleReconnect(): void {
		status = 'reconnecting';
		const backoff = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
		attempt++;
		// Full-jitter backoff, no separate jitter config knob — good enough for a
		// handful of viewer tabs reconnecting to one DO.
		reconnectTimer = setTimeout(
			() => {
				reconnectTimer = null;
				connect();
			},
			backoff / 2 + Math.random() * (backoff / 2)
		);
	}

	function open(path: string): void {
		openPath = path;
		deleted = false;
		file = null;
		send({ type: 'subscribe', path });
	}

	function close(): void {
		closed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		stopHeartbeat();
		removeEventListener('online', onOnline);
		ws?.close();
		ws = null;
	}

	addEventListener('online', onOnline);
	connect();

	return {
		get status() {
			return status;
		},
		get paths() {
			return paths;
		},
		get treeReceived() {
			return treeReceived;
		},
		get openPath() {
			return openPath;
		},
		get file() {
			return file;
		},
		get deleted() {
			return deleted;
		},
		get policy() {
			return policy;
		},
		get projectDeleted() {
			return projectDeleted;
		},
		get inviteInvalid() {
			return inviteInvalid;
		},
		open,
		close
	};
}
