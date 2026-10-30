package com.github.krowten.sourcebeam.integration

import com.github.krowten.sourcebeam.BroadcastService
import com.github.krowten.sourcebeam.BroadcastStatus
import com.github.krowten.sourcebeam.HostToken
import com.github.krowten.sourcebeam.SourcebeamAppSettings
import com.github.krowten.sourcebeam.SourcebeamSettings
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.application.runWriteAction
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.HeavyPlatformTestCase
import com.intellij.testFramework.PlatformTestUtil
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.io.path.createDirectories
import kotlin.io.path.writeBytes
import kotlin.io.path.writeText

/**
 * Shared setup for the plugin-against-a-real-server suites: a headless IDE with a real project
 * directory (the same fixture as the VS Code suite's runner.ts), the plugin pointed at the local
 * preview Worker on :4173, a recorder for the plugin's notifications, and the helpers the
 * scenarios use to drive files and viewers. Subclasses only add scenarios.
 */
abstract class IntegrationTestBase : HeavyPlatformTestCase() {

	protected lateinit var root: Path
	protected lateinit var projectId: String
	protected val notifications = CopyOnWriteArrayList<Notification>()
	protected val viewers = ArrayList<TestViewer>()

	protected val service get() = BroadcastService.getInstance(project)

	override fun setUp() {
		super.setUp()
		root = Path.of(project.basePath!!)
		writeFixture()
		refresh()

		projectId = "jb-${getTestName(true).take(20).lowercase().replace(Regex("[^a-z0-9]"), "-")}-${System.nanoTime().toString(36)}"
		SourcebeamAppSettings.getInstance().serverUrl = SERVER_URL
		SourcebeamSettings.getInstance(project).projectId = projectId
		HostToken.set(SERVER_URL, "dev-host")

		project.messageBus.connect(testRootDisposable).subscribe(
			Notifications.TOPIC,
			object : Notifications {
				override fun notify(notification: Notification) {
					notifications.add(notification)
				}
			},
		)
	}

	override fun tearDown() {
		try {
			viewers.forEach { it.close() }
			service.stop()
			SourcebeamAppSettings.getInstance().serverUrl = ""
		} catch (e: Throwable) {
			addSuppressedException(e)
		} finally {
			super.tearDown()
		}
	}

	/** Files that should sync next to ones that must not — the same fixture as the VS Code
	 * suite's runner.ts, including an ignored node_modules pushed past MAX_FILES on its own. */
	protected fun writeFixture() {
		write("src/main.py", "print('hello, sourcebeam')\n")
		write("README.md", "# hello\n")
		write("node_modules/junk.js", "console.log('should not sync');\n")
		for (i in 0 until 520) write("node_modules/bloat-$i.js", "// filler\n")
		write(".env", "SECRET=nope\n")
		write(".prettierrc", "{ \"semi\": false }\n")
		write(".gitignore", "node_modules/\n.env\n")
		write(".git/config", "[core]\n")
		root.resolve("image.bin").writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02))
		write("big.txt", "x".repeat(600 * 1024))
	}

	// --- helpers -----------------------------------------------------------

	/** Writes straight to disk, the way a tool outside the IDE would; call [refresh] to let the
	 * VFS (and so the plugin) see it. */
	protected fun write(rel: String, text: String) {
		val file = root.resolve(rel)
		file.parent.createDirectories()
		file.writeText(text)
	}

	protected fun refresh() {
		val dir = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root)!!
		VfsUtil.markDirtyAndRefresh(false, true, true, dir)
	}

	protected fun vfile(rel: String): VirtualFile =
		LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root.resolve(rel)) ?: error("no VFS file for $rel")

	protected fun vdir(rel: String): VirtualFile {
		val base = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root)!!
		return if (rel.isEmpty()) base else VfsUtil.createDirectoryIfMissing(base, rel)!!
	}

	/** Edits through the VFS, the way the IDE itself (editor, Project view, refactorings) does. */
	protected fun vfsWrite(rel: String, text: String) = runWriteAction {
		val parent = vdir(rel.substringBeforeLast('/', ""))
		val name = rel.substringAfterLast('/')
		val file = parent.findChild(name) ?: parent.createChildData(this, name)
		VfsUtil.saveText(file, text)
	}

	protected fun vfsWriteBytes(rel: String, bytes: ByteArray) = runWriteAction { vfile(rel).setBinaryContent(bytes) }

	protected fun waitUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
		val deadline = System.currentTimeMillis() + timeoutMs
		while (!condition()) {
			if (System.currentTimeMillis() > deadline) fail("timed out waiting for: $what")
			PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
			Thread.sleep(50)
		}
	}

	/** Lets queued EDT work and the plugin's background threads run for a while. */
	protected fun settle(ms: Long) {
		val until = System.currentTimeMillis() + ms
		while (System.currentTimeMillis() < until) {
			PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
			Thread.sleep(50)
		}
	}

	protected fun startAndWaitLive() {
		service.start()
		waitUntil("the broadcast to go live", 15_000) { service.status == BroadcastStatus.LIVE }
	}

	/** Mints an invite, follows it and connects a viewer once its tree has [expectPaths]. The
	 * invite and the snapshot share one host connection with no ordering between them, so a viewer
	 * connecting early can see a tree from before the snapshot lands — retry until it doesn't. */
	protected fun connectViewer(vararg expectPaths: String): TestViewer {
		val cookie = TestViewer.cookieFor(service.mintInvite())
		val deadline = System.currentTimeMillis() + 15_000
		while (true) {
			val viewer = TestViewer.connect(projectId, cookie)
			runCatching { waitUntil("tree message", 3_000) { viewer.firstTree() != null } }
			if (viewer.firstTree()?.containsAll(expectPaths.toList()) == true) return viewer.also { viewers.add(it) }
			viewer.close()
			if (System.currentTimeMillis() > deadline) fail("timed out waiting for a tree with ${expectPaths.joinToString()}")
			settle(400)
		}
	}

	protected fun liveViewer(vararg expectPaths: String): TestViewer {
		startAndWaitLive()
		return connectViewer(*expectPaths)
	}

	/** Proves a negative: events are handled in arrival order, so once a file written after `act`
	 * reaches the viewer, whatever `act` did has been through the same path. */
	protected fun afterSentinel(viewer: TestViewer, name: String) {
		vfsWrite(name, "sentinel\n")
		waitUntil("the sentinel $name") { name in viewer.added() }
		settle(1000)
	}

	protected fun notified(fragment: String) = notifications.any { fragment in it.content }
}
