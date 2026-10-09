package com.github.krowten.sourcebeam

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/** The server URL applies to every project you broadcast from this machine — one person, one
 * server, occasionally several project folders — so it lives at the application level
 * (`<config>/options/sourcebeam.xml`). Everything else is per-project; see [SourcebeamSettings]. */
class SourcebeamAppState : BaseState() {
	var serverUrl by string("")
}

@Service(Service.Level.APP)
@State(name = "SourcebeamAppSettings", storages = [Storage("sourcebeam.xml")])
class SourcebeamAppSettings : PersistentStateComponent<SourcebeamAppState> {
	private var state = SourcebeamAppState()

	override fun getState(): SourcebeamAppState = state

	override fun loadState(state: SourcebeamAppState) {
		this.state = state
	}

	var serverUrl: String
		get() = state.serverUrl.orEmpty()
		set(value) {
			state.serverUrl = value
		}

	companion object {
		fun getInstance(): SourcebeamAppSettings = service()
	}
}

/** Per-project: which project id this folder broadcasts as, and how long its invite links last.
 * Stored in `.idea/sourcebeam.xml`. */
class SourcebeamProjectState : BaseState() {
	var projectId by string("")
	// Keep in sync with the VS Code extension's sourcebeam.inviteTtlHours default.
	var inviteTtlHours by property(6)
}

@Service(Service.Level.PROJECT)
@State(name = "Sourcebeam", storages = [Storage("sourcebeam.xml")])
class SourcebeamSettings(private val project: Project) : PersistentStateComponent<SourcebeamProjectState> {
	private var state = SourcebeamProjectState()

	override fun getState(): SourcebeamProjectState = state

	override fun loadState(state: SourcebeamProjectState) {
		this.state = state
	}

	/** Falls back to a sanitized version of the IDE project's name (usually the folder name) when
	 * nothing's been explicitly set — never persisted until the user actually saves the settings
	 * panel, so opening and cancelling the dialog doesn't silently write a guessed value. */
	var projectId: String
		get() = state.projectId.orEmpty().ifEmpty { sanitizeProjectId(project.name) }
		set(value) {
			state.projectId = value
		}

	/** Application-wide; read through here so callers holding a project don't need both services. */
	val serverUrl: String
		get() = SourcebeamAppSettings.getInstance().serverUrl

	var inviteTtlHours: Int
		get() = state.inviteTtlHours
		set(value) {
			state.inviteTtlHours = value
		}

	companion object {
		fun getInstance(project: Project): SourcebeamSettings = project.service()
	}
}

/**
 * The host token never goes into the settings XML — that file lives in .idea/ and gets committed
 * by plenty of teams. PasswordSafe puts it in the OS keychain (or the IDE's encrypted store),
 * which is the JetBrains counterpart of VS Code's SecretStorage.
 *
 * One credential per server origin, shared by every project pointed at that server — not one
 * shared regardless of origin, since switching the server URL shouldn't silently carry the old
 * origin's token along to a different server. Callers pass the raw (as configured) `server`
 * string; both accessors validate it via validateServerUrl themselves so the origin used as the
 * credential key is always the normalized one.
 */
object HostToken {
	private fun attributes(origin: String): CredentialAttributes =
		CredentialAttributes(generateServiceName("Sourcebeam", "hostToken::$origin"))

	/** Blocking (native keychain access) — call off the EDT. Empty for an invalid/unset server,
	 * same as "no token", so callers don't need a separate try/catch just to read one. */
	fun get(server: String): String {
		val origin = try {
			validateServerUrl(server)
		} catch (_: IllegalArgumentException) {
			return ""
		}
		return PasswordSafe.instance.getPassword(attributes(origin)).orEmpty()
	}

	/** Blocking (native keychain access) — call off the EDT. Throws on an invalid server: unlike
	 * [get], saving a token has nowhere sensible to silently no-op to. */
	fun set(server: String, token: String) {
		val origin = validateServerUrl(server)
		PasswordSafe.instance.setPassword(attributes(origin), token.ifEmpty { null })
	}
}

// --- validation, ported from the VS Code extension's core.ts ----------------

data class Config(val server: String, val token: String, val project: String)

fun isValidProjectId(id: String): Boolean = Regex("^[a-z0-9][a-z0-9_-]{0,63}$").matches(id)

/** Best-effort default project id from the IDE project's display name (usually the root folder
 * name): lowercased, anything outside [a-z0-9_-] replaced with a hyphen, leading hyphens/
 * underscores stripped since isValidProjectId forbids them there. Only ever used as a fallback
 * for an unset field — never overwrites a value the user actually typed, valid or not. */
fun sanitizeProjectId(name: String): String {
	val lowered = name.lowercase().replace(Regex("[^a-z0-9_-]"), "-")
	val trimmed = lowered.trimStart('-', '_').take(64)
	return trimmed.ifEmpty { "project" }
}

/** Validated to a bare ws(s) origin — ws(s)://host[:port], no path, query, fragment or embedded
 * credentials. The host token is scoped to exactly this string (see [HostToken]), so it has to
 * be normalized once, here, rather than trusted as whatever free-form text sits in the setting. */
private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "[::1]")

fun validateServerUrl(input: String): String {
	val trimmed = input.trim()
	val uri = try {
		java.net.URI(trimmed)
	} catch (_: Exception) {
		throw IllegalArgumentException("Server URL: must be a valid ws:// or wss:// URL.")
	}
	val scheme = uri.scheme?.lowercase()
	if (scheme != "ws" && scheme != "wss") {
		throw IllegalArgumentException("Server URL: must start with ws:// or wss://.")
	}
	if (uri.userInfo != null) {
		throw IllegalArgumentException("Server URL: must not include a username or password.")
	}
	val host = uri.host
	// Plain ws:// would send the code and the host token unencrypted. A deployed Worker is always
	// wss://; ws:// only exists for a local `wrangler dev`.
	if (scheme == "ws" && host?.lowercase() !in LOCAL_HOSTS) {
		throw IllegalArgumentException("Server URL: ws:// is only allowed for localhost — use wss://.")
	}
	if (host.isNullOrEmpty() || (uri.rawPath.isNotEmpty() && uri.rawPath != "/") || uri.rawQuery != null || uri.rawFragment != null) {
		throw IllegalArgumentException("Server URL: must be an origin only — no path, query or fragment.")
	}
	val port = if (uri.port != -1) ":${uri.port}" else ""
	return "$scheme://${host.lowercase()}$port"
}

fun validateConfig(server: String, project: String, token: String): Config {
	val trimmedProject = project.trim()
	if (server.trim().isEmpty() || trimmedProject.isEmpty()) {
		throw IllegalArgumentException("Set the server URL and project id in Settings | Tools | Sourcebeam.")
	}
	val validatedServer = validateServerUrl(server)
	if (!isValidProjectId(trimmedProject)) {
		throw IllegalArgumentException(
			"Project id: lowercase letters, digits, hyphens, underscores; can't start with a hyphen or underscore."
		)
	}
	if (token.isEmpty()) {
		throw IllegalArgumentException("No token set. Run the \"Sourcebeam: Set Host Token\" action.")
	}
	return Config(validatedServer, token, trimmedProject)
}

/**
 * The invite URL the server returns is relative to the http(s) origin, not the ws(s) one the
 * broadcaster connects with — swap the scheme when building the link to copy.
 */
fun toHttpUrl(serverUrl: String): String = serverUrl.replaceFirst(Regex("^ws"), "http")
