package com.github.krowten.sourcebeam.integration

import com.github.krowten.sourcebeam.BroadcastStatus
import com.github.krowten.sourcebeam.HostToken
import com.github.krowten.sourcebeam.SourcebeamAppSettings
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.testFramework.TestActionEvent
import com.sun.net.httpserver.HttpServer
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * A broadcast that cannot connect must not pretend to be running: a failed first connect stops it
 * with an error that says what is wrong, and Copy Invite stays unavailable until the connection is
 * live instead of copying something else. The VS Code counterpart is
 * extensions/vscode/tests/integration/suite/connect.test.ts; scenario names match.
 */
class ConnectErrorIntegrationTest : IntegrationTestBase() {

	private fun useServer(url: String) {
		SourcebeamAppSettings.getInstance().serverUrl = url
		// The token is stored per server origin.
		HostToken.set(url, "dev-host")
	}

	private fun copyInvite() {
		val action = ActionManager.getInstance().getAction("Sourcebeam.CopyInvite")
		action.actionPerformed(TestActionEvent.createTestEvent(action, SimpleDataContext.getProjectContext(project)))
	}

	private fun copyInviteEnabled(): Boolean {
		val action = ActionManager.getInstance().getAction("Sourcebeam.CopyInvite")
		val e = TestActionEvent.createTestEvent(action, SimpleDataContext.getProjectContext(project))
		action.update(e)
		return e.presentation.isEnabled
	}

	private fun clipboardText(): String? = CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor)

	/** Starts, waits for the error naming `expected`, then checks the broadcast really stopped. */
	private fun expectStartToFail(expected: String) {
		CopyPasteManager.getInstance().setContents(StringSelection("untouched"))
		service.start()
		waitUntil("an error mentioning \"$expected\"", 15_000) { notified(expected) }
		waitUntil("broadcasting to stop") { !service.isRunning && service.status == BroadcastStatus.OFF }
		assertFalse(copyInviteEnabled())
		copyInvite()
		waitUntil("the copy invite notice") { notifications.any { it.content == "Start broadcasting first." } }
		assertEquals("untouched", clipboardText())
	}

	// --- scenarios: keep in step with extensions/vscode/tests/integration/suite/connect.test.ts ---

	fun `test connect error - an unreachable server stops the broadcast with an error naming it`() {
		val port = ServerSocket(0).use { it.localPort }
		val url = "ws://127.0.0.1:$port"
		useServer(url)
		expectStartToFail("Can't connect to $url")
	}

	fun `test connect error - a server that is not Sourcebeam (HTTP 404) stops the broadcast`() {
		val notFound = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
		notFound.createContext("/") { it.sendResponseHeaders(404, -1); it.close() }
		notFound.start()
		try {
			useServer("ws://127.0.0.1:${notFound.address.port}")
			expectStartToFail("HTTP 404")
		} finally {
			notFound.stop(0)
		}
	}

	fun `test connect error - while still connecting, Copy Invite says so and copies nothing`() {
		TestProxy().use { proxy ->
			useServer(proxy.url)
			proxy.hold()
			CopyPasteManager.getInstance().setContents(StringSelection("untouched"))
			service.start()
			waitUntil("the connect attempt") { proxy.attempts > 0 }
			assertTrue(service.isRunning)
			assertFalse("Copy Invite is disabled until the connection is live", copyInviteEnabled())
			copyInvite()
			waitUntil("the copy invite notice") { notified("Not connected to the server yet") }
			assertEquals("untouched", clipboardText())
			service.stop()
			proxy.release()
		}
	}
}
