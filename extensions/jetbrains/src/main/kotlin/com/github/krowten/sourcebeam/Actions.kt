package com.github.krowten.sourcebeam

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.awt.datatransfer.StringSelection

/**
 * The same six host commands the VS Code extension exposes, plus the toggle the status bar widget
 * uses. Anything that talks to the server runs off the EDT — these actions only collect input and
 * report the result.
 */
abstract class SourcebeamAction : AnAction(), DumbAware {
	override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

	protected fun service(e: AnActionEvent): BroadcastService? =
		e.getData(CommonDataKeys.PROJECT)?.let { BroadcastService.getInstance(it) }

	override fun update(e: AnActionEvent) {
		e.presentation.isEnabled = e.getData(CommonDataKeys.PROJECT) != null
	}
}

class StartBroadcastAction : SourcebeamAction() {
	override fun actionPerformed(e: AnActionEvent) {
		service(e)?.start()
	}

	override fun update(e: AnActionEvent) {
		super.update(e)
		e.presentation.isEnabled = service(e)?.isRunning == false
	}
}

class StopBroadcastAction : SourcebeamAction() {
	override fun actionPerformed(e: AnActionEvent) {
		service(e)?.stop()
	}

	override fun update(e: AnActionEvent) {
		super.update(e)
		e.presentation.isEnabled = service(e)?.isRunning == true
	}
}

/**
 * Shared by the menu action below, the tool window's inline "Set…" link and the settings page.
 * `server` defaults to the saved server URL; the settings page passes the value currently typed in
 * its Server URL field instead, so a URL entered but not yet applied is the one the token is
 * saved for.
 */
fun setHostTokenInteractive(project: Project, server: String = SourcebeamSettings.getInstance(project).serverUrl) {
	// Checked before asking for the token: it's stored per server origin, so there's nothing to
	// save it under without a valid URL, and typing a token only to be told that is worse.
	val origin = try {
		validateServerUrl(server)
	} catch (e: IllegalArgumentException) {
		Messages.showErrorDialog(
			project,
			if (server.isBlank()) "Set the server URL first — the token is stored per server." else e.message ?: "Invalid server URL.",
			"Sourcebeam: Set Host Token",
		)
		return
	}
	val token = Messages.showPasswordDialog(
		project,
		"Host token for $origin (from the deploy summary, or your HOST_TOKENS KV namespace):",
		"Sourcebeam: Set Host Token",
		null,
	) ?: return
	// PasswordSafe hits the OS keychain — never call it from the dialog's own EDT callback.
	ApplicationManager.getApplication().executeOnPooledThread {
		HostToken.set(origin, token.trim())
		BroadcastService.getInstance(project).notify(
			if (token.isBlank()) "Token cleared." else "Token saved.",
			NotificationType.INFORMATION,
		)
		// The tool window shows whether a token is set; without this it wouldn't know until the
		// next unrelated refresh.
		project.messageBus.syncPublisher(SourcebeamStatusListener.TOPIC).statusChanged()
	}
}

class SetHostTokenAction : SourcebeamAction() {
	override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

	override fun actionPerformed(e: AnActionEvent) {
		val project = e.getData(CommonDataKeys.PROJECT) ?: return
		setHostTokenInteractive(project)
	}
}

/** Toolbar/menu shortcut to Settings | Tools | Sourcebeam — the tool window's "getting started" action. */
class OpenSettingsAction : SourcebeamAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.getData(CommonDataKeys.PROJECT) ?: return
		ShowSettingsUtil.getInstance().showSettingsDialog(project, SourcebeamConfigurable::class.java)
	}

	override fun update(e: AnActionEvent) {
		super.update(e)
		e.presentation.isEnabled = e.getData(CommonDataKeys.PROJECT) != null
	}
}

class CopyInviteLinkAction : SourcebeamAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.getData(CommonDataKeys.PROJECT) ?: return
		val service = BroadcastService.getInstance(project)
		if (!service.isRunning) {
			service.notify("Start broadcasting first.", NotificationType.INFORMATION)
			return
		}
		runOffEdt(project) {
			try {
				val url = service.mintInvite()
				// AWT clipboard access belongs on the EDT, not this pooled thread.
				ApplicationManager.getApplication().invokeLater {
					CopyPasteManager.getInstance().setContents(StringSelection(url))
				}
				service.notify("Invite link copied to the clipboard.", NotificationType.INFORMATION)
			} catch (ex: Exception) {
				service.notify("Failed to get an invite — ${ex.message}", NotificationType.ERROR)
			}
		}
	}

	override fun update(e: AnActionEvent) {
		super.update(e)
		e.presentation.isEnabled = service(e)?.isRunning == true
	}
}

class RevokeInvitesAction : SourcebeamAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.getData(CommonDataKeys.PROJECT) ?: return
		val service = BroadcastService.getInstance(project)
		if (!service.isRunning) {
			service.notify("Start broadcasting first.", NotificationType.INFORMATION)
			return
		}
		runOffEdt(project) {
			try {
				service.revokeInvites()
				service.notify("Old invite links revoked.", NotificationType.INFORMATION)
			} catch (ex: Exception) {
				service.notify("Failed to revoke links — ${ex.message}", NotificationType.ERROR)
			}
		}
	}

	override fun update(e: AnActionEvent) {
		super.update(e)
		e.presentation.isEnabled = service(e)?.isRunning == true
	}
}

class DeleteProjectAction : SourcebeamAction() {
	override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

	override fun actionPerformed(e: AnActionEvent) {
		val project = e.getData(CommonDataKeys.PROJECT) ?: return
		val service = BroadcastService.getInstance(project)
		if (!service.isRunning) {
			service.notify("Start broadcasting first.", NotificationType.INFORMATION)
			return
		}
		val confirmed = Messages.showYesNoDialog(
			project,
			"Delete the project on the server? This cannot be undone, and every viewer is disconnected.",
			"Sourcebeam: Delete Project",
			"Delete",
			"Cancel",
			Messages.getWarningIcon(),
		) == Messages.YES
		if (!confirmed) return
		runOffEdt(project) {
			try {
				service.deleteProject()
				service.notify("Project deleted.", NotificationType.INFORMATION)
			} catch (ex: Exception) {
				service.notify("Failed to delete the project — ${ex.message}", NotificationType.ERROR)
			}
		}
	}

	override fun update(e: AnActionEvent) {
		super.update(e)
		e.presentation.isEnabled = service(e)?.isRunning == true
	}
}

private fun runOffEdt(project: Project, block: () -> Unit) {
	if (project.isDisposed) return
	ApplicationManager.getApplication().executeOnPooledThread(block)
}
