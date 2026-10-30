// The host's connection lost to the network rather than closed by the server: the extension has to
// notice, reconnect on its own and resend a snapshot of the disk as it is by then. The host reaches
// the Worker through a proxy the test can cut (see proxy.ts); viewers connect directly.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

import type { LiveViewer, ServerMsg } from "./helpers";
import type { TestProxy } from "./proxy";

import {
	clearConfig,
	connectViewerWithTree,
	ensureToken,
	exchangeInviteForCookie,
	removeQuietly,
	sleep,
	uniqueProjectId,
	waitFor,
	workspaceUri,
	writeText,
} from "./helpers";
import { startProxy } from "./proxy";

const FULL_TREE = ["src/main.py", "README.md", ".prettierrc"];

suite("sourcebeam reconnect (integration)", function () {
	this.timeout(120_000);
	let proxy: TestProxy;

	suiteSetup(async () => {
		proxy = await startProxy();
		// The host token is stored per server origin, and the host's origin here is the proxy.
		await vscode.workspace.getConfiguration("sourcebeam").update("serverUrl", proxy.url, vscode.ConfigurationTarget.Global);
		await ensureToken();
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand("sourcebeam.stop");
		await clearConfig();
		await proxy.close();
	});

	/** withLiveViewer, with the host going through the proxy. */
	async function withProxiedViewer(prefix: string, expectPaths: string[], body: (viewer: LiveViewer) => Promise<void>): Promise<void> {
		const project = uniqueProjectId(prefix);
		await vscode.workspace.getConfiguration("sourcebeam").update("project", project, vscode.ConfigurationTarget.Workspace);
		await vscode.commands.executeCommand("sourcebeam.start");
		try {
			const { ws, messages } = await connectViewerWithTree(project, await exchangeInviteForCookie(await inviteUrl(project)), expectPaths);
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

	/** waitForInviteUrl for a link built from the proxy's origin; following it goes through the proxy. */
	async function inviteUrl(project: string): Promise<string> {
		await vscode.env.clipboard.writeText("");
		const prefix = `${proxy.url.replace(/^ws/, "http")}/${project}?token=`;
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			await vscode.commands.executeCommand("sourcebeam.copyInvite");
			const text = await vscode.env.clipboard.readText();
			if (text.startsWith(prefix)) return text;
			await sleep(400);
		}
		throw new Error("timed out waiting for sourcebeam.copyInvite to produce an invite link");
	}

	const treesSince = (messages: ServerMsg[], from: number) =>
		messages.slice(from).flatMap((m) => (m.type === "tree" ? [m.paths as string[]] : []));

	test("dropped connection: the host reconnects on its own, each time after the shortest backoff", async () => {
		await withProxiedViewer("drop", FULL_TREE, async ({ messages }) => {
			for (let i = 1; i <= 3; i++) {
				const seen = messages.length;
				const attempts = proxy.attempts();
				const droppedAt = Date.now();
				proxy.drop();
				await waitFor(() => proxy.attempts() > attempts, 10_000, `reconnect attempt #${i}`, 50);
				// RECONNECT_MIN_MS plus its jitter: a backoff that kept growing across connections that
				// had gone live would wait 2 s and then 4 s here.
				const took = Date.now() - droppedAt;
				assert.ok(took < 3000, `reconnect #${i} came after ${took} ms`);
				await waitFor(
					() => treesSince(messages, seen).some((paths) => FULL_TREE.every((p) => paths.includes(p))),
					10_000,
					`the full tree resent after reconnect #${i}`,
				);
			}
		});
	});

	test("changes made while disconnected reach the server after the reconnect", async () => {
		await writeText("offline/edited.txt", "before\n");
		await writeText("offline/deleted.txt", "doomed\n");
		await writeText("offline-dir/a.txt", "a\n");
		await writeText("offline-dir/deep/b.txt", "b\n");
		const fileContent = (messages: ServerMsg[], content: string) =>
			messages.some((m) => m.type === "file" && m.path === "offline/edited.txt" && m.content === content);
		try {
			await withProxiedViewer(
				"offline",
				["offline/edited.txt", "offline/deleted.txt", "offline-dir/a.txt", "offline-dir/deep/b.txt"],
				async ({ ws, messages }) => {
					ws.send(JSON.stringify({ type: "subscribe", path: "offline/edited.txt" }));
					await waitFor(() => fileContent(messages, "before\n"), 5000, "initial file content");

					const seen = messages.length;
					const attempts = proxy.attempts();
					proxy.hold();
					proxy.drop();
					try {
						// The held attempt proves the host saw the drop: from here on it has no connection.
						await waitFor(() => proxy.attempts() > attempts, 10_000, "the host's reconnect attempt", 50);
						await writeText("offline/created.txt", "new\n");
						await writeText("offline/edited.txt", "after\n");
						await vscode.workspace.fs.delete(workspaceUri("offline/deleted.txt"));
						await vscode.workspace.fs.delete(workspaceUri("offline-dir"), { recursive: true });
						// Past the debounce, so the host handles these events while offline instead of
						// sending them on the new connection — only the re-snapshot may carry them.
						await sleep(1000);
					} finally {
						proxy.release();
					}
					await waitFor(() => treesSince(messages, seen).length > 0, 15_000, "the tree from the re-snapshot");
					const tree = treesSince(messages, seen).at(-1)!;
					for (const p of [...FULL_TREE, "offline/created.txt", "offline/edited.txt"]) {
						assert.ok(tree.includes(p), `${p} should be in the tree`);
					}
					for (const p of ["offline/deleted.txt", "offline-dir/a.txt", "offline-dir/deep/b.txt"]) {
						assert.ok(!tree.includes(p), `${p} was deleted offline and must be gone`);
					}
					await waitFor(() => fileContent(messages, "after\n"), 5000, "the subscribed file's offline edit");
				},
			);
		} finally {
			for (const rel of ["offline", "offline-dir"]) await removeQuietly(rel);
		}
	});
});
