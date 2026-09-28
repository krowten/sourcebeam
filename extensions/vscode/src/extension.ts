// VS Code extension: self-contained sourcebeam broadcaster. Uses native vscode APIs for the
// file snapshot (workspace.findFiles + workspace.fs) and change detection (onDidSaveTextDocument
// + FileSystemWatcher) instead of reimplementing a directory scanner / fs.watch loop.
// Wire types and the file policy live in packages/protocol.

import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import * as vscode from "vscode";
import { DEFAULT_POLICY, type FilePolicy, isValidProjectId } from "@sourcebeam/protocol";
import {
	allowedByPolicy,
	buildNestedIgnoreMatcher,
	cancelableSleep,
	type Coalescer,
	DEBOUNCE_MS,
	type Config,
	createCoalescer,
	fatalError,
	hostTokenKey,
	isFatalError,
	MAX_FILES,
	nextReconnectDelay,
	RECONNECT_MIN_MS,
	sanitizeProjectId,
	toHttpUrl,
	validateConfig,
	validateServerUrl,
} from "./core";
import { badgeFor, createSourcebeamTreeDataProvider, type SidebarState } from "./sidebar";
import { renderSettingsHtml, type FromWebviewMessage, type SettingsPanelState } from "./settingsPanel";

type Conn = {
	send(data: string): void;
	onMessage(cb: (data: string) => void): void;
	/** Resolves once, on the next inbound frame — used to read the server's `policy` message,
	 * which always arrives first, without racing the persistent onMessage handler. */
	nextMessage(): Promise<string>;
	onClose(cb: (code: number) => void): void;
	close(): void;
};

// 4000: the server replaced this host with a newer connection (project-room.ts closes the old
// one on every new host upgrade). 4001: the project was deleted or its idle TTL expired.
// Neither is transient — reconnecting would either immediately re-evict whichever host caused
// a 4000 (a ping-pong fight between two IDEs pointed at the same project) or just repeat a
// 4001 against a project that no longer exists.
function isTerminalCloseCode(code: number): boolean {
	return code === 4000 || code === 4001;
}

type Status = "live" | "reconnecting" | "off";

let output: vscode.OutputChannel | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let currentStatus: Status = "off";
/** Set by activate() once the sidebar tree view exists; setStatus() and every command that
 * changes project/running call it so the view never shows stale state. */
let sidebarRefresh: (() => void) | null = null;
let sidebarView: vscode.TreeView<unknown> | null = null;
/** Singleton: "Settings…" reveals the existing panel instead of opening a second one. */
let settingsPanel: vscode.WebviewPanel | null = null;
/** Set by activate() — lets setStatus() (no ExtensionContext of its own) refresh the settings
 * panel's "running" field, e.g. so Revoke/Delete enable the instant broadcasting goes live. */
let extContext: vscode.ExtensionContext | null = null;

let running = false;
let stopping = false;
// Bumped by every startBroadcasting() and by stopBroadcasting() — a fast stop→start no longer
// races two broadcast loops (loop()/runOnce() would each only ever see `stopping` from their own
// short window): the old loop's captured `myGen` goes stale the instant either happens, so it
// stops broadcasting on its very next check regardless of what stopping/running say by then.
let gen = 0;
let activeConn: Conn | null = null;
let activeConfig: Config | null = null;
let activeFolder: vscode.WorkspaceFolder | null = null;
let activePolicy: FilePolicy = DEFAULT_POLICY;
let ignoreMatcher: ((relPath: string) => boolean) | null = null;
let coalescer: Coalescer | null = null;
let snapshotting = false;
let backoffAbort: AbortController | null = null;
let disposables: vscode.Disposable[] = [];
let pendingInvite: { resolve: (msg: { url: string; expiresAt: number }) => void; reject: (err: Error) => void } | null = null;
let pendingOk: { resolve: () => void; reject: (err: Error) => void } | null = null;

/** Rejects whichever of copyInvite/revokeInvites is mid-flight instead of leaving it to time
 * out after 10s — called on stop, on an unexpected disconnect, and on a server `error` frame. */
function rejectPending(reason: string): void {
	pendingInvite?.reject(new Error(reason));
	pendingInvite = null;
	pendingOk?.reject(new Error(reason));
	pendingOk = null;
}

function errDetail(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
	output?.appendLine(`${level} ${message}`);
}

function setStatus(status: Status): void {
	currentStatus = status;
	sidebarRefresh?.();
	if (settingsPanel && extContext) void postSettingsPanelState(extContext);
	if (sidebarView) sidebarView.badge = badgeFor(status);
	if (!statusBar) return;
	switch (status) {
		case "live":
			statusBar.text = "$(broadcast) sourcebeam: live";
			statusBar.tooltip = "Broadcasting — click to stop";
			statusBar.show();
			break;
		case "reconnecting":
			statusBar.text = "$(sync~spin) sourcebeam: reconnecting";
			statusBar.tooltip = "Reconnecting — click to stop";
			statusBar.show();
			break;
		case "off":
			statusBar.hide();
			break;
	}
}

// --- config / ignore, read from settings + SecretStorage + workspace -----

async function readTextIfExists(uri: vscode.Uri): Promise<string | null> {
	try {
		return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return null;
	}
}

/** The effective project id: whatever's configured, or — mirroring the JetBrains plugin's
 * per-project default — a sanitized fallback from the first workspace folder's name if nothing's
 * set. Never writes the fallback back to settings; only pickProject (or hand-editing
 * settings.json) actually persists anything. */
function effectiveProjectId(): string {
	const configured = vscode.workspace.getConfiguration("sourcebeam").get<string>("project")?.trim();
	if (configured) return configured;
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? sanitizeProjectId(folder.name) : "";
}

/** The token for this server's origin — one per origin, shared by every workspace (SecretStorage
 * is global to the VS Code install anyway). Throws on an invalid server, via hostTokenKey. */
async function getHostToken(ctx: vscode.ExtensionContext, server: string): Promise<string> {
	return (await ctx.secrets.get(hostTokenKey(server))) ?? "";
}

async function loadConfig(ctx: vscode.ExtensionContext): Promise<Config> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	const server = cfg.get<string>("serverUrl") ?? "";
	const project = effectiveProjectId();
	// getHostToken validates `server` itself (via hostTokenKey) and throws on anything malformed —
	// swallow that here so an invalid/empty server still gets validateConfig's own, friendlier
	// error below instead of surfacing this lookup's exception first.
	let token = "";
	try {
		token = await getHostToken(ctx, server);
	} catch {
		// fall through with an empty token
	}
	return validateConfig({ server, project, token });
}

/** Reads every .gitignore in the workspace, not just the root one — a nested file (e.g.
 * apps/web/.gitignore) used to be silently ignored, which could let its excluded files ship.
 * `null` exclude bypasses the user's files.exclude setting: it must not hide a real
 * .gitignore from this scan the way it's meant to hide noise from search results. */
async function loadWorkspaceIgnoreMatcher(folder: vscode.WorkspaceFolder): Promise<(relPath: string) => boolean> {
	const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/.gitignore"), null);
	const sources = [];
	for (const uri of uris) {
		const text = await readTextIfExists(uri);
		if (text === null) continue;
		const rel = toRelPosix(uri);
		const dir = rel === ".gitignore" ? "" : rel.slice(0, -"/.gitignore".length);
		sources.push({ dir, text });
	}
	return buildNestedIgnoreMatcher(sources);
}

// --- file I/O -------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** asRelativePath (and Uri.fsPath in general) uses OS separators — normalize to the posix
 * paths the protocol and the ignore-chain both expect, or matching/`file_put.path`/
 * `rel.split("/")` all break on Windows. */
function toRelPosix(uri: vscode.Uri): string {
	return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}

// --- symlink guard ---------------------------------------------------------
// A symlinked file, or a file only reachable through a symlinked ancestor directory, could
// point outside the workspace root — reading it would broadcast content the user never put in
// this project (e.g. a `notes -> ~/.ssh` symlink committed by accident). findFiles() and the
// FileSystemWatcher both follow symlinks transparently, so this has to be checked explicitly
// per file rather than assumed away by the glob.
const symlinkDirCache = new Map<string, boolean>();

function clearSymlinkCache(): void {
	symlinkDirCache.clear();
}

async function isSymlink(uri: vscode.Uri): Promise<boolean> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return (stat.type & vscode.FileType.SymbolicLink) !== 0;
	} catch {
		return false; // gone — the read that follows will fail on its own
	}
}

/** True if `relDir` (posix, relative to `folder`; "" for the workspace root) or any of its
 * ancestors is a symlink. Memoized per directory so a workspace with many files under the same
 * directory doesn't re-stat every ancestor for every file. */
async function hasSymlinkAncestor(folder: vscode.WorkspaceFolder, relDir: string): Promise<boolean> {
	if (relDir === "") return false;
	const cached = symlinkDirCache.get(relDir);
	if (cached !== undefined) return cached;
	const parent = relDir.includes("/") ? relDir.slice(0, relDir.lastIndexOf("/")) : "";
	const result =
		(await hasSymlinkAncestor(folder, parent)) ||
		(await isSymlink(vscode.Uri.joinPath(folder.uri, ...relDir.split("/"))));
	symlinkDirCache.set(relDir, result);
	return result;
}

/** Re-reads one file. null means gone (or unreadable/binary/oversized/policy-rejected/a
 * symlink -> skip, reported to the caller as a delete — same choice the other watchers make). */
async function readFileEntry(
	folder: vscode.WorkspaceFolder,
	uri: vscode.Uri,
	relPath: string,
): Promise<{ content: string; hash: string } | null> {
	if (await isSymlink(uri)) {
		log("WARN", `${relPath}: skipped, symlink`);
		return null;
	}
	const relDir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
	if (await hasSymlinkAncestor(folder, relDir)) {
		log("WARN", `${relPath}: skipped, inside a symlinked directory`);
		return null;
	}
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch {
		return null;
	}
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		log("WARN", `${relPath}: skipped, not valid UTF-8 (binary file)`);
		return null;
	}
	if (!allowedByPolicy(bytes.byteLength, content, activePolicy)) {
		log("WARN", `${relPath}: skipped, over the size cap or not text`);
		return null;
	}
	return { content, hash: sha256Hex(bytes) };
}

/** Full snapshot. findFiles' own exclude only honors `files.exclude`, not .gitignore or our
 * hardcoded blocks — so the MAX_FILES cap has to be checked against the *ignore-filtered* set,
 * not the raw scan. Checking it against the raw scan (as this used to) fails workspaces whose
 * ignored node_modules/build output alone exceeds MAX_FILES, even though nothing broadcastable
 * does. */
async function takeSnapshot(folder: vscode.WorkspaceFolder, ignored: (relPath: string) => boolean, conn: Conn): Promise<void> {
	clearSymlinkCache(); // fresh per full snapshot — symlinks on disk may have changed since the last one
	const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"));
	const included = uris.filter((uri) => !ignored(toRelPosix(uri)));
	if (included.length > MAX_FILES) {
		throw fatalError(`Sourcebeam: project has more than ${MAX_FILES} files — add the extras to .gitignore.`);
	}

	conn.send(JSON.stringify({ type: "snapshot_begin" }));
	let sent = 0;
	let skipped = 0;
	for (const uri of included) {
		const rel = toRelPosix(uri);
		const entry = await readFileEntry(folder, uri, rel);
		if (!entry) {
			skipped++;
			continue;
		}
		conn.send(JSON.stringify({ type: "file_put", path: rel, hash: entry.hash, content: entry.content }));
		sent++;
	}
	conn.send(JSON.stringify({ type: "snapshot_end" }));
	log("INFO", `snapshot: sent ${sent}, skipped ${skipped}`);
}

// --- change detection -------------------------------------------------

function onMutate(uri: vscode.Uri): void {
	if (uri.scheme !== "file" || !activeFolder) return;
	if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== activeFolder.uri.toString()) return;
	const rel = toRelPosix(uri);
	if (ignoreMatcher?.(rel)) return;
	coalescer?.touch(rel);
}

async function onCoalesced(rel: string): Promise<void> {
	// Nothing may hit the wire between snapshot_begin/snapshot_end besides the snapshot's own
	// file_put — defer by re-touching until the in-flight snapshot finishes.
	if (snapshotting) {
		coalescer?.touch(rel);
		return;
	}
	// Capture the connection before the await: stop() (-> null) or a reconnect (-> a new Conn)
	// can both happen while readFileEntry() is in flight. Re-check identity after, and drop the
	// read instead of sending it to a dead/unrelated connection.
	const conn = activeConn;
	if (!conn || !activeFolder) return; // disconnected: next reconnect re-snapshots everything
	const uri = vscode.Uri.joinPath(activeFolder.uri, ...rel.split("/"));
	const entry = await readFileEntry(activeFolder, uri, rel);
	if (conn !== activeConn) return;
	if (!entry) conn.send(JSON.stringify({ type: "file_delete", path: rel }));
	else conn.send(JSON.stringify({ type: "file_put", path: rel, hash: entry.hash, content: entry.content }));
}

function handleIncoming(raw: string): void {
	try {
		const msg = JSON.parse(raw);
		if (!msg || typeof msg !== "object") return;
		switch (msg.type) {
			case "error":
				log("WARN", `server: ${msg.message}`);
				rejectPending(`server returned an error: ${msg.message}`);
				return;
			// project_deleted is a viewer-only message (see project-room.ts) — a host socket
			// gets closed with code 4001 instead. No case here on purpose: never sent to us.
			case "invite":
				pendingInvite?.resolve({ url: msg.url, expiresAt: msg.expiresAt });
				pendingInvite = null;
				return;
			case "ok":
				pendingOk?.resolve();
				pendingOk = null;
				return;
		}
	} catch {
		// ignore malformed frames
	}
}

// --- transport ----------------------------------------------------------
// Bun's / VS Code's embedded Node WebSocket client doesn't surface the HTTP status of a failed
// handshake — probe with a manual upgrade request to tell a fatal 403 apart from a transient
// failure.
function probeHandshakeStatus(url: string, token: string): Promise<number | null> {
	return new Promise((resolve) => {
		const u = new URL(url.replace(/^ws/, "http"));
		const transport = u.protocol === "https:" ? https : http;
		const req = transport.request(
			{
				hostname: u.hostname,
				port: u.port,
				path: u.pathname + u.search,
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				},
				timeout: 5000,
			},
			() => {},
		);
		req.on("response", (res) => {
			resolve(res.statusCode ?? null);
			req.destroy();
		});
		req.on("upgrade", (res) => {
			resolve(res.statusCode ?? 101);
			req.destroy();
		});
		req.on("timeout", () => {
			resolve(null);
			req.destroy();
		});
		req.on("error", () => resolve(null));
		req.end();
	});
}

/** Establishes one WS connection using the global WebSocket (Node 22+, bundled by VS Code
 * ^1.101), passing Authorization the same way the other watchers do. `headers` is an undici
 * extension (not WHATWG-standard) — verified empirically against Node v24.18.0 and v26.5.0 on
 * 2026-07-23 (a Bun.serve echo server logging the Authorization header of each upgrade request,
 * hit by a real system Node client) — see extensions/vscode/README.md for the full writeup. */
function connectWs(url: string, token: string): Promise<Conn> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });

		const cleanup = () => {
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("error", onError);
		};
		const onOpen = () => {
			cleanup();
			resolve({
				send: (data: string) => ws.send(data),
				onMessage: (cb) => ws.addEventListener("message", (ev) => cb(String((ev as MessageEvent).data))),
				nextMessage: () =>
					new Promise((res) => ws.addEventListener("message", (ev) => res(String((ev as MessageEvent).data)), { once: true })),
				onClose: (cb) =>
					ws.addEventListener("close", (ev) => cb((ev as { code: number }).code), { once: true }),
				close: () => {
					try {
						ws.close();
					} catch {
						// already closed
					}
				},
			});
		};
		const onError = async () => {
			cleanup();
			const status = await probeHandshakeStatus(url, token);
			if (status === 403) {
				reject(fatalError("Server rejected the connection: HTTP 403 (invalid host token). Set it via \"Sourcebeam: Set Host Token\" — retrying will not help."));
			} else {
				reject(new Error(`websocket handshake failed${status ? ` (status ${status})` : ""}`));
			}
		};
		ws.addEventListener("open", onOpen, { once: true });
		ws.addEventListener("error", onError, { once: true });
	});
}

/** Reads the server's first message, which is always `policy` (see project-room.ts). Falls back
 * to DEFAULT_POLICY on timeout/malformed frame instead of blocking the broadcast forever. */
async function readPolicy(conn: Conn): Promise<FilePolicy> {
	const abort = new AbortController();
	try {
		const raw = await Promise.race([
			conn.nextMessage(),
			cancelableSleep(5000, abort.signal).then(() => null),
		]);
		abort.abort();
		if (raw === null) {
			log("WARN", "no policy message received within 5s, using default policy");
			return DEFAULT_POLICY;
		}
		const msg = JSON.parse(raw);
		if (msg?.type === "policy") {
			return { maxBytes: msg.maxBytes };
		}
		log("WARN", `expected policy as first message, got ${String(msg?.type)} — using default policy`);
		return DEFAULT_POLICY;
	} catch {
		return DEFAULT_POLICY;
	}
}

// --- reconnect loop -------------------------------------------------------

async function runOnce(cfg: Config, folder: vscode.WorkspaceFolder, myGen: number): Promise<boolean> {
	const url = `${cfg.server.replace(/\/+$/, "")}/ws/${cfg.project}`;
	let conn: Conn;
	try {
		conn = await connectWs(url, cfg.token);
	} catch (err) {
		if (isFatalError(err)) {
			log("ERROR", errDetail(err));
			vscode.window.showErrorMessage("Sourcebeam: server returned 403 — check your host token.");
			setStatus("off");
			return false;
		}
		log("WARN", `connection failed (${errDetail(err)})`);
		return true;
	}

	if (gen !== myGen) {
		// stop() (or a fresh start()) ran while connectWs() was pending — it had nothing of ours
		// to close yet. Close this connection ourselves instead of going live under a stale
		// generation.
		conn.close();
		return false;
	}

	activeConn = conn;
	setStatus("live");
	activePolicy = await readPolicy(conn);

	if (gen !== myGen) {
		// generation moved on while readPolicy() was pending (its 5s wait is the one await here
		// that wasn't already re-checked) — this conn is dead or about to be. Bail before touching
		// module-level state a fresh start()'s runOnce might already own, and before hanging
		// forever on onClose below for a socket whose close already happened.
		conn.close();
		activeConn = null;
		return false;
	}

	conn.onMessage(handleIncoming);

	try {
		snapshotting = true;
		await takeSnapshot(folder, ignoreMatcher ?? (() => false), conn);
	} catch (err) {
		snapshotting = false;
		conn.close();
		// Only clear shared state if we're still the current generation — a stale runOnce whose
		// snapshot failed after a stop→start race must not clobber the new cycle's activeConn.
		if (gen === myGen) {
			activeConn = null;
			rejectPending("connection closed");
		}
		if (isFatalError(err)) {
			vscode.window.showErrorMessage(errDetail(err));
			setStatus("off");
			return false;
		}
		log("WARN", `snapshot failed (${errDetail(err)})`);
		return true;
	}
	snapshotting = false;

	if (gen !== myGen) {
		conn.close();
		activeConn = null;
		return false;
	}

	const closeCode = await new Promise<number>((resolve) => conn.onClose(resolve));
	log("INFO", `disconnected (code ${closeCode})`);
	// Same staleness guard: a stop→start during this wait means a newer cycle already owns
	// activeConn/pending resolvers by the time our onClose finally fires — don't touch them.
	if (gen === myGen) {
		activeConn = null;
		rejectPending("connection closed");
	}
	conn.close();
	if (isTerminalCloseCode(closeCode)) {
		if (gen === myGen) {
			setStatus("off");
			vscode.window.showWarningMessage(
				closeCode === 4000
					? "Sourcebeam: another host connected to this project — broadcasting stopped here."
					: "Sourcebeam: project was deleted or expired — broadcasting stopped.",
			);
		}
		return false;
	}
	return true;
}

async function loop(cfg: Config, folder: vscode.WorkspaceFolder, myGen: number): Promise<void> {
	let delay = RECONNECT_MIN_MS;
	while (gen === myGen) {
		const shouldContinue = await runOnce(cfg, folder, myGen);
		if (!shouldContinue) {
			// gen!==myGen here means runOnce bailed out because it went stale (stop→start),
			// not because it actually finished — the newer cycle owns `running` now, don't touch it.
			if (gen === myGen) running = false;
			return;
		}
		if (gen !== myGen) break;
		setStatus("reconnecting");
		log("INFO", `reconnecting in ${(delay / 1000).toFixed(1)}s`);
		backoffAbort = new AbortController();
		await cancelableSleep(delay + Math.random() * 0.3 * delay, backoffAbort.signal);
		backoffAbort = null;
		delay = nextReconnectDelay(delay);
	}
	// The while condition already re-checks gen === myGen, so reaching here with gen !== myGen
	// means a newer cycle took over — same staleness guard as above, don't clobber its `running`.
	if (gen === myGen) running = false;
}

// --- commands -------------------------------------------------------------

async function startBroadcasting(ctx: vscode.ExtensionContext): Promise<void> {
	if (running) {
		vscode.window.showInformationMessage("Sourcebeam: already running.");
		return;
	}
	// Claim this run's generation synchronously, before any await: any loop()/runOnce() still
	// winding down from a previous start (mid-teardown when stop→start happens fast) captured an
	// older `myGen` and sees `gen !== myGen` on its very next check, so it can never race this run.
	const myGen = ++gen;
	// Claim the slot synchronously, before any await, so a second start() invoked while this
	// one is still awaiting config/ignore-file reads sees running=true and bails instead of
	// setting up a second FileSystemWatcher/coalescer that orphans the first one's timers.
	running = true;
	stopping = false;
	sidebarRefresh?.();

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		running = false;
		sidebarRefresh?.();
		vscode.window.showErrorMessage("Sourcebeam: open a folder/workspace first.");
		return;
	}

	let cfg: Config;
	try {
		cfg = await loadConfig(ctx);
	} catch (err) {
		running = false;
		sidebarRefresh?.();
		vscode.window.showErrorMessage(`Sourcebeam: ${errDetail(err)}`);
		return;
	}
	if (!running) return; // stop() ran while we were reading settings/secrets

	activeFolder = folder;
	activeConfig = cfg;
	ignoreMatcher = await loadWorkspaceIgnoreMatcher(folder);
	if (!running) return; // stop() ran while we were reading .gitignore

	coalescer = createCoalescer(DEBOUNCE_MS, (rel) => void onCoalesced(rel));

	const fsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
	disposables.push(
		fsWatcher,
		fsWatcher.onDidCreate(onMutate),
		fsWatcher.onDidChange(onMutate),
		fsWatcher.onDidDelete(onMutate),
		vscode.workspace.onDidSaveTextDocument((doc) => onMutate(doc.uri)),
	);

	log("INFO", `starting broadcast of ${folder.uri.fsPath} to ${cfg.server}/ws/${cfg.project}`);
	void loop(cfg, folder, myGen);
}

function stopBroadcasting(): void {
	if (stopping) return; // already stopping/stopped — idempotent
	if (!running) {
		setStatus("off");
		return;
	}
	stopping = true;
	running = false;
	// Makes the current generation's loop()/runOnce() see themselves as stale immediately, even
	// if a start() called right after this (before the old loop finished unwinding) claims a new
	// generation of its own via ++gen there.
	++gen;
	backoffAbort?.abort();
	backoffAbort = null;
	coalescer?.cancelAll();
	coalescer = null;
	activeConn?.close();
	activeConn = null;
	rejectPending("broadcast stopped");
	for (const d of disposables.splice(0)) d.dispose();
	activeFolder = null;
	activeConfig = null;
	activePolicy = DEFAULT_POLICY;
	clearSymlinkCache();
	setStatus("off");
}

/** The token is stored per server origin (see hostTokenKey), not as one value shared across
 * every server a workspace happens to point at — a workspace whose committed serverUrl
 * changes (e.g. from cloning someone else's repo) must not have this window's token follow it
 * to a different, unverified origin. */
async function setToken(ctx: vscode.ExtensionContext): Promise<void> {
	const server = vscode.workspace.getConfiguration("sourcebeam").get<string>("serverUrl") ?? "";
	let origin: string;
	try {
		origin = validateServerUrl(server);
	} catch {
		vscode.window.showErrorMessage(
			"Sourcebeam: set a valid sourcebeam.serverUrl first — the token is stored per server.",
		);
		return;
	}
	const token = await vscode.window.showInputBox({ password: true, prompt: `Host token for ${origin}` });
	if (!token) return;

	await ctx.secrets.store(hostTokenKey(server), token);
	sidebarRefresh?.();
	vscode.window.showInformationMessage("Sourcebeam: token saved.");
}

/** project is a Workspace-scope setting (package.json's "scope": "window", written here as
 * Workspace) — that's what lets each open folder keep its own value. Defaults to the workspace
 * folder's name, sanitized, so a fresh folder doesn't force a trip to settings before its first
 * broadcast; still just a suggestion, not written until the user accepts or edits it. */
async function pickProject(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage("Sourcebeam: open a folder/workspace first.");
		return;
	}
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	const value = await vscode.window.showInputBox({
		prompt: "Project id (lowercase letters, digits, hyphens, underscores)",
		value: effectiveProjectId(),
		validateInput: (v) =>
			v === "" || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)
				? null
				: "lowercase letters, digits, hyphens, underscores; can't start with a hyphen or underscore",
	});
	if (value === undefined) return; // cancelled
	await cfg.update("project", value, vscode.ConfigurationTarget.Workspace);
	sidebarRefresh?.();
}

/** Invite link lifetime is per-workspace only, 6 hours unless that workspace sets its own —
 * read from Workspace settings alone, so a value someone put in User settings is ignored rather
 * than quietly applying to every project. Mirrors the JetBrains plugin's per-project field. */
function inviteTtlHours(): number {
	return vscode.workspace.getConfiguration("sourcebeam").inspect<number>("inviteTtlHours")?.workspaceValue ?? 6;
}

/** serverUrl is an Application-scope setting (package.json's "scope": "application"): User
 * settings only, one value for every workspace — one person, one server. VS Code ignores a
 * `sourcebeam.serverUrl` in a workspace's settings.json, so there is nothing to shadow it. */
async function pickServer(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	const value = await vscode.window.showInputBox({
		prompt: "Server URL, e.g. wss://sourcebeam.<sub>.workers.dev",
		value: cfg.get<string>("serverUrl") ?? "",
		validateInput: (v) => {
			if (v === "") return null;
			try {
				validateServerUrl(v);
				return null;
			} catch (err) {
				return errDetail(err);
			}
		},
	});
	if (value === undefined) return;
	// Store the normalized origin, not the raw input — validateInput already rejected
	// anything validateServerUrl itself would throw on, so this only ever strips an
	// incidental trailing slash for an otherwise-valid, non-empty value.
	await cfg.update("serverUrl", value === "" ? value : validateServerUrl(value), vscode.ConfigurationTarget.Global);
	sidebarRefresh?.();
}


/** Everything the webview needs to render — collected fresh on open and after every save, since
 * a save can change whether a field is shadowed, whether a token exists, etc. */
async function buildSettingsPanelState(ctx: vscode.ExtensionContext): Promise<SettingsPanelState> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	const server = cfg.get<string>("serverUrl") ?? "";
	const folder = vscode.workspace.workspaceFolders?.[0];
	let hasToken = false;
	try {
		hasToken = (await getHostToken(ctx, server)).length > 0;
	} catch {
		// invalid/unset server — treat as "no token" rather than failing the whole panel
	}
	return {
		server,
		project: effectiveProjectId(),
		ttl: inviteTtlHours(),
		hasToken,
		workspaceOpen: !!folder,
		workspaceName: folder?.name ?? "",
		running,
	};
}

async function postSettingsPanelState(ctx: vscode.ExtensionContext): Promise<void> {
	if (!settingsPanel) return;
	await settingsPanel.webview.postMessage({ command: "state", state: await buildSettingsPanelState(ctx) });
}

/** Applies one save from the settings panel: server and project validate the same way their
 * standalone InputBox commands do (pickServer/pickProject); ttl gets the same 1-720 range check
 * pickServer's sibling used to. Reports back per-field instead of one all-or-nothing error, since
 * a webview form has room to show that inline. The token is only touched if the field wasn't left
 * blank — the panel never has the current token
 * to compare against (SecretStorage doesn't echo it back), so "unchanged" is the only sane
 * default for an empty field. */
async function saveFromSettingsPanel(ctx: vscode.ExtensionContext, msg: Extract<FromWebviewMessage, { command: "save" }>): Promise<void> {
	if (!settingsPanel) return;
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	let ok = true;

	const server = msg.server.trim();
	if (server !== "") {
		try {
			validateServerUrl(server);
		} catch (err) {
			ok = false;
			await settingsPanel.webview.postMessage({ command: "error", field: "server", message: errDetail(err) });
		}
	}
	const project = msg.project.trim();
	if (project !== "" && !isValidProjectId(project)) {
		ok = false;
		await settingsPanel.webview.postMessage({
			command: "error",
			field: "project",
			message: "Lowercase letters, digits, hyphens, underscores; can't start with a hyphen or underscore.",
		});
	}
	if (!Number.isInteger(msg.ttl) || msg.ttl < 1 || msg.ttl > 24 * 30) {
		ok = false;
		await settingsPanel.webview.postMessage({ command: "error", field: "ttl", message: "Whole number of hours, 1-720." });
	}
	if (msg.token.trim() !== "" && server === "") {
		ok = false;
		await settingsPanel.webview.postMessage({
			command: "error",
			field: "token",
			message: "Set a server URL first — the token is stored per server.",
		});
	}
	if (!ok) return;

	await cfg.update("serverUrl", server === "" ? server : validateServerUrl(server), vscode.ConfigurationTarget.Global);
	if (vscode.workspace.workspaceFolders?.length) await cfg.update("project", project, vscode.ConfigurationTarget.Workspace);
	if (vscode.workspace.workspaceFolders?.length) await cfg.update("inviteTtlHours", msg.ttl, vscode.ConfigurationTarget.Workspace);

	if (msg.token.trim() !== "") {
		await ctx.secrets.store(hostTokenKey(server), msg.token.trim());
	}

	sidebarRefresh?.();
	await postSettingsPanelState(ctx);
	await settingsPanel.webview.postMessage({ command: "saved" });
}

/** The one place all four settings show up together, current values included, instead of
 * scattered across the native Settings UI (serverUrl/project/inviteTtlHours) plus a separate
 * password prompt (the host token, in SecretStorage, doesn't have a native Settings UI entry at
 * all) — a webview form rather than chained QuickPick/InputBox prompts, the closest VS Code gets
 * to the JetBrains plugin's single Settings dialog. Reveals the existing panel if one's already
 * open instead of creating a second. */
async function openSettingsPanel(ctx: vscode.ExtensionContext): Promise<void> {
	if (settingsPanel) {
		settingsPanel.reveal();
		await postSettingsPanelState(ctx);
		return;
	}
	const panel = vscode.window.createWebviewPanel("sourcebeam.settings", "Sourcebeam Settings", vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
	});
	settingsPanel = panel;
	panel.webview.html = renderSettingsHtml(panel.webview);
	panel.onDidDispose(() => {
		settingsPanel = null;
	});
	panel.webview.onDidReceiveMessage(async (msg: FromWebviewMessage) => {
		switch (msg.command) {
			case "save":
				await saveFromSettingsPanel(ctx, msg);
				break;
			case "revoke":
				await revokeInvites();
				break;
			case "delete":
				await deleteProject();
				await postSettingsPanelState(ctx);
				break;
		}
	});
	await postSettingsPanelState(ctx);
}

async function copyInvite(): Promise<void> {
	if (!running || !activeConn || !activeConfig) {
		vscode.window.showInformationMessage("Sourcebeam: start broadcasting first (\"Sourcebeam: Start Broadcasting\").");
		return;
	}
	const conn = activeConn;
	// Keep in sync with the `default` in package.json's contributes.configuration.
	const ttlHours = inviteTtlHours();
	try {
		const invite = await new Promise<{ url: string; expiresAt: number }>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingInvite = null;
				reject(new Error("timeout waiting for invite from server"));
			}, 10_000);
			pendingInvite = {
				resolve: (msg) => {
					clearTimeout(timer);
					resolve(msg);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			};
			conn.send(JSON.stringify({ type: "mint_invite", ttlSeconds: ttlHours * 3600 }));
		});
		const fullUrl = toHttpUrl(activeConfig.server).replace(/\/+$/, "") + invite.url;
		await vscode.env.clipboard.writeText(fullUrl);
		const expires = new Date(invite.expiresAt * 1000).toLocaleString();
		vscode.window.showInformationMessage(`Sourcebeam: link copied to clipboard (valid until ${expires}).`);
	} catch (err) {
		vscode.window.showErrorMessage(`Sourcebeam: failed to get an invite — ${errDetail(err)}`);
	}
}

async function revokeInvites(): Promise<void> {
	if (!running || !activeConn) {
		vscode.window.showInformationMessage("Sourcebeam: start broadcasting first (\"Sourcebeam: Start Broadcasting\").");
		return;
	}
	const conn = activeConn;
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingOk = null;
				reject(new Error("timeout waiting for confirmation from server"));
			}, 10_000);
			pendingOk = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			};
			conn.send(JSON.stringify({ type: "rotate_view_secret" }));
		});
		vscode.window.showInformationMessage("Sourcebeam: old invite links revoked.");
	} catch (err) {
		vscode.window.showErrorMessage(`Sourcebeam: failed to revoke links — ${errDetail(err)}`);
	}
}

async function deleteProject(): Promise<void> {
	if (!running || !activeConn) {
		vscode.window.showInformationMessage("Sourcebeam: start broadcasting first (\"Sourcebeam: Start Broadcasting\").");
		return;
	}
	const confirm = await vscode.window.showWarningMessage(
		"Sourcebeam: delete the project with no way to undo? All viewers will be disconnected.",
		{ modal: true },
		"Delete",
	);
	if (confirm !== "Delete") return;
	activeConn.send(JSON.stringify({ type: "delete_project" }));
	stopBroadcasting();
	vscode.window.showInformationMessage("Sourcebeam: project deleted.");
}

export function activate(context: vscode.ExtensionContext): void {
	extContext = context;
	output = vscode.window.createOutputChannel("sourcebeam");
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = "sourcebeam.toggle";
	setStatus("off");

	context.subscriptions.push(
		output,
		statusBar,
		vscode.commands.registerCommand("sourcebeam.start", () => void startBroadcasting(context)),
		vscode.commands.registerCommand("sourcebeam.stop", stopBroadcasting),
		vscode.commands.registerCommand("sourcebeam.toggle", () => {
			if (running) stopBroadcasting();
			else void startBroadcasting(context);
		}),
		vscode.commands.registerCommand("sourcebeam.setToken", () => void setToken(context)),
		vscode.commands.registerCommand("sourcebeam.copyInvite", () => void copyInvite()),
		vscode.commands.registerCommand("sourcebeam.revokeInvites", () => void revokeInvites()),
		vscode.commands.registerCommand("sourcebeam.deleteProject", () => void deleteProject()),
		vscode.commands.registerCommand("sourcebeam.pickProject", () => void pickProject()),
		vscode.commands.registerCommand("sourcebeam.pickServer", () => void pickServer()),
		vscode.commands.registerCommand("sourcebeam.moreActions", () => void openSettingsPanel(context)),
	);

	const sidebar = createSourcebeamTreeDataProvider(
		(): SidebarState => ({
			status: currentStatus,
			running,
			project: effectiveProjectId(),
		}),
	);
	// Also drives the Start/Stop icon in the view's title bar (package.json's view/title `when`).
	sidebarRefresh = () => {
		sidebar.refresh();
		void vscode.commands.executeCommand("setContext", "sourcebeam.running", running);
	};
	sidebarView = vscode.window.createTreeView("sourcebeam.view", { treeDataProvider: sidebar });
	context.subscriptions.push(
		sidebarView,
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration("sourcebeam")) return;
			sidebarRefresh?.();
			void postSettingsPanelState(context);
		}),
	);
}

export function deactivate(): void {
	stopBroadcasting();
	output = null;
	statusBar = null;
	sidebarRefresh = null;
	sidebarView = null;
	settingsPanel?.dispose();
	settingsPanel = null;
	extContext = null;
}
