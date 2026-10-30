package com.github.krowten.sourcebeam.integration

import com.intellij.ide.trustedProjects.TrustedProjects

/**
 * A project the user hasn't trusted ("Preview in Safe Mode"), the JetBrains side of
 * extensions/vscode/tests/integration/suite/untrusted.test.ts. The plugin deliberately has no trust
 * check — it only reads files through its filters and never runs anything from the project — so
 * it has to broadcast exactly as it does in a trusted one.
 */
class UntrustedProjectIntegrationTest : IntegrationTestBase() {

	override fun setUp() {
		super.setUp()
		// The test framework treats a project with no trust decision as trusted, which is what
		// every other suite runs in; an explicit "not trusted", the decision Safe Mode records,
		// wins over that.
		assertTrue("an undecided test project should start out trusted", TrustedProjects.isProjectTrusted(project))
		TrustedProjects.setProjectTrusted(project, false)
	}

	fun `test untrusted project - snapshot, live update, stop`() {
		assertFalse("the test project should be untrusted", TrustedProjects.isProjectTrusted(project))

		val viewer = liveViewer("src/main.py", "README.md")
		viewer.subscribe("src/main.py")
		waitUntil("initial file content") {
			viewer.messages.any { it["type"] == "file" && it["path"] == "src/main.py" && it["content"] == "print('hello, sourcebeam')\n" }
		}
		val updated = "print('hello, sourcebeam')\nprint('untrusted')\n"
		vfsWrite("src/main.py", updated)
		waitUntil("live-updated file content") {
			viewer.messages.any { it["type"] == "file" && it["path"] == "src/main.py" && it["content"] == updated }
		}

		service.stop()
		val countAfterStop = viewer.messages.size
		vfsWrite("src/main.py", "print('after stop')\n")
		settle(2000)
		assertEquals("no messages should arrive on the viewer after stop()", countAfterStop, viewer.messages.size)
		assertFalse("the project should still be untrusted", TrustedProjects.isProjectTrusted(project))
	}
}
