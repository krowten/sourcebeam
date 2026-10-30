package com.github.krowten.sourcebeam.integration

import com.github.krowten.sourcebeam.SourcebeamSettings

/**
 * Invite lifetime as the host asks for it, the JetBrains side of
 * extensions/vscode/tests/integration/suite/invites.test.ts: the link minted by the plugin expires
 * after the configured number of hours, 6 when none is set. The expiry is read the way the server
 * does, from the `<unix-seconds>.<mac>` token in the invite URL.
 */
class InviteIntegrationTest : IntegrationTestBase() {

	private val slackSeconds = 120L

	private fun mintedLifetimeSeconds(): Long {
		startAndWaitLive()
		val before = System.currentTimeMillis() / 1000
		val token = service.mintInvite().substringAfter("?token=")
		val expiry = token.substringBefore('.').toLongOrNull() ?: error("the invite token has no integer expiry: $token")
		return expiry - before
	}

	private fun assertAbout(actual: Long, hours: Int) {
		val expected = hours * 3600L
		assertTrue("expected a lifetime near $hours h ($expected s), got $actual s", Math.abs(actual - expected) <= slackSeconds)
	}

	// --- scenarios: keep in step with extensions/vscode/tests/integration ---

	fun `test invite lifetime - the configured hours are what the minted link expires after`() {
		SourcebeamSettings.getInstance(project).inviteTtlHours = 2
		assertAbout(mintedLifetimeSeconds(), 2)
	}

	fun `test invite lifetime - 6 hours when the workspace sets none`() {
		assertAbout(mintedLifetimeSeconds(), 6)
	}
}
