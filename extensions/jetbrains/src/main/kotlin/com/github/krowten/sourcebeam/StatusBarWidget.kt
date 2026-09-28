package com.github.krowten.sourcebeam

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import java.awt.event.MouseEvent

class SourcebeamStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {

	override fun ID(): String = ID

	override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

	override fun install(statusBar: StatusBar) = Unit

	override fun dispose() = Unit

	override fun getText(): String = when (BroadcastService.getInstance(project).status) {
		BroadcastStatus.LIVE -> "Sourcebeam: live"
		BroadcastStatus.RECONNECTING -> "Sourcebeam: reconnecting"
		BroadcastStatus.OFF -> "Sourcebeam: off"
	}

	override fun getAlignment(): Float = java.awt.Component.CENTER_ALIGNMENT

	override fun getTooltipText(): String = when (BroadcastService.getInstance(project).status) {
		BroadcastStatus.OFF -> "Not broadcasting — click to start"
		else -> "Broadcasting — click to stop"
	}

	override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
		BroadcastService.getInstance(project).toggle()
	}

	companion object {
		const val ID: String = "SourcebeamStatusBar"
	}
}

class SourcebeamStatusBarWidgetFactory : StatusBarWidgetFactory, DumbAware {
	override fun getId(): String = SourcebeamStatusBarWidget.ID

	override fun getDisplayName(): String = "Sourcebeam"

	override fun createWidget(project: Project): StatusBarWidget = SourcebeamStatusBarWidget(project)

	override fun isAvailable(project: Project): Boolean = true
}
