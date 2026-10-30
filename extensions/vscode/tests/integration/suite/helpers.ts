// Shared by every integration test file: settings, the invite-to-viewer handshake, a live viewer
// that records what the server sends it, and the small waits and stubs the scenarios need.
import * as vscode from "vscode";

export const SERVER_URL = "ws://localhost:4173";

export type ServerMsg = { type: string; [key: string]: unknown };

/** `messages.find(...)` only narrows on `type`, not on the rest of the shape (ServerMsg's other
 * fields are `unknown`) — this centralizes the one "trust the wire protocol" cast instead of
 * scattering `as {...}` casts (which TS rejects anyway: an index-signature type and a concrete
 * shape like `{ paths: string[] }` don't "sufficiently overlap" for a direct assertion). */
export function expectMessage<T extends ServerMsg>(messages: ServerMsg[], match: (m: ServerMsg) => boolean): T {
	const msg = messages.find(match);
	if (!msg) throw new Error(`expected a matching message among ${messages.length} received, found none`);
	return msg as unknown as T;
}

export function uniqueProjectId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, message: string, intervalMs = 200): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(intervalMs);
	}
	if (!predicate()) throw new Error(`timed out waiting for: ${message}`);
}

export type StubbableMethod = "showErrorMessage" | "showInformationMessage" | "showWarningMessage" | "showInputBox";

/** Manually swaps a vscode.window.* method for the duration of a test — there's no sinon here,
 * and the extension host's `vscode.window` namespace is a plain mutable object at runtime, so
 * direct assignment works. Always restore() in a `finally`. */
export function stub(method: StubbableMethod, impl: (...args: unknown[]) => unknown): { calls: unknown[][]; restore: () => void } {
	const calls: unknown[][] = [];
	const original = (vscode.window as unknown as Record<string, unknown>)[method];
	(vscode.window as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
		calls.push(args);
		return impl(...args);
	};
	return {
		calls,
		restore: () => {
			(vscode.window as unknown as Record<string, unknown>)[method] = original;
		},
	};
}

export async function setConfig(project: string): Promise<void> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	// Application-scoped: VS Code only accepts it in User settings (Global), not Workspace.
	await cfg.update("serverUrl", SERVER_URL, vscode.ConfigurationTarget.Global);
	await cfg.update("project", project, vscode.ConfigurationTarget.Workspace);
}

export async function clearConfig(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	await cfg.update("serverUrl", "", vscode.ConfigurationTarget.Global);
	await cfg.update("project", "", vscode.ConfigurationTarget.Workspace);
}

/** Waits until sourcebeam.copyInvite actually mints and copies a link. start()'s broadcast
 * loop is fire-and-forget (the registered command handler discards startBroadcasting()'s
 * promise), so `executeCommand("sourcebeam.start")` resolves long before the connection is
 * live — poll copyInvite itself instead of any exposed extension state (there is none). */
export async function waitForInviteUrl(project: string, timeoutMs = 15_000): Promise<string> {
	await vscode.env.clipboard.writeText("");
	const prefix = `http://localhost:4173/${project}?token=`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await vscode.commands.executeCommand("sourcebeam.copyInvite");
		const text = await vscode.env.clipboard.readText();
		if (text.startsWith(prefix)) return text;
		await sleep(400);
	}
	throw new Error("timed out waiting for sourcebeam.copyInvite to produce an invite link");
}

/** Mirrors what a browser does when it follows the invite link: GET it and keep the Set-Cookie
 * the worker/routing.ts token->cookie exchange returns, without ever loading the SvelteKit page. */
export async function exchangeInviteForCookie(inviteUrl: string): Promise<string> {
	const res = await fetch(inviteUrl, { redirect: "manual" });
	const setCookie = res.headers.get("set-cookie");
	if (!setCookie) throw new Error(`invite exchange did not set a cookie (status ${res.status})`);
	return setCookie.split(";")[0]!;
}

/** Connects a viewer WS and waits for a `tree` message that includes `expectPaths`. mint_invite
 * and the host's snapshot both ride the same open connection with no ordering guarantee
 * between them, so a viewer connecting right after the invite link works can still see a
 * `tree` from before the snapshot lands — retry the connection instead of trusting the first one. */
export async function connectViewerWithTree(
	project: string,
	cookie: string,
	expectPaths: string[],
	timeoutMs = 15_000,
): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const ws = new WebSocket(`ws://localhost:4173/ws/${project}`, { headers: { Cookie: cookie } });
		const messages: ServerMsg[] = [];
		ws.addEventListener("message", (ev) => messages.push(JSON.parse(String((ev as MessageEvent).data))));
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("viewer ws failed to connect")), { once: true });
		});
		try {
			await waitFor(() => messages.some((m) => m.type === "tree"), 3000, "tree message", 100);
		} catch {
			// no tree within this attempt's window — fall through and retry below
		}
		const tree = messages.find((m) => m.type === "tree") as { paths?: string[] } | undefined;
		const ok = expectPaths.length === 0 || (tree?.paths && expectPaths.every((p) => tree.paths!.includes(p)));
		if (ok) return { ws, messages };
		ws.close();
		if (Date.now() > deadline) throw new Error(`timed out waiting for tree to include ${expectPaths.join(", ")}`);
		await sleep(400);
	}
}

export function workspaceUri(rel: string): vscode.Uri {
	return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, ...rel.split("/"));
}

export function writeText(rel: string, text: string): Thenable<void> {
	return vscode.workspace.fs.writeFile(workspaceUri(rel), new TextEncoder().encode(text));
}

/** Cleanup for paths a test may or may not have left behind. */
export async function removeQuietly(rel: string): Promise<void> {
	await vscode.workspace.fs.delete(workspaceUri(rel), { recursive: true }).then(
		() => undefined,
		() => undefined,
	);
}

export type LiveViewer = { project: string; ws: WebSocket; messages: ServerMsg[]; added: () => string[]; removed: () => string[] };

/** Proves a negative: events are handled in arrival order, so once a file written after `act`
 * reaches the viewer, whatever `act` did has been through the same path. The pause covers the
 * async reads still in flight for it. */
export async function afterSentinel(viewer: LiveViewer, name: string): Promise<void> {
	await writeText(name, "sentinel\n");
	await waitFor(() => viewer.added().includes(name), 10_000, `the sentinel ${name}`);
	await sleep(1000);
}

/** The shared shape of the live file-event tests: start broadcasting a fresh project, connect a
 * viewer once its tree has `expectPaths`, run `body`, then close the viewer and stop. `added` and
 * `removed` collect every path the viewer's tree_update messages have reported so far. */
export async function withLiveViewer(prefix: string, expectPaths: string[], body: (viewer: LiveViewer) => Promise<void>): Promise<void> {
	const project = uniqueProjectId(prefix);
	await setConfig(project);
	await vscode.commands.executeCommand("sourcebeam.start");
	try {
		const cookie = await exchangeInviteForCookie(await waitForInviteUrl(project));
		const { ws, messages } = await connectViewerWithTree(project, cookie, expectPaths);
		const updates = (key: "added" | "removed") =>
			messages.flatMap((m) => (m.type === "tree_update" ? (m[key] as string[]) : []));
		try {
			await body({ project, ws, messages, added: () => updates("added"), removed: () => updates("removed") });
		} finally {
			ws.close();
		}
	} finally {
		await vscode.commands.executeCommand("sourcebeam.stop");
	}
}

/** Stores the host token the local Worker accepts (`dev-host`, seeded by `bun run preview`) the way
 * a user would, through the Set Host Token command. A file that starts broadcasting calls this in
 * its suiteSetup — the token lives in SecretStorage, so one call covers the rest of the run. */
export async function ensureToken(): Promise<void> {
	const infos = stub("showInformationMessage", () => undefined);
	const inputs = stub("showInputBox", async () => "dev-host");
	try {
		await vscode.commands.executeCommand("sourcebeam.setToken");
		await waitFor(() => infos.calls.some((c) => String(c[0]).includes("token saved")), 5000, "token saved confirmation");
	} finally {
		inputs.restore();
		infos.restore();
	}
}
