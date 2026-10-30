// Real-editor integration suite: activates the actual extension inside a live VS Code
// extension host and drives it through vscode.commands.executeCommand, exactly like a user
// would — as opposed to tests/core.test.ts, which only exercises the pure logic in src/core.ts.
// Requires the local sourcebeam preview server on ws://localhost:4173 (see runner.ts).
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import {
	afterSentinel,
	clearConfig,
	connectViewerWithTree,
	exchangeInviteForCookie,
	expectMessage,
	removeQuietly,
	setConfig,
	sleep,
	stub,
	uniqueProjectId,
	waitFor,
	waitForInviteUrl,
	withLiveViewer,
	workspaceUri,
	writeText,
} from "./helpers";

const EXTENSION_ID = "krowten.sourcebeam-vscode";
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
			assert.ok(!tree.paths.some((p) => p.startsWith(".git/")), "nothing under .git/ is ever sent");
			assert.ok(!tree.paths.includes("image.bin"), "binary files are skipped");
			assert.ok(!tree.paths.includes("big.txt"), "files over the size cap are skipped");

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
			await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode("print('after stop')\n"));
			await sleep(2000);
			assert.equal(messages.length, countAfterStop, "no messages should arrive on the viewer after stop()");
		} finally {
			ws.close();
		}
	});

	test(".gitignore edited mid-broadcast: newly ignored files leave the server, un-ignored ones return", async () => {
		const project = uniqueProjectId("ign");
		await setConfig(project);
		const folder = vscode.workspace.workspaceFolders![0]!;
		const secret = vscode.Uri.joinPath(folder.uri, "notes", "secret.txt");
		const gitignore = vscode.Uri.joinPath(folder.uri, ".gitignore");
		const originalIgnore = await vscode.workspace.fs.readFile(gitignore);
		await vscode.workspace.fs.writeFile(secret, new TextEncoder().encode("api key\n"));

		await vscode.commands.executeCommand("sourcebeam.start");
		try {
			const cookie = await exchangeInviteForCookie(await waitForInviteUrl(project));
			const { ws, messages } = await connectViewerWithTree(project, cookie, ["notes/secret.txt"]);
			try {
				const seen = messages.length;
				await vscode.workspace.fs.writeFile(
					gitignore,
					new TextEncoder().encode(`${new TextDecoder().decode(originalIgnore)}notes/\n`),
				);
				// The re-snapshot ends with a fresh full `tree` for viewers; the secret must be gone.
				await waitFor(
					() =>
						messages
							.slice(seen)
							.some((m) => m.type === "tree" && !(m.paths as string[]).includes("notes/secret.txt")),
					10_000,
					"a tree without notes/secret.txt after the .gitignore edit",
				);
				// ...and the way back: a file the rules stop excluding is sent again.
				const restored = messages.length;
				await vscode.workspace.fs.writeFile(gitignore, originalIgnore);
				await waitFor(
					() =>
						messages
							.slice(restored)
							.some((m) => m.type === "tree" && (m.paths as string[]).includes("notes/secret.txt")),
					10_000,
					"a tree with notes/secret.txt again once .gitignore no longer excludes it",
				);
			} finally {
				ws.close();
			}
		} finally {
			await vscode.commands.executeCommand("sourcebeam.stop");
			await vscode.workspace.fs.writeFile(gitignore, originalIgnore);
			await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, "notes"), { recursive: true });
		}
	});

	test("single file: create, rename, move and delete reach the viewer", async () => {
		try {
			await withLiveViewer("file", ["README.md"], async ({ added, removed }) => {
				await writeText("fresh.txt", "new\n");
				await waitFor(() => added().includes("fresh.txt"), 10_000, "tree_update adding a newly created file");

				await vscode.workspace.fs.rename(workspaceUri("fresh.txt"), workspaceUri("renamed.txt"));
				await waitFor(
					() => removed().includes("fresh.txt") && added().includes("renamed.txt"),
					10_000,
					"tree_update renaming fresh.txt to renamed.txt",
				);

				await vscode.workspace.fs.createDirectory(workspaceUri("moved"));
				await vscode.workspace.fs.rename(workspaceUri("renamed.txt"), workspaceUri("moved/renamed.txt"));
				await waitFor(
					() => removed().includes("renamed.txt") && added().includes("moved/renamed.txt"),
					10_000,
					"tree_update moving renamed.txt into moved/",
				);

				await vscode.workspace.fs.delete(workspaceUri("moved/renamed.txt"));
				await waitFor(() => removed().includes("moved/renamed.txt"), 10_000, "tree_update removing a deleted file");
			});
		} finally {
			for (const rel of ["fresh.txt", "renamed.txt", "moved"]) await removeQuietly(rel);
		}
	});

	// The watcher reports a deleted or renamed directory as one event for the directory itself,
	// never for the files inside it — they have to be fanned out explicitly.
	test("directory delete and rename: files under it follow on the server", async () => {
		await writeText("gone/a.txt", "a\n");
		await writeText("gone/deep/b.txt", "b\n");
		await writeText("old/c.txt", "c\n");
		try {
			await withLiveViewer("dir", ["gone/a.txt", "gone/deep/b.txt", "old/c.txt"], async ({ added, removed }) => {
				await vscode.workspace.fs.delete(workspaceUri("gone"), { recursive: true });
				await waitFor(
					() => ["gone/a.txt", "gone/deep/b.txt"].every((p) => removed().includes(p)),
					10_000,
					"tree_update removing every file under the deleted directory",
				);

				await vscode.workspace.fs.rename(workspaceUri("old"), workspaceUri("new"));
				await waitFor(
					() => removed().includes("old/c.txt") && added().includes("new/c.txt"),
					10_000,
					"tree_update moving old/c.txt to new/c.txt",
				);
			});
		} finally {
			for (const rel of ["gone", "old", "new"]) await removeQuietly(rel);
		}
	});

	// A terminal `rm -rf` or a git checkout changes the disk behind the editor's back: the change
	// arrives through the file watcher rather than through the editor's own file operations.
	test("directory deleted outside the editor: files under it leave the server", async () => {
		await writeText("scratch/a.txt", "a\n");
		await writeText("scratch/deep/b.txt", "b\n");
		try {
			await withLiveViewer("ext-del", ["scratch/a.txt", "scratch/deep/b.txt"], async ({ removed }) => {
				rmSync(workspaceUri("scratch").fsPath, { recursive: true, force: true });
				await waitFor(
					() => ["scratch/a.txt", "scratch/deep/b.txt"].every((p) => removed().includes(p)),
					10_000,
					"tree_update removing every file under the externally deleted directory",
				);
			});
		} finally {
			await removeQuietly("scratch");
		}
	});

	// A symlink committed by accident (`notes -> ~/.ssh`) must not leak what it points at — neither
	// when it's there from the start nor when it appears mid-broadcast.
	test("symlinks pointing outside the workspace are never sent", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "sourcebeam-outside-"));
		writeFileSync(path.join(outside, "secret.txt"), "outside the workspace\n");
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-file.txt"));
		symlinkSync(outside, path.join(root, "link-dir"));
		const leaked = (paths: string[]) => paths.filter((p) => p.startsWith("link-") || p.startsWith("live-link-"));
		try {
			await withLiveViewer("link", ["README.md"], async (viewer) => {
				const tree = expectMessage<{ type: "tree"; paths: string[] }>(viewer.messages, (m) => m.type === "tree");
				assert.deepEqual(leaked(tree.paths), [], "the snapshot must skip symlinked files and directories");

				symlinkSync(path.join(outside, "secret.txt"), path.join(root, "live-link-file.txt"));
				symlinkSync(outside, path.join(root, "live-link-dir"));
				await afterSentinel(viewer, "after-links.txt");
				assert.deepEqual(leaked(viewer.added()), [], "symlinks created mid-broadcast must not be sent");
			});
		} finally {
			for (const rel of ["link-file.txt", "link-dir", "live-link-file.txt", "live-link-dir", "after-links.txt"]) {
				rmSync(path.join(root, rel), { force: true });
			}
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("ignored paths stay off the server when created mid-broadcast", async () => {
		try {
			await withLiveViewer("ign-live", ["README.md"], async (viewer) => {
				await writeText("node_modules/live.js", "ignored by .gitignore\n");
				await writeText(".env", "SECRET=still-nope\n");
				await writeText(".git/live-ref", "never sent\n");
				await afterSentinel(viewer, "after-ignored.txt");
				const leaked = viewer.added().filter((p) => p.startsWith("node_modules/") || p === ".env" || p.startsWith(".git/"));
				assert.deepEqual(leaked, [], "ignored paths must not be sent");
			});
		} finally {
			for (const rel of ["node_modules/live.js", ".git/live-ref", "after-ignored.txt"]) await removeQuietly(rel);
			await writeText(".env", "SECRET=nope\n");
		}
	});

	test("a file that turns binary or outgrows the size cap leaves the server, and returns as text", async () => {
		try {
			await withLiveViewer("shape", ["README.md"], async ({ added, removed }) => {
				const count = (list: string[]) => list.filter((p) => p === "shape.txt").length;
				await writeText("shape.txt", "text\n");
				await waitFor(() => count(added()) === 1, 10_000, "shape.txt added as text");

				await vscode.workspace.fs.writeFile(workspaceUri("shape.txt"), new Uint8Array([0x00, 0x01, 0x02, 0xff]));
				await waitFor(() => count(removed()) === 1, 10_000, "shape.txt removed once it is binary");

				await writeText("shape.txt", "text again\n");
				await waitFor(() => count(added()) === 2, 10_000, "shape.txt back once it is text again");

				await writeText("shape.txt", "x".repeat(600 * 1024));
				await waitFor(() => count(removed()) === 2, 10_000, "shape.txt removed once it outgrows the cap");
			});
		} finally {
			await removeQuietly("shape.txt");
		}
	});

	// Slow, and not because of the extension: under wrangler dev the close event takes ~10 s to fire in Node
	// (the client waits out its closing handshake), though the 4001 frame itself arrives at once.
	test("revoke invites: connected viewers are disconnected", async () => {
		const infos = stub("showInformationMessage", () => undefined);
		try {
			await withLiveViewer("revoke", ["README.md"], async ({ ws }) => {
				const closed = new Promise<number>((resolve) => ws.addEventListener("close", (ev) => resolve((ev as CloseEvent).code)));
				await vscode.commands.executeCommand("sourcebeam.revokeInvites");
				assert.equal(await closed, 4001, "the viewer is closed with 4001");
				assert.ok(infos.calls.some((c) => String(c[0]).includes("revoked")), "the host is told the links were revoked");
			});
		} finally {
			infos.restore();
		}
	});

	test("another host taking the project over stops this one", async () => {
		const warnings = stub("showWarningMessage", () => undefined);
		try {
			await withLiveViewer("takeover", ["README.md"], async ({ project }) => {
				const rival = new WebSocket(`ws://localhost:4173/ws/${project}`, { headers: { Authorization: "Bearer dev-host" } });
				try {
					await waitFor(
						() => warnings.calls.some((c) => String(c[0]).includes("another host connected")),
						10_000,
						"the takeover warning",
					);
				} finally {
					rival.close();
				}
			});
		} finally {
			warnings.restore();
		}
	});

	test("a project with more broadcastable files than the cap refuses to start", async () => {
		const project = uniqueProjectId("many");
		await setConfig(project);
		for (let i = 0; i <= 500; i++) await writeText(`many/f-${i}.txt`, `${i}\n`);
		const errors = stub("showErrorMessage", () => undefined);
		try {
			await vscode.commands.executeCommand("sourcebeam.start");
			await waitFor(() => errors.calls.length > 0, 15_000, "the too-many-files error");
			assert.match(String(errors.calls[0]![0]), /more than 500 files/);
		} finally {
			errors.restore();
			await vscode.commands.executeCommand("sourcebeam.stop");
			await removeQuietly("many");
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
