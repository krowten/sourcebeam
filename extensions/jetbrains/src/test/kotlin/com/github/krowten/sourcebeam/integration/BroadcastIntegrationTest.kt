package com.github.krowten.sourcebeam.integration

import com.github.krowten.sourcebeam.BroadcastStatus
import com.github.krowten.sourcebeam.SourcebeamAppSettings
import com.github.krowten.sourcebeam.WsConnection
import com.github.krowten.sourcebeam.stringList
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.runWriteAction
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlin.io.path.writeText

/**
 * The plugin against a real server, the JetBrains side of extensions/vscode/tests/integration:
 * the same scenarios under the same names, so both hosts are held to one behaviour. Runs a
 * headless IDE with a real project directory and a real VFS; needs the local preview server on
 * :4173 (`bun run --cwd apps/web preview`), which is why it only runs under
 * `./gradlew test -Pintegration`.
 */
class BroadcastIntegrationTest : IntegrationTestBase() {

	// --- scenarios: keep in step with extensions/vscode/tests/integration ---

	fun `test actions - every Sourcebeam action is registered`() {
		val actions = ActionManager.getInstance()
		for (id in listOf("Start", "Stop", "CopyInvite", "RevokeInvites", "OpenSettings", "SetToken", "DeleteProject")) {
			assertNotNull("missing action Sourcebeam.$id", actions.getAction("Sourcebeam.$id"))
		}
	}

	fun `test config validation - start without a server URL shows an error and does not broadcast`() {
		SourcebeamAppSettings.getInstance().serverUrl = ""
		service.start()
		waitUntil("the configuration error") { notified("Set the server URL and project id") }
		settle(300)
		assertFalse(service.isRunning)
	}

	fun `test full broadcast cycle - snapshot, live update, stop`() {
		val viewer = liveViewer("src/main.py", "README.md", ".prettierrc")
		val tree = viewer.firstTree()!!
		assertFalse("node_modules must not sync", tree.any { it.startsWith("node_modules/") })
		assertFalse(".env is in .gitignore and must not sync", ".env" in tree)
		assertFalse("nothing under .git/ is ever sent", tree.any { it.startsWith(".git/") })
		assertFalse("binary files are skipped", "image.bin" in tree)
		assertFalse("files over the size cap are skipped", "big.txt" in tree)

		viewer.subscribe("src/main.py")
		waitUntil("initial file content") {
			viewer.messages.any { it["type"] == "file" && it["path"] == "src/main.py" && it["content"] == "print('hello, sourcebeam')\n" }
		}
		val updated = "print('hello, sourcebeam')\nprint('updated')\n"
		vfsWrite("src/main.py", updated)
		waitUntil("live-updated file content") {
			viewer.messages.any { it["type"] == "file" && it["path"] == "src/main.py" && it["content"] == updated }
		}

		service.stop()
		val countAfterStop = viewer.messages.size
		vfsWrite("src/main.py", "print('after stop')\n")
		settle(2000)
		assertEquals("no messages should arrive on the viewer after stop()", countAfterStop, viewer.messages.size)
	}

	fun `test gitignore edited mid-broadcast - newly ignored files leave the server, un-ignored ones return`() {
		write("notes/secret.txt", "api key\n")
		refresh()
		val viewer = liveViewer("notes/secret.txt")
		val trees = { from: Int -> viewer.messages.drop(from).filter { it["type"] == "tree" }.map { it.stringList("paths") } }

		val seen = viewer.messages.size
		vfsWrite(".gitignore", "node_modules/\n.env\nnotes/\n")
		waitUntil("a tree without notes/secret.txt after the .gitignore edit") { trees(seen).any { "notes/secret.txt" !in it } }

		val restored = viewer.messages.size
		vfsWrite(".gitignore", "node_modules/\n.env\n")
		waitUntil("a tree with notes/secret.txt again once .gitignore no longer excludes it") {
			trees(restored).any { "notes/secret.txt" in it }
		}
	}

	fun `test single file - create, rename, move and delete reach the viewer`() {
		val viewer = liveViewer("README.md")
		vfsWrite("fresh.txt", "new\n")
		waitUntil("tree_update adding a newly created file") { "fresh.txt" in viewer.added() }

		runWriteAction { vfile("fresh.txt").rename(this, "renamed.txt") }
		waitUntil("tree_update renaming fresh.txt to renamed.txt") { "fresh.txt" in viewer.removed() && "renamed.txt" in viewer.added() }

		runWriteAction { vfile("renamed.txt").move(this, vdir("moved")) }
		waitUntil("tree_update moving renamed.txt into moved/") { "renamed.txt" in viewer.removed() && "moved/renamed.txt" in viewer.added() }

		runWriteAction { vfile("moved/renamed.txt").delete(this) }
		waitUntil("tree_update removing a deleted file") { "moved/renamed.txt" in viewer.removed() }
	}

	// The VFS reports a deleted or renamed directory as one event for the directory itself, never
	// for the files inside it — they have to be fanned out explicitly.
	fun `test directory delete and rename - files under it follow on the server`() {
		write("gone/a.txt", "a\n")
		write("gone/deep/b.txt", "b\n")
		write("old/c.txt", "c\n")
		refresh()
		val viewer = liveViewer("gone/a.txt", "gone/deep/b.txt", "old/c.txt")

		runWriteAction { vfile("gone").delete(this) }
		waitUntil("tree_update removing every file under the deleted directory") {
			viewer.removed().containsAll(listOf("gone/a.txt", "gone/deep/b.txt"))
		}

		runWriteAction { vfile("old").rename(this, "new") }
		waitUntil("tree_update moving old/c.txt to new/c.txt") { "old/c.txt" in viewer.removed() && "new/c.txt" in viewer.added() }
	}

	// A terminal `rm -rf` or a git checkout changes the disk behind the IDE's
	// back, and the change arrives through a VFS refresh instead of a VFS operation.
	fun `test directory deleted outside the editor - files under it leave the server`() {
		write("scratch/a.txt", "a\n")
		write("scratch/deep/b.txt", "b\n")
		refresh()
		val viewer = liveViewer("scratch/a.txt", "scratch/deep/b.txt")

		root.resolve("scratch").toFile().deleteRecursively()
		refresh()
		waitUntil("tree_update removing every file under the externally deleted directory") {
			viewer.removed().containsAll(listOf("scratch/a.txt", "scratch/deep/b.txt"))
		}
	}

	// A symlink committed by accident (`notes -> ~/.ssh`) must not leak what it points at — neither
	// when it's there from the start nor when it appears mid-broadcast.
	fun `test symlinks pointing outside the workspace are never sent`() {
		val outside = Files.createTempDirectory("sourcebeam-outside-")
		try {
			outside.resolve("secret.txt").writeText("outside the workspace\n")
			Files.createSymbolicLink(root.resolve("link-file.txt"), outside.resolve("secret.txt"))
			Files.createSymbolicLink(root.resolve("link-dir"), outside)
			refresh()
			val leaked = { paths: List<String> -> paths.filter { it.startsWith("link-") || it.startsWith("live-link-") } }

			val viewer = liveViewer("README.md")
			assertEquals("the snapshot must skip symlinked files and directories", emptyList<String>(), leaked(viewer.firstTree()!!))

			Files.createSymbolicLink(root.resolve("live-link-file.txt"), outside.resolve("secret.txt"))
			Files.createSymbolicLink(root.resolve("live-link-dir"), outside)
			refresh()
			afterSentinel(viewer, "after-links.txt")
			assertEquals("symlinks created mid-broadcast must not be sent", emptyList<String>(), leaked(viewer.added()))
		} finally {
			outside.toFile().deleteRecursively()
		}
	}

	fun `test ignored paths stay off the server when created mid-broadcast`() {
		val viewer = liveViewer("README.md")
		vfsWrite("node_modules/live.js", "ignored by .gitignore\n")
		vfsWrite(".env", "SECRET=still-nope\n")
		vfsWrite(".git/live-ref", "never sent\n")
		afterSentinel(viewer, "after-ignored.txt")
		val leaked = viewer.added().filter { it.startsWith("node_modules/") || it == ".env" || it.startsWith(".git/") }
		assertEquals("ignored paths must not be sent", emptyList<String>(), leaked)
	}

	fun `test a file that turns binary or outgrows the size cap leaves the server, and returns as text`() {
		val viewer = liveViewer("README.md")
		val count = { list: List<String> -> list.count { it == "shape.txt" } }
		vfsWrite("shape.txt", "text\n")
		waitUntil("shape.txt added as text") { count(viewer.added()) == 1 }

		vfsWriteBytes("shape.txt", byteArrayOf(0x00, 0x01, 0x02, 0xff.toByte()))
		waitUntil("shape.txt removed once it is binary") { count(viewer.removed()) == 1 }

		vfsWrite("shape.txt", "text again\n")
		waitUntil("shape.txt back once it is text again") { count(viewer.added()) == 2 }

		vfsWrite("shape.txt", "x".repeat(600 * 1024))
		waitUntil("shape.txt removed once it outgrows the cap") { count(viewer.removed()) == 2 }
	}

	fun `test revoke invites - connected viewers are disconnected`() {
		val viewer = liveViewer("README.md")
		service.revokeInvites()
		// The 4001 frame arrives at once; the close event itself can lag by the client's closing
		// handshake timeout under wrangler dev.
		assertEquals("the viewer is closed with 4001", 4001, viewer.closeCode.get(20, TimeUnit.SECONDS))
	}

	fun `test another host taking the project over stops this one`() {
		liveViewer("README.md")
		val rival = WsConnection.connect("$SERVER_URL/ws/$projectId", "dev-host")
		try {
			waitUntil("the takeover warning") { notified("Another host connected") }
			waitUntil("broadcasting to stop") { !service.isRunning && service.status == BroadcastStatus.OFF }
		} finally {
			rival.close()
		}
	}

	fun `test a project with more broadcastable files than the cap refuses to start`() {
		for (i in 0..500) write("many/f-$i.txt", "$i\n")
		refresh()
		service.start()
		waitUntil("the too-many-files error", 15_000) { notified("more than 500 broadcastable files") }
		waitUntil("broadcasting to stop") { service.status == BroadcastStatus.OFF }
	}

	fun `test delete project - connected viewer receives project_deleted`() {
		val viewer = liveViewer()
		service.deleteProject()
		waitUntil("project_deleted message") { viewer.messages.any { it["type"] == "project_deleted" } }
	}
}
