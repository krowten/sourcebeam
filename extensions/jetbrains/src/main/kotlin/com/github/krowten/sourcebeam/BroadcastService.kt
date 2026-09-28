package com.github.krowten.sourcebeam

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VFileProperty
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.messages.Topic
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

enum class BroadcastStatus { OFF, LIVE, RECONNECTING }

// A typo'd or unreachable server URL retries forever with the same capped backoff as a genuinely
// transient network blip — indistinguishable from the reconnect loop's point of view, so it just
// looks hung. This many consecutive failures without ever reaching LIVE is enough to stop assuming
// "transient" and say something.
private const val UNREACHABLE_WARNING_THRESHOLD = 3

/** Fires on every status change, so the tool window can refresh itself without polling. */
fun interface SourcebeamStatusListener {
	fun statusChanged()

	companion object {
		val TOPIC: Topic<SourcebeamStatusListener> =
			Topic.create("Sourcebeam status changed", SourcebeamStatusListener::class.java)
	}
}

/**
 * The broadcaster: watches the project directory and streams it to a sourcebeam Worker.
 *
 * A port of extensions/vscode/src/extension.ts, including its concurrency design. The generation
 * counter is the important part: it is bumped by both start and stop, so a loop still unwinding
 * from a previous run sees itself as stale on its very next check and can never clobber the state
 * a fresh run already owns. Getting that wrong produced two live broadcast loops on a fast
 * stop-then-start — the bug that cost this project a rewrite of the teardown path in the VS Code
 * extension.
 */
@Service(Service.Level.PROJECT)
class BroadcastService(private val project: Project) : Disposable {

	private val log = logger<BroadcastService>()

	private val generation = AtomicInteger(0)

	@Volatile
	private var running = false

	@Volatile
	private var stopping = false

	@Volatile
	private var connection: WsConnection? = null

	@Volatile
	private var config: Config? = null

	@Volatile
	private var root: VirtualFile? = null

	@Volatile
	private var policy: FilePolicy = DEFAULT_POLICY

	@Volatile
	private var ignore: IgnoreMatcher = IgnoreMatcher.parse(null)

	@Volatile
	private var snapshotting = false

	// Confined to the reconnect-loop thread (loop() and runOnce() run on the same pooled thread for
	// the life of a run) — no @Volatile needed, same as loop()'s own `delay` local.
	private var consecutiveFailures = 0

	@Volatile
	var status: BroadcastStatus = BroadcastStatus.OFF
		private set

	private var coalescer: Coalescer? = null
	private var vfsConnection: com.intellij.util.messages.MessageBusConnection? = null

	/** Paths currently mirrored on the server — lets a directory delete fan out to its files. */
	private val sent = ConcurrentHashMap.newKeySet<String>()

	// relDir (posix, relative to root) -> whether it or an ancestor is a symlink. Only consulted
	// by onCoalesced's incremental path — collectFiles prunes symlinked directories as it walks,
	// so it never needs this. Cleared per start(): symlinks on disk may have changed since the
	// last run.
	private val symlinkCache = ConcurrentHashMap<String, Boolean>()

	private val pendingInvite = ConcurrentHashMap<String, CompletableFuture<Map<String, Any?>>>()

	val isRunning: Boolean get() = running

	// --- lifecycle ---------------------------------------------------------

	fun start() {
		if (running) {
			notify("Already broadcasting.", NotificationType.INFORMATION)
			return
		}
		// Claim the generation and the running slot synchronously, before any I/O: a second start
		// invoked while this one is still reading settings must bail instead of installing a second
		// listener that orphans the first one's timers.
		val myGen = generation.incrementAndGet()
		running = true
		stopping = false
		consecutiveFailures = 0

		val projectRoot = project.baseDirectory()
		if (projectRoot == null) {
			running = false
			notify("Open a project directory first.", NotificationType.ERROR)
			return
		}

		root = projectRoot

		// start() runs on the EDT (it's an AnAction's actionPerformed) — HostToken.get() hits the
		// OS keychain and reading every nested .gitignore touches disk, so both move to a pooled
		// thread rather than blocking the UI. The generation check after them is the same
		// staleness guard runOnce()/loop() already use: a stop() (or a fresh start()) during this
		// setup must not have this stale run install a listener or launch a loop.
		ApplicationManager.getApplication().executeOnPooledThread {
			val projectSettings = SourcebeamSettings.getInstance(project)
			val server = projectSettings.serverUrl
			// HostToken.get() validates the server itself and returns "" for anything malformed —
			// swallow that here so an invalid/empty server still gets validateConfig's own,
			// friendlier error below instead of this lookup's.
			val token = HostToken.get(server)
			val cfg = try {
				validateConfig(server, projectSettings.projectId, token)
			} catch (e: IllegalArgumentException) {
				running = false
				notify(e.message ?: "Invalid configuration.", NotificationType.ERROR)
				return@executeOnPooledThread
			}

			if (generation.get() != myGen) return@executeOnPooledThread

			config = cfg
			ignore = IgnoreMatcher.parseNested(readGitignoreSources(projectRoot))
			symlinkCache.clear()
			sent.clear()

			coalescer = Coalescer(COALESCE_MS) { path -> onCoalesced(path) }
			installVfsListener()

			log.info("starting broadcast of ${projectRoot.path} to ${cfg.server}/ws/${cfg.project}")
			loop(cfg, myGen)
		}
	}

	fun stop() {
		if (stopping) return
		if (!running) {
			setStatus(BroadcastStatus.OFF)
			return
		}
		stopping = true
		running = false
		// Makes the current generation's loop see itself as stale immediately, even if a start()
		// called right after this claims a new generation of its own.
		generation.incrementAndGet()

		coalescer?.dispose()
		coalescer = null
		vfsConnection?.disconnect()
		vfsConnection = null
		connection?.close()
		connection = null
		failPending("broadcast stopped")
		sent.clear()
		symlinkCache.clear()
		root = null
		config = null
		policy = DEFAULT_POLICY
		setStatus(BroadcastStatus.OFF)
	}

	fun toggle() = if (running) stop() else start()

	override fun dispose() = stop()

	// --- reconnect loop ----------------------------------------------------

	private fun loop(cfg: Config, myGen: Int) {
		var delay = RECONNECT_MIN_MS
		while (generation.get() == myGen) {
			val shouldContinue = runOnce(cfg, myGen)
			if (!shouldContinue) {
				if (generation.get() == myGen) running = false
				return
			}
			if (generation.get() != myGen) break
			setStatus(BroadcastStatus.RECONNECTING)
			log.info("reconnecting in ${delay / 1000.0}s")
			consecutiveFailures++
			if (consecutiveFailures == UNREACHABLE_WARNING_THRESHOLD) {
				notify(
					"Can't reach the server after $UNREACHABLE_WARNING_THRESHOLD attempts — check the " +
						"server URL in Settings | Tools | Sourcebeam. Still retrying.",
					NotificationType.WARNING,
				)
			}
			// Jitter, so a Worker restart doesn't bring every host back in the same millisecond.
			sleepInterruptibly(delay + (Math.random() * 0.3 * delay).toLong(), myGen)
			delay = nextReconnectDelay(delay)
		}
		if (generation.get() == myGen) running = false
	}

	/** @return true to keep reconnecting, false to give up (fatal error, or this run went stale). */
	private fun runOnce(cfg: Config, myGen: Int): Boolean {
		val url = cfg.server.trimEnd('/') + "/ws/" + cfg.project
		val conn = try {
			WsConnection.connect(url, cfg.token)
		} catch (e: FatalException) {
			log.warn(e.message)
			notify(e.message ?: "Server rejected the connection.", NotificationType.ERROR)
			setStatus(BroadcastStatus.OFF)
			return false
		} catch (e: Exception) {
			log.warn("connection failed (${e.message})")
			return true
		}

		if (generation.get() != myGen) {
			// stop() or a fresh start() ran while the handshake was in flight and had nothing of
			// ours to close yet — close it here instead of going live under a stale generation.
			conn.close()
			return false
		}

		connection = conn
		setStatus(BroadcastStatus.LIVE)
		consecutiveFailures = 0
		policy = readPolicy(conn)

		if (generation.get() != myGen) {
			conn.close()
			connection = null
			return false
		}

		// The reader thread drains inbound frames for the life of this connection: invite/ok
		// replies and server errors.
		ApplicationManager.getApplication().executeOnPooledThread { readIncoming(conn) }

		try {
			snapshotting = true
			takeSnapshot(conn)
		} catch (e: FatalException) {
			snapshotting = false
			conn.close()
			if (generation.get() == myGen) {
				connection = null
				failPending("connection closed")
			}
			notify(e.message ?: "Snapshot failed.", NotificationType.ERROR)
			setStatus(BroadcastStatus.OFF)
			return false
		} catch (e: Exception) {
			snapshotting = false
			conn.close()
			if (generation.get() == myGen) {
				connection = null
				failPending("connection closed")
			}
			log.warn("snapshot failed (${e.message})")
			return true
		}
		snapshotting = false

		if (generation.get() != myGen) {
			conn.close()
			connection = null
			return false
		}

		val closeCode = conn.awaitClose()
		log.info("disconnected (code $closeCode)")
		// A stop-then-start during that wait means a newer run already owns the state by now.
		if (generation.get() == myGen) {
			connection = null
			failPending("connection closed")
		}
		conn.close()
		if (isTerminalCloseCode(closeCode)) {
			if (generation.get() == myGen) {
				setStatus(BroadcastStatus.OFF)
				notify(
					if (closeCode == 4000) {
						"Another host connected to this project — broadcasting stopped here."
					} else {
						"Project was deleted or expired — broadcasting stopped."
					},
					NotificationType.WARNING,
				)
			}
			return false
		}
		return true
	}

	/** The server's first frame is always `policy`; fall back to the built-in one if it isn't. */
	private fun readPolicy(conn: WsConnection): FilePolicy {
		val raw = conn.poll(5_000) ?: run {
			log.warn("no policy frame within 5s, using the default policy")
			return DEFAULT_POLICY
		}
		val msg = Json.parseObject(raw)
		if (msg == null || msg["type"] != "policy") {
			log.warn("expected a policy frame first, got ${msg?.get("type")} — using the default policy")
			return DEFAULT_POLICY
		}
		return FilePolicy(
			maxBytes = msg.intField("maxBytes") ?: DEFAULT_POLICY.maxBytes,
		)
	}

	private fun readIncoming(conn: WsConnection) {
		while (!conn.isClosed) {
			val raw = conn.poll(1_000) ?: continue
			val msg = Json.parseObject(raw) ?: continue
			when (msg["type"]) {
				"error" -> {
					val text = msg["message"]?.toString() ?: "unknown error"
					log.warn("server: $text")
					failPending("server returned an error: $text")
				}
				// `project_deleted` is viewer-only — a host socket gets closed with 4001 instead.
				"invite" -> pendingInvite.remove("invite")?.complete(msg)
				"ok" -> pendingInvite.remove("ok")?.complete(msg)
			}
		}
	}

	// --- snapshot ----------------------------------------------------------

	private fun takeSnapshot(conn: WsConnection) {
		val base = root ?: return
		val files = collectFiles(base)
		if (files.size > MAX_FILES) {
			throw FatalException("Sourcebeam: the project has more than $MAX_FILES broadcastable files — add the extras to .gitignore.")
		}

		conn.send(Json.obj("type" to "snapshot_begin"))
		var put = 0
		var skipped = 0
		for ((relPath, file) in files) {
			val entry = readEntry(file, relPath)
			if (entry == null) {
				skipped++
				continue
			}
			conn.send(Json.obj("type" to "file_put", "path" to relPath, "hash" to entry.hash, "content" to entry.content))
			sent.add(relPath)
			put++
		}
		conn.send(Json.obj("type" to "snapshot_end"))
		conn.flush(30_000)
		log.info("snapshot: sent $put, skipped $skipped")
	}

	/**
	 * Walks the project directory, pruning ignored directories instead of descending into them —
	 * without that, a node_modules with 40k files would be visited in full just to drop every
	 * entry. Symlinked entries are pruned the same way: a symlinked directory is never descended
	 * into (both because its contents aren't really part of this project, and because a symlink
	 * cycle back to an ancestor would otherwise recurse without end), and a symlinked file is
	 * never collected.
	 */
	private fun collectFiles(base: VirtualFile): List<Pair<String, VirtualFile>> =
		inReadAction {
			val out = ArrayList<Pair<String, VirtualFile>>()
			val stack = ArrayDeque<Pair<String, VirtualFile>>()
			stack.addLast("" to base)
			while (stack.isNotEmpty()) {
				val (prefix, dir) = stack.removeLast()
				for (child in dir.children ?: emptyArray()) {
					if (!child.isValid || child.`is`(VFileProperty.SYMLINK)) continue
					val rel = if (prefix.isEmpty()) child.name else "$prefix/${child.name}"
					if (child.isDirectory) {
						if (!ignore.ignoresDirectory(rel)) stack.addLast(rel to child)
					} else {
						if (!ignore.ignores(rel)) out.add(rel to child)
						// Bail out early rather than materialising a huge tree just to reject it.
						if (out.size > MAX_FILES) return@inReadAction out
					}
				}
			}
			out
		}

	/** True if `relDir` (posix, relative to root; "" for the root itself) or any ancestor is a
	 * symlink. Only reachable via onCoalesced (the VFS-event path) — collectFiles's full walk
	 * prunes symlinks directly and never needs it. A symlink created after the last snapshot,
	 * pointing outside the project, must not have a file reached through it read and broadcast. */
	private fun hasSymlinkAncestor(base: VirtualFile, relDir: String): Boolean {
		if (relDir.isEmpty()) return false
		symlinkCache[relDir]?.let { return it }
		val parent = relDir.substringBeforeLast('/', "")
		val result = hasSymlinkAncestor(base, parent) || inReadAction {
			base.findFileByRelativePath(relDir)?.`is`(VFileProperty.SYMLINK) == true
		}
		symlinkCache[relDir] = result
		return result
	}

	private class Entry(val content: String, val hash: String)

	/** null means "not broadcastable" — gone, unreadable, binary, oversized, a symlink (or
	 * reachable only through a symlinked ancestor), or policy-rejected. */
	private fun readEntry(file: VirtualFile, relPath: String): Entry? {
		val base = root ?: return null
		val relDir = relPath.substringBeforeLast('/', "")
		if (hasSymlinkAncestor(base, relDir)) return null

		val bytes = try {
			inReadAction {
				if (file.isValid && !file.isDirectory && !file.`is`(VFileProperty.SYMLINK)) file.contentsToByteArray() else null
			}
		} catch (_: Exception) {
			null
		} ?: return null

		val content = decodeUtf8Strict(bytes) ?: run {
			log.debug("$relPath: skipped, not valid UTF-8 (binary)")
			return null
		}
		if (!allowedByPolicy(bytes.size, content, policy)) {
			log.debug("$relPath: skipped, over the size cap or not text")
			return null
		}
		return Entry(content, sha256Hex(bytes))
	}

	// --- change detection --------------------------------------------------

	private fun installVfsListener() {
		val busConnection = project.messageBus.connect()
		busConnection.subscribe(
			VirtualFileManager.VFS_CHANGES,
			object : BulkFileListener {
				override fun after(events: List<VFileEvent>) {
					if (!running) return
					for (event in events) {
						onVfsPath(event.path)
						// A move or rename has to invalidate the old location too, or the file
						// stays mirrored at a path that no longer exists.
						when (event) {
							is VFileMoveEvent -> onVfsPath(event.oldPath)
							is VFilePropertyChangeEvent -> if (event.propertyName == VirtualFile.PROP_NAME) onVfsPath(event.oldPath)
							else -> {}
						}
					}
				}
			},
		)
		vfsConnection = busConnection
		Disposer.register(this, busConnection)
	}

	private fun onVfsPath(absolutePath: String) {
		val base = root ?: return
		val basePath = base.path
		if (absolutePath == basePath) return
		if (!absolutePath.startsWith("$basePath/")) return
		val rel = absolutePath.removePrefix("$basePath/")

		// A deleted directory arrives as a single event, so fan it out over everything we have
		// mirrored beneath it — otherwise those files linger on the server forever.
		val descendants = sent.filter { it.startsWith("$rel/") }
		if (descendants.isNotEmpty()) {
			for (path in descendants) coalescer?.touch(path)
		}
		if (ignore.ignores(rel)) return
		coalescer?.touch(rel)
	}

	private fun onCoalesced(rel: String) {
		// Nothing may hit the wire between snapshot_begin and snapshot_end besides the snapshot's
		// own frames — defer by re-touching until the in-flight snapshot finishes.
		if (snapshotting) {
			coalescer?.touch(rel)
			return
		}
		// Capture the connection before the read: a stop or a reconnect can both happen while it is
		// in flight, and the result must not be sent to a dead or unrelated socket.
		val conn = connection ?: return
		val base = root ?: return

		val file = base.findFileByRelativePath(rel)
		val entry = if (file == null) null else readEntry(file, rel)

		if (conn !== connection) return
		if (entry == null) {
			// Only announce a delete for something the server actually has — otherwise every
			// ignored or binary file that gets touched would generate wire traffic for nothing.
			if (sent.remove(rel)) conn.send(Json.obj("type" to "file_delete", "path" to rel))
		} else {
			conn.send(Json.obj("type" to "file_put", "path" to rel, "hash" to entry.hash, "content" to entry.content))
			sent.add(rel)
		}
	}

	// --- host commands -----------------------------------------------------

	fun mintInvite(): String {
		val conn = connection ?: throw IllegalStateException("Start broadcasting first.")
		val cfg = config ?: throw IllegalStateException("Start broadcasting first.")
		val ttlHours = SourcebeamSettings.getInstance(project).inviteTtlHours
		val future = CompletableFuture<Map<String, Any?>>()
		pendingInvite["invite"] = future
		conn.send(Json.obj("type" to "mint_invite", "ttlSeconds" to ttlHours * 3600))
		val reply = try {
			future.get(10, TimeUnit.SECONDS)
		} catch (e: Exception) {
			pendingInvite.remove("invite")
			throw IllegalStateException(e.cause?.message ?: "timed out waiting for the invite", e)
		}
		val path = reply["url"]?.toString() ?: throw IllegalStateException("the server sent an invite with no url")
		return toHttpUrl(cfg.server).trimEnd('/') + path
	}

	fun revokeInvites() {
		val conn = connection ?: throw IllegalStateException("Start broadcasting first.")
		val future = CompletableFuture<Map<String, Any?>>()
		pendingInvite["ok"] = future
		conn.send(Json.obj("type" to "rotate_view_secret"))
		try {
			future.get(10, TimeUnit.SECONDS)
		} catch (e: Exception) {
			pendingInvite.remove("ok")
			throw IllegalStateException(e.cause?.message ?: "timed out waiting for confirmation", e)
		}
	}

	fun deleteProject() {
		val conn = connection ?: throw IllegalStateException("Start broadcasting first.")
		conn.send(Json.obj("type" to "delete_project"))
		conn.flush(5_000)
		stop()
	}

	private fun failPending(reason: String) {
		for (key in pendingInvite.keys.toList()) {
			pendingInvite.remove(key)?.completeExceptionally(IllegalStateException(reason))
		}
	}

	// --- helpers -----------------------------------------------------------

	private fun sleepInterruptibly(ms: Long, myGen: Int) {
		val deadline = System.currentTimeMillis() + ms
		while (System.currentTimeMillis() < deadline) {
			if (generation.get() != myGen) return
			try {
				Thread.sleep(minOf(200L, deadline - System.currentTimeMillis()).coerceAtLeast(1))
			} catch (_: InterruptedException) {
				Thread.currentThread().interrupt()
				return
			}
		}
	}

	/** Finds every .gitignore under `base`, not just the root one — a nested file (e.g.
	 * apps/web/.gitignore) used to be silently never read, so files it meant to exclude could
	 * still be captured and broadcast. Only prunes `.git` (a full ignore-aware prune is
	 * impossible here — the matcher this feeds doesn't exist yet); everything else, including
	 * directories a shallower .gitignore already excludes, gets walked once to find its own
	 * nested .gitignore, the same tradeoff the VS Code extension makes for the same reason. */
	private fun readGitignoreSources(base: VirtualFile): List<IgnoreMatcher.Source> =
		inReadAction {
			val out = ArrayList<IgnoreMatcher.Source>()
			val stack = ArrayDeque<Pair<String, VirtualFile>>()
			stack.addLast("" to base)
			while (stack.isNotEmpty()) {
				val (prefix, dir) = stack.removeLast()
				for (child in dir.children ?: emptyArray()) {
					if (!child.isValid) continue
					if (child.isDirectory) {
						if (child.name != ".git") stack.addLast((if (prefix.isEmpty()) child.name else "$prefix/${child.name}") to child)
					} else if (child.name == ".gitignore") {
						val text = try {
							decodeUtf8Strict(child.contentsToByteArray())
						} catch (_: Exception) {
							null
						}
						if (text != null) out.add(IgnoreMatcher.Source(prefix, text))
					}
				}
			}
			out
		}

	private fun setStatus(next: BroadcastStatus) {
		status = next
		ApplicationManager.getApplication().invokeLater {
			if (!project.isDisposed) {
				WindowManager.getInstance().getStatusBar(project)?.updateWidget(SourcebeamStatusBarWidget.ID)
				project.messageBus.syncPublisher(SourcebeamStatusListener.TOPIC).statusChanged()
			}
		}
	}

	fun notify(message: String, type: NotificationType) {
		NotificationGroupManager.getInstance()
			.getNotificationGroup("Sourcebeam")
			.createNotification("Sourcebeam", message, type)
			.notify(project)
	}

	companion object {
		fun getInstance(project: Project): BroadcastService = project.service()
	}
}

// 4000: the server replaced this host with a newer connection (project-room.ts closes the old
// one on every new host upgrade). 4001: the project was deleted or its idle TTL expired. Neither
// is transient — reconnecting would either immediately re-evict whichever host caused a 4000 (a
// ping-pong fight between two IDEs pointed at the same project) or just repeat a 4001 against a
// project that no longer exists.
private fun isTerminalCloseCode(code: Int): Boolean = code == 4000 || code == 4001

private fun sha256Hex(bytes: ByteArray): String =
	MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** The directory the project lives in — the JetBrains counterpart of a VS Code workspace folder. */
private fun Project.baseDirectory(): VirtualFile? =
	basePath?.let { com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(it) }

// ReadAction.compute rather than the Kotlin `runReadActionBlocking` helper: that one only exists
// from platform 2026.1, and pluginSinceBuild is 243 — verifyPlugin flagged NoSuchMethodError on
// every 2024.3–2025.3 IDE. 2026.1 deprecates ReadAction.compute in its favour (one deprecation
// warning in verifyPlugin); switch once the minimum supported platform reaches 261.
private fun <T> inReadAction(block: () -> T): T = ReadAction.compute<T, RuntimeException> { block() }
