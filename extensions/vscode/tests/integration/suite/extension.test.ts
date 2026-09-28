// Real-editor integration suite: activates the actual extension inside a live VS Code
// extension host and drives it through vscode.commands.executeCommand, exactly like a user
// would — as opposed to tests/core.test.ts, which only exercises the pure logic in src/core.ts.
// Requires the local sourcebeam preview server on ws://localhost:4173 (see runner.ts).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "krowten.sourcebeam-vscode";
const SERVER_URL = "ws://localhost:4173";
const REQUIRED_COMMANDS = [
	"sourcebeam.start",
	"sourcebeam.stop",
	"sourcebeam.setToken",
	"sourcebeam.copyInvite",
	"sourcebeam.revokeInvites",
	"sourcebeam.deleteProject",
	"sourcebeam.pickProject",
	"sourcebeam.pickServer",
	"sourcebeam.moreActions",
];

type ServerMsg = { type: string; [key: string]: unknown };

/** `messages.find(...)` only narrows on `type`, not on the rest of the shape (ServerMsg's other
 * fields are `unknown`) — this centralizes the one "trust the wire protocol" cast instead of
 * scattering `as {...}` casts (which TS rejects anyway: an index-signature type and a concrete
 * shape like `{ paths: string[] }` don't "sufficiently overlap" for a direct assertion). */
function expectMessage<T extends ServerMsg>(messages: ServerMsg[], match: (m: ServerMsg) => boolean): T {
	const msg = messages.find(match);
	if (!msg) throw new Error(`expected a matching message among ${messages.length} received, found none`);
	return msg as unknown as T;
}

function uniqueProjectId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string, intervalMs = 200): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(intervalMs);
	}
	if (!predicate()) throw new Error(`timed out waiting for: ${message}`);
}

type StubbableMethod = "showErrorMessage" | "showInformationMessage" | "showWarningMessage" | "showInputBox";

/** Manually swaps a vscode.window.* method for the duration of a test — there's no sinon here,
 * and the extension host's `vscode.window` namespace is a plain mutable object at runtime, so
 * direct assignment works. Always restore() in a `finally`. */
function stub(method: StubbableMethod, impl: (...args: unknown[]) => unknown): { calls: unknown[][]; restore: () => void } {
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

async function setConfig(project: string): Promise<void> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	// Application-scoped: VS Code only accepts it in User settings (Global), not Workspace.
	await cfg.update("serverUrl", SERVER_URL, vscode.ConfigurationTarget.Global);
	await cfg.update("project", project, vscode.ConfigurationTarget.Workspace);
}

async function clearConfig(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	await cfg.update("serverUrl", "", vscode.ConfigurationTarget.Global);
	await cfg.update("project", "", vscode.ConfigurationTarget.Workspace);
}

/** Waits until sourcebeam.copyInvite actually mints and copies a link. start()'s broadcast
 * loop is fire-and-forget (the registered command handler discards startBroadcasting()'s
 * promise), so `executeCommand("sourcebeam.start")` resolves long before the connection is
 * live — poll copyInvite itself instead of any exposed extension state (there is none). */
async function waitForInviteUrl(project: string, timeoutMs = 15_000): Promise<string> {
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
async function exchangeInviteForCookie(inviteUrl: string): Promise<string> {
	const res = await fetch(inviteUrl, { redirect: "manual" });
	const setCookie = res.headers.get("set-cookie");
	if (!setCookie) throw new Error(`invite exchange did not set a cookie (status ${res.status})`);
	return setCookie.split(";")[0]!;
}

/** Connects a viewer WS and waits for a `tree` message that includes `expectPaths`. mint_invite
 * and the host's snapshot both ride the same open connection with no ordering guarantee
 * between them, so a viewer connecting right after the invite link works can still see a
 * `tree` from before the snapshot lands — retry the connection instead of trusting the first one. */
async function connectViewerWithTree(
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

suite("sourcebeam extension (integration)", function () {
	this.timeout(120_000);

	suiteSetup(async () => {
		await clearConfig();
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand("sourcebeam.stop");
		await clearConfig();
	});

	test("activation: extension is found and activate() does not throw", async () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `extension ${EXTENSION_ID} not found`);
		await ext!.activate();
		assert.equal(ext!.isActive, true);
	});

	test("commands: all sourcebeam commands are registered", async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of REQUIRED_COMMANDS) {
			assert.ok(commands.includes(id), `missing command: ${id}`);
		}
	});

	test("config validation: start without serverUrl/project shows an error and does not broadcast", async () => {
		await clearConfig();
		const errors = stub("showErrorMessage", () => undefined);
		try {
			await vscode.commands.executeCommand("sourcebeam.start");
			await waitFor(() => errors.calls.length > 0, 5000, "showErrorMessage call");
			const [message] = errors.calls[0]!;
			assert.equal(message, "Sourcebeam: Set sourcebeam.serverUrl and sourcebeam.project in your settings.");
		} finally {
			errors.restore();
		}
	});

	test("full broadcast cycle: token, start, invite, snapshot, live update, stop", async () => {
		const project = uniqueProjectId("full");
		await setConfig(project);

		const infos = stub("showInformationMessage", () => undefined);
		const inputs = stub("showInputBox", async () => "dev-host");
		try {
			await vscode.commands.executeCommand("sourcebeam.setToken");
			await waitFor(
				() => infos.calls.some((c) => String((c as unknown[])[0]).includes("token saved")),
				5000,
				"token saved confirmation",
			);
		} finally {
			inputs.restore();
			infos.restore();
		}

		await vscode.commands.executeCommand("sourcebeam.start");

		const inviteUrl = await waitForInviteUrl(project);
		const cookie = await exchangeInviteForCookie(inviteUrl);

		const { ws, messages } = await connectViewerWithTree(project, cookie, ["src/main.py", "README.md", ".prettierrc"]);
		try {
			const tree = expectMessage<{ type: "tree"; paths: string[] }>(messages, (m) => m.type === "tree");
			assert.ok(tree.paths.includes("src/main.py"), "src/main.py should be in the tree");
			assert.ok(tree.paths.includes("README.md"), "README.md should be in the tree");
			assert.ok(tree.paths.includes(".prettierrc"), ".prettierrc (no extension) should be in the tree");
			assert.ok(!tree.paths.includes("node_modules/junk.js"), "node_modules/junk.js must not sync");
			assert.ok(!tree.paths.includes(".env"), ".env is in .gitignore and must not sync");

			ws.send(JSON.stringify({ type: "subscribe", path: "src/main.py" }));
			await waitFor(() => messages.some((m) => m.type === "file" && m.path === "src/main.py"), 5000, "initial file content");
			const initial = expectMessage<{ type: "file"; path: string; content: string }>(
				messages,
				(m) => m.type === "file" && m.path === "src/main.py",
			);
			assert.equal(initial.content, "print('hello, sourcebeam')\n");

			// Live cycle proof: edit the file on disk and expect the same subscription to push
			// the new content, instead of only checking the one-shot snapshot.
			const folder = vscode.workspace.workspaceFolders![0]!;
			const fileUri = vscode.Uri.joinPath(folder.uri, "src", "main.py");
			const updatedContent = "print('hello, sourcebeam')\nprint('updated')\n";
			await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(updatedContent));

			await waitFor(
				() => messages.some((m) => m.type === "file" && m.path === "src/main.py" && m.content === updatedContent),
				10_000,
				"live-updated file content",
			);

			await vscode.commands.executeCommand("sourcebeam.stop");
			const countAfterStop = messages.length;
			await sleep(2000);
			assert.equal(messages.length, countAfterStop, "no messages should arrive on the viewer after stop()");
		} finally {
			ws.close();
		}
	});

	test("delete project: connected viewer receives project_deleted", async () => {
		const project = uniqueProjectId("del");
		await setConfig(project);

		await vscode.commands.executeCommand("sourcebeam.start");
		const inviteUrl = await waitForInviteUrl(project);
		const cookie = await exchangeInviteForCookie(inviteUrl);
		const { ws, messages } = await connectViewerWithTree(project, cookie, []);

		const warnings = stub("showWarningMessage", async () => "Delete");
		try {
			await vscode.commands.executeCommand("sourcebeam.deleteProject");
			await waitFor(() => messages.some((m) => m.type === "project_deleted"), 10_000, "project_deleted message");
		} finally {
			warnings.restore();
			ws.close();
		}
	});
});
