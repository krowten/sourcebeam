package com.github.krowten.sourcebeam.integration

import com.github.krowten.sourcebeam.BroadcastStatus
import com.github.krowten.sourcebeam.HostToken
import com.github.krowten.sourcebeam.SourcebeamAppSettings
import com.github.krowten.sourcebeam.SourcebeamConfigurable
import com.github.krowten.sourcebeam.SourcebeamSettings
import com.github.krowten.sourcebeam.SourcebeamStatusBarWidget
import com.github.krowten.sourcebeam.SourcebeamStatusListener
import com.github.krowten.sourcebeam.SourcebeamToolWindowFactory
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.ComponentValidator
import com.intellij.openapi.ui.DialogPanel
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.ui.TestInputDialog
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.RegisterToolWindowTask
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.testFramework.TestActionEvent
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.UIUtil
import java.awt.datatransfer.DataFlavor
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.swing.AbstractButton
import javax.swing.JLabel

/**
 * The UI pieces — settings page, tool window, status bar widget, actions and their dialogs —
 * exercised through the entry points a user triggers, without a UI robot: the settings page is a
 * real component tree that gets edited and applied, actions get a real update() and
 * actionPerformed(), modal dialogs are answered through the platform's test dialog hooks. The
 * VS Code counterpart is extensions/vscode/tests/integration/suite/ui.test.ts; scenario names
 * match where both hosts have the concept.
 */
class UiIntegrationTest : IntegrationTestBase() {

	private companion object {
		const val OTHER_ORIGIN = "ws://127.0.0.1:4173"
	}

	private val shownDialogs = CopyOnWriteArrayList<String>()

	private fun answerDialogs(answer: Int) {
		TestDialogManager.setTestDialog(
			TestDialog { message ->
				shownDialogs.add(message)
				answer
			},
			testRootDisposable,
		)
	}

	private fun answerInputDialogs(input: String?) {
		// Unlike setTestDialog, this setter takes no Disposable — restore the default by hand.
		val previous = TestDialogManager.setTestInputDialog(
			TestInputDialog { message ->
				shownDialogs.add(message)
				input
			},
		)
		Disposer.register(testRootDisposable) { TestDialogManager.setTestInputDialog(previous) }
	}

	private fun action(id: String): AnAction = ActionManager.getInstance().getAction("Sourcebeam.$id")

	private fun event(action: AnAction, withProject: Boolean = true) =
		TestActionEvent.createTestEvent(action, if (withProject) SimpleDataContext.getProjectContext(project) else SimpleDataContext.EMPTY_CONTEXT)

	private fun enabled(id: String, withProject: Boolean = true): Boolean {
		val e = event(action(id), withProject)
		action(id).update(e)
		return e.presentation.isEnabled
	}

	private fun perform(id: String) = action(id).actionPerformed(event(action(id)))

	private fun clipboardText(): String? = CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor)

	/** Seconds until an invite link stops opening, read from the `<expiry>.<mac>` token in it. */
	private fun inviteSecondsLeft(url: String): Long =
		url.substringAfter("token=").substringBefore('.').toLong() - System.currentTimeMillis() / 1000

	private class SettingsPage(val configurable: SourcebeamConfigurable) {
		val panel = configurable.createComponent() as DialogPanel
		private val fields = UIUtil.findComponentsOfType(panel, JBTextField::class.java)
		val server get() = fields[0]
		val projectId get() = fields[1]
		val ttl get() = fields[2]

		init {
			configurable.reset()
		}
	}

	private fun openSettings(): SettingsPage = SettingsPage(SourcebeamConfigurable(project)).also {
		it.panel.registerValidators(testRootDisposable)
		Disposer.register(testRootDisposable) { it.configurable.disposeUIResources() }
	}

	// --- scenarios: keep in step with extensions/vscode/tests/integration/suite/ui.test.ts ---

	fun `test settings round trip - values edited in the settings page are what start uses`() {
		val page = openSettings()
		assertEquals(SERVER_URL, page.server.text)
		assertEquals(projectId, page.projectId.text)
		assertEquals("6", page.ttl.text)
		assertFalse("a freshly opened page has nothing to apply", page.configurable.isModified)

		val statusChanges = AtomicInteger()
		project.messageBus.connect(testRootDisposable).subscribe(SourcebeamStatusListener.TOPIC, SourcebeamStatusListener { statusChanges.incrementAndGet() })

		val edited = "$projectId-edited"
		// Same Worker, different origin: the token stored for localhost does not carry over to it.
		// A trailing slash is what people paste; start() must still reach the same server.
		HostToken.set(OTHER_ORIGIN, "")
		page.server.text = "$OTHER_ORIGIN/"
		page.projectId.text = edited
		page.ttl.text = "1"
		assertTrue(page.configurable.isModified)

		page.configurable.apply()
		assertEquals("$OTHER_ORIGIN/", SourcebeamAppSettings.getInstance().serverUrl)
		assertEquals(edited, SourcebeamSettings.getInstance(project).projectId)
		assertEquals(1, SourcebeamSettings.getInstance(project).inviteTtlHours)
		assertFalse(page.configurable.isModified)
		PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
		assertTrue("applying tells the tool window to refresh", statusChanges.get() > 0)

		// Cancel path: an edit that is never applied is dropped by reset() and never reaches the settings.
		page.projectId.text = "never-applied"
		assertTrue(page.configurable.isModified)
		page.configurable.reset()
		assertEquals(edited, page.projectId.text)
		assertEquals(edited, SourcebeamSettings.getInstance(project).projectId)

		service.start()
		waitUntil("the no-token error") { notified("No token set") }
		assertFalse(service.isRunning)

		answerInputDialogs("dev-host")
		perform("SetToken")
		waitUntil("the token to be saved for the edited server") { HostToken.get(OTHER_ORIGIN) == "dev-host" }

		projectId = edited
		startAndWaitLive()
		val invite = service.mintInvite()
		assertTrue("the invite is for the edited server and project: $invite", invite.startsWith("http://127.0.0.1:4173/$edited?token="))
		assertTrue("the invite lifetime is the edited one: ${inviteSecondsLeft(invite)}s", inviteSecondsLeft(invite) in 3500..3700)
	}

	fun `test settings round trip - invalid input is rejected with the user-facing message`() {
		val page = openSettings()
		// What the page shows under a field while the user types, as the platform's validator reports it.
		fun problem(field: JBTextField, text: String): String? {
			field.text = text
			PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
			return ComponentValidator.getInstance(field).orElse(null)?.validationInfo?.message
		}

		assertNull(problem(page.server, SERVER_URL))
		assertEquals("ws:// is only allowed for localhost — use wss://.", problem(page.server, "ws://example.com"))
		assertEquals("must start with ws:// or wss://.", problem(page.server, "http://localhost:4173"))
		assertEquals("must be an origin only — no path, query or fragment.", problem(page.server, "wss://example.com/path"))
		assertNull("blank means unset", problem(page.server, ""))
		assertNull(problem(page.server, SERVER_URL))

		val rule = "Only [a-z0-9_-], and it can't start with a hyphen or underscore."
		assertEquals(rule, problem(page.projectId, "Not Valid"))
		assertEquals(rule, problem(page.projectId, "-leading-hyphen"))
		assertNull("blank means the folder-name default", problem(page.projectId, ""))
		assertNull(problem(page.projectId, "fine_id-1"))
	}

	fun `test set host token - saves for the server and start uses it`() {
		HostToken.set(SERVER_URL, "wrong-token")
		answerInputDialogs("dev-host")

		perform("SetToken")
		waitUntil("the token to be saved") { notified("Token saved.") }
		assertEquals("dev-host", HostToken.get(SERVER_URL))
		assertEquals(1, shownDialogs.size)
		assertTrue("the prompt names the server the token is for: ${shownDialogs[0]}", SERVER_URL in shownDialogs[0])

		startAndWaitLive()
	}

	fun `test set host token - a wrong token is rejected by the server, a corrected one goes live`() {
		answerInputDialogs("wrong-token")
		perform("SetToken")
		waitUntil("the wrong token to be saved") { HostToken.get(SERVER_URL) == "wrong-token" }

		service.start()
		waitUntil("the invalid-token error") { notified("invalid host token") }
		waitUntil("broadcasting to stop") { !service.isRunning && service.status == BroadcastStatus.OFF }

		answerInputDialogs("dev-host")
		perform("SetToken")
		waitUntil("the corrected token to be saved") { HostToken.get(SERVER_URL) == "dev-host" }
		startAndWaitLive()
	}

	fun `test set host token - without a valid server URL it says so and does not ask for a token`() {
		answerInputDialogs("should-not-be-asked")
		answerDialogs(Messages.OK)
		HostToken.set(SERVER_URL, "dev-host")

		SourcebeamAppSettings.getInstance().serverUrl = ""
		perform("SetToken")
		assertEquals(listOf("Set the server URL first — the token is stored per server."), shownDialogs.toList())

		shownDialogs.clear()
		SourcebeamAppSettings.getInstance().serverUrl = "ws://example.com"
		perform("SetToken")
		assertEquals(listOf("Server URL: ws:// is only allowed for localhost — use wss://."), shownDialogs.toList())

		SourcebeamAppSettings.getInstance().serverUrl = SERVER_URL
		assertEquals("the stored token is untouched", "dev-host", HostToken.get(SERVER_URL))
	}

	fun `test status surfaces - the widget and the tool window follow off, live, off`() {
		val widget = SourcebeamStatusBarWidget(project)
		val toolWindow = ToolWindowManager.getInstance(project).registerToolWindow(RegisterToolWindowTask.notClosable("SourcebeamUiTest"))
		SourcebeamToolWindowFactory().createToolWindowContent(project, toolWindow)
		val panel = toolWindow.contentManager.contents.single().component
		val labels = { UIUtil.findComponentsOfType(panel, JLabel::class.java).map { it.text } + UIUtil.findComponentsOfType(panel, AbstractButton::class.java).map { it.text } }
		// The tool window repaints from invokeLater and reads the token off-thread.
		val showsEventually = { text: String -> waitUntil("the tool window to show \"$text\"") { settle(50); text in labels() } }

		assertEquals(BroadcastStatus.OFF, service.status)
		assertEquals("Sourcebeam: off", widget.getText())
		assertEquals("Not broadcasting — click to start", widget.getTooltipText())
		showsEventually("Off")
		assertTrue("the project id row", projectId in labels())
		assertTrue("the server row", SERVER_URL in labels())
		showsEventually("Set — click to change")

		startAndWaitLive()
		assertEquals("Sourcebeam: live", widget.getText())
		assertEquals("Broadcasting — click to stop", widget.getTooltipText())
		showsEventually("Live")

		service.stop()
		assertEquals("Sourcebeam: off", widget.getText())
		showsEventually("Off")
	}

	fun `test status surfaces - clicking the widget toggles broadcasting`() {
		val widget = SourcebeamStatusBarWidget(project)
		val click = { widget.getClickConsumer().consume(null) }

		click()
		waitUntil("the click to start broadcasting", 15_000) { service.status == BroadcastStatus.LIVE }
		click()
		waitUntil("the click to stop broadcasting") { service.status == BroadcastStatus.OFF }
		assertFalse(service.isRunning)
	}

	fun `test actions - enabled only when they make sense`() {
		val needsRunning = listOf("Stop", "CopyInvite", "RevokeInvites", "DeleteProject")
		val always = listOf("OpenSettings", "SetToken")

		assertTrue("Start is offered when off", enabled("Start"))
		for (id in needsRunning) assertFalse("$id must be disabled when off", enabled(id))
		for (id in always) assertTrue("$id is always available", enabled(id))

		startAndWaitLive()
		assertFalse("Start must be disabled while broadcasting", enabled("Start"))
		for (id in needsRunning) assertTrue("$id must be enabled while broadcasting", enabled(id))

		service.stop()
		assertTrue(enabled("Start"))
		for (id in needsRunning) assertFalse("$id must be disabled again after stop", enabled(id))

		for (id in listOf("Start") + needsRunning + always) assertFalse("$id needs a project", enabled(id, withProject = false))
	}

	fun `test commands while stopped - they say to start first and do not prompt`() {
		answerDialogs(Messages.YES)
		val before = clipboardText()
		perform("CopyInvite")
		perform("RevokeInvites")
		perform("DeleteProject")
		// Exactly the notice, not a "Failed to ..." error that merely quotes it from a service call.
		settle(300)
		assertEquals("start broadcasting first", 3, notifications.count { it.content == "Start broadcasting first." })
		assertEquals("no confirmation is shown for a project that is not live", emptyList<String>(), shownDialogs.toList())
		assertEquals("nothing is copied", before, clipboardText())
	}

	fun `test copy invite - a working link lands on the clipboard`() {
		startAndWaitLive()
		perform("CopyInvite")
		val prefix = "$HTTP_URL/$projectId?token="
		waitUntil("the invite link on the clipboard") { clipboardText()?.startsWith(prefix) == true }
		waitUntil("the confirmation") { notified("Invite link copied to the clipboard.") }

		// The link is the one a viewer follows: it must open the project and show its files.
		val link = clipboardText()!!
		val viewer = TestViewer.connect(projectId, TestViewer.cookieFor(link)).also { viewers.add(it) }
		waitUntil("the viewer to receive the tree") { viewer.firstTree() != null }
		assertTrue("README.md" in viewer.firstTree()!!)
	}

	fun `test delete project - asks for confirmation and does nothing when cancelled`() {
		val viewer = liveViewer("README.md")
		answerDialogs(Messages.NO)

		perform("DeleteProject")
		assertEquals(1, shownDialogs.size)
		assertTrue("the prompt warns it cannot be undone: ${shownDialogs[0]}", "cannot be undone" in shownDialogs[0])
		settle(1500)
		assertTrue("still broadcasting", service.isRunning)
		assertEquals(BroadcastStatus.LIVE, service.status)
		assertFalse("the viewer was not told the project is gone", viewer.messages.any { it["type"] == "project_deleted" })
		assertFalse(notified("Project deleted."))

		answerDialogs(Messages.YES)
		perform("DeleteProject")
		waitUntil("project_deleted message") { viewer.messages.any { it["type"] == "project_deleted" } }
		waitUntil("the confirmation") { notified("Project deleted.") }
	}
}
