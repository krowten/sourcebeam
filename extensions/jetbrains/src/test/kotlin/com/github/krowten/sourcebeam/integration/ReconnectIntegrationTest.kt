package com.github.krowten.sourcebeam.integration

import com.github.krowten.sourcebeam.BroadcastStatus
import com.github.krowten.sourcebeam.HostToken
import com.github.krowten.sourcebeam.SourcebeamAppSettings
import com.github.krowten.sourcebeam.stringList
import com.intellij.openapi.application.runWriteAction

/**
 * The host's connection lost to the network rather than closed by the server: the plugin has to
 * notice, reconnect on its own and resend a snapshot of the disk as it is by then. The host
 * reaches the Worker through a [TestProxy] the test can cut; viewers connect directly. The same
 * scenarios as extensions/vscode/tests/integration/suite/reconnect.test.ts.
 */
class ReconnectIntegrationTest : IntegrationTestBase() {

	private lateinit var proxy: TestProxy

	override fun setUp() {
		super.setUp()
		proxy = TestProxy()
		SourcebeamAppSettings.getInstance().serverUrl = proxy.url
		// The host token is stored per server origin, and the host's origin here is the proxy.
		HostToken.set(proxy.url, "dev-host")
	}

	override fun tearDown() {
		try {
			if (::proxy.isInitialized) proxy.close()
		} finally {
			super.tearDown()
		}
	}

	private fun treesSince(viewer: TestViewer, from: Int) =
		viewer.messages.drop(from).filter { it["type"] == "tree" }.map { it.stringList("paths") }

	// --- scenarios: keep in step with extensions/vscode/tests/integration ---

	fun `test dropped connection - the host reconnects on its own, each time after the shortest backoff`() {
		val viewer = liveViewer(*FULL_TREE)
		for (i in 1..3) {
			val seen = viewer.messages.size
			val attempts = proxy.attempts
			val droppedAt = System.currentTimeMillis()
			proxy.drop()
			waitUntil("reconnect attempt #$i") { proxy.attempts > attempts }
			// RECONNECT_MIN_MS plus its jitter: a backoff that kept growing across connections that
			// had gone live would wait 2 s and then 4 s here.
			val took = System.currentTimeMillis() - droppedAt
			assertTrue("reconnect #$i came after $took ms", took < 3_000)
			waitUntil("the full tree resent after reconnect #$i") { treesSince(viewer, seen).any { it.containsAll(FULL_TREE.toList()) } }
			waitUntil("the status back to live") { service.status == BroadcastStatus.LIVE }
		}
	}

	fun `test changes made while disconnected reach the server after the reconnect`() {
		write("offline/edited.txt", "before\n")
		write("offline/deleted.txt", "doomed\n")
		write("offline-dir/a.txt", "a\n")
		write("offline-dir/deep/b.txt", "b\n")
		refresh()
		val viewer = liveViewer("offline/edited.txt", "offline/deleted.txt", "offline-dir/a.txt", "offline-dir/deep/b.txt")
		val fileContent = { content: String ->
			viewer.messages.any { it["type"] == "file" && it["path"] == "offline/edited.txt" && it["content"] == content }
		}
		viewer.subscribe("offline/edited.txt")
		waitUntil("initial file content") { fileContent("before\n") }

		val seen = viewer.messages.size
		val attempts = proxy.attempts
		proxy.hold()
		proxy.drop()
		try {
			// The held attempt proves the host saw the drop: from here on it has no connection.
			waitUntil("the host's reconnect attempt") { proxy.attempts > attempts }
			assertEquals(BroadcastStatus.RECONNECTING, service.status)
			vfsWrite("offline/created.txt", "new\n")
			vfsWrite("offline/edited.txt", "after\n")
			runWriteAction {
				vfile("offline/deleted.txt").delete(this)
				vfile("offline-dir").delete(this)
			}
			// Past the debounce, so the host handles these events while offline instead of sending
			// them on the new connection — only the re-snapshot may carry them.
			settle(1000)
		} finally {
			proxy.release()
		}
		waitUntil("the tree from the re-snapshot", 15_000) { treesSince(viewer, seen).isNotEmpty() }
		val tree = treesSince(viewer, seen).last()
		for (path in listOf(*FULL_TREE, "offline/created.txt", "offline/edited.txt")) {
			assertTrue("$path should be in the tree", path in tree)
		}
		for (path in listOf("offline/deleted.txt", "offline-dir/a.txt", "offline-dir/deep/b.txt")) {
			assertFalse("$path was deleted offline and must be gone", path in tree)
		}
		waitUntil("the subscribed file's offline edit", 5_000) { fileContent("after\n") }
		waitUntil("the status back to live") { service.status == BroadcastStatus.LIVE }
	}

	private companion object {
		val FULL_TREE = arrayOf("src/main.py", "README.md", ".prettierrc")
	}
}
