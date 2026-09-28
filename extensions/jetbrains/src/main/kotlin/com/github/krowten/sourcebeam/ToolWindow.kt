package com.github.krowten.sourcebeam

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.FormBuilder
import javax.swing.JPanel

/**
 * The Activity Bar counterpart of the VS Code extension's sidebar: status at a glance, plus a
 * toolbar built from a subset of the actions already defined once in plugin.xml (Start/Stop,
 * Copy Invite, Revoke Invites, Settings) — nothing here re-implements what an action already
 * does. Delete Project deliberately stays out of the toolbar, a one-click icon button being the
 * wrong place to destroy everything — it's still one click away in the pre-existing Tools |
 * Sourcebeam menu. Server URL, project id and host token — everything a first-time user must set
 * before anything works — are NOT hidden behind that menu the way they used to be: they're links
 * right in the panel body, same spirit as the VS Code sidebar's always-visible, always-clickable
 * rows. Server and Project both open the same Settings dialog (SourcebeamConfigurable), which is
 * also where an invite TTL override lives — one place for every setting that isn't the token.
 */
class SourcebeamToolWindowFactory : ToolWindowFactory, DumbAware {
	override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
		val panel = SourcebeamToolWindowPanel(project)
		val content = ContentFactory.getInstance().createContent(panel, null, false)
		content.setDisposer(panel)
		toolWindow.contentManager.addContent(content)
	}
}

private class SourcebeamToolWindowPanel(private val project: Project) :
	SimpleToolWindowPanel(true, true), Disposable {

	private val serverValue = ActionLink("") { openSettings() }
	private val projectValue = ActionLink("") { openSettings() }
	private val statusValue = JBLabel()
	private val tokenValue = ActionLink("") { setHostTokenInteractive(project) }

	init {
		val am = ActionManager.getInstance()
		val toolbarGroup = DefaultActionGroup(
			am.getAction("Sourcebeam.Start"),
			am.getAction("Sourcebeam.Stop"),
			Separator.getInstance(),
			am.getAction("Sourcebeam.CopyInvite"),
			am.getAction("Sourcebeam.RevokeInvites"),
			Separator.getInstance(),
			am.getAction("Sourcebeam.OpenSettings"),
		)
		val actionToolbar = am.createActionToolbar("Sourcebeam.ToolWindow", toolbarGroup, true)
		actionToolbar.targetComponent = this
		toolbar = actionToolbar.component

		setContent(
			FormBuilder.createFormBuilder()
				.addLabeledComponent("Server:", serverValue)
				.addLabeledComponent("Project:", projectValue)
				.addLabeledComponent("Status:", statusValue)
				.addLabeledComponent("Host token:", tokenValue)
				.addComponentFillVertically(JPanel(), 0)
				.panel,
		)

		refresh()
		// Tied to this panel's own disposal (via Content.setDisposer below), not the project's —
		// the tool window's content is recreated per-open, and a stale subscription from a
		// previous open must not double-fire refreshes into a panel nobody can see anymore.
		project.messageBus.connect(this).subscribe(
			SourcebeamStatusListener.TOPIC,
			SourcebeamStatusListener { refreshOnEdt() },
		)
	}

	private fun openSettings() {
		ShowSettingsUtil.getInstance().showSettingsDialog(project, SourcebeamConfigurable::class.java)
	}

	private fun refreshOnEdt() {
		ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) refresh() }
	}

	private fun refresh() {
		val projectSettings = SourcebeamSettings.getInstance(project)
		val server = projectSettings.serverUrl
		serverValue.text = server.ifEmpty { "Not set — click to set" }
		projectValue.text = projectSettings.projectId
		statusValue.text = when (BroadcastService.getInstance(project).status) {
			BroadcastStatus.LIVE -> "Live"
			BroadcastStatus.RECONNECTING -> "Reconnecting…"
			BroadcastStatus.OFF -> "Off"
		}
		// HostToken.get() hits the OS keychain — never block the EDT on it. Read it off-thread
		// and hop back to update the label once it's known; refresh() itself stays synchronous
		// for the settings-only fields above.
		ApplicationManager.getApplication().executeOnPooledThread {
			val hasToken = HostToken.get(server).isNotEmpty()
			ApplicationManager.getApplication().invokeLater {
				if (!project.isDisposed) {
					tokenValue.text = if (hasToken) "Set — click to change" else "Not set — click to set"
				}
			}
		}
	}

	override fun dispose() = Unit
}
