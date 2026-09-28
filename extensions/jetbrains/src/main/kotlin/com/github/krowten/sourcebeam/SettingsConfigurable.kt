package com.github.krowten.sourcebeam

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

/**
 * Settings | Tools | Sourcebeam — every setting except the host token in one place (the token
 * lives in the IDE password safe, not this settings XML, so it gets a link to the same interactive
 * dialog the tool window uses instead of a bound field here).
 *
 * Server URL and host token are application-wide (one person, one server, however many project
 * folders). Project id and invite TTL are per-project; the TTL defaults to 6 hours.
 */
class SourcebeamConfigurable(private val project: Project) : BoundConfigurable("Sourcebeam") {

	// The tool window shows this panel's values at a glance; without this it would only pick up an
	// edit made here the next time broadcasting starts (start() re-reads settings), not on Apply.
	override fun apply() {
		super.apply()
		project.messageBus.syncPublisher(SourcebeamStatusListener.TOPIC).statusChanged()
	}

	override fun createPanel(): DialogPanel {
		val appSettings = SourcebeamAppSettings.getInstance()
		val projectSettings = SourcebeamSettings.getInstance(project)
		lateinit var serverField: JBTextField
		return panel {
			row("Server URL:") {
				serverField = textField()
					.bindText(appSettings::serverUrl)
					.columns(40)
					.comment(
						"The Worker's WebSocket URL, e.g. wss://sourcebeam.[your-subdomain].workers.dev — " +
							"shared by every project you broadcast from this IDE.",
					)
					.validationOnInput { field ->
						val value = field.text.trim()
						when {
							value.isEmpty() -> null
							!value.startsWith("ws://") && !value.startsWith("wss://") ->
								ValidationInfo("Must start with ws:// or wss://", field)

							else -> null
						}
					}
					.component
			}
			row("Project id:") {
				textField()
					.bindText(projectSettings::projectId)
					.columns(30)
					.comment(
						"Lowercase letters, digits, hyphens, underscores; can't start with a hyphen or " +
							"underscore. Defaults to this project's name, sanitized — specific to this project.",
					)
					.validationOnInput { field ->
						val value = field.text.trim()
						if (value.isEmpty() || isValidProjectId(value)) null
						else ValidationInfo("Only [a-z0-9_-], and it can't start with a hyphen or underscore.", field)
					}
			}
			row("Invite link lifetime (hours):") {
				intTextField(range = 1..24 * 30)
					.bindIntText(projectSettings::inviteTtlHours)
					.columns(6)
					.comment("For this project only; 6 hours unless you change it.")
			}
			row("Host token:") {
				// The field's current text, not the saved setting: a URL typed above but not applied yet
				// is the one the token belongs to.
				cell(ActionLink("Set…") { setHostTokenInteractive(project, serverField.text) })
				comment("Stored in the IDE password safe per server, shared by every project — click to set or change it.")
			}
		}
	}
}
