package com.github.krowten.sourcebeam.integration

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** A TCP proxy between the plugin and the local Worker, so a test can cut the host's connection
 * the way a network failure does (a reset, no close frame) and hold its reconnect attempts while
 * it changes files on disk. Viewers keep connecting to the Worker directly. */
class TestProxy(private val targetPort: Int = 4173) : AutoCloseable {
	private val loopback = InetAddress.getByName("127.0.0.1")
	private val server = ServerSocket(0, 50, loopback)
	private val sockets = ConcurrentHashMap.newKeySet<Socket>()
	private val threads = ConcurrentHashMap.newKeySet<Thread>()
	private val accepted = AtomicInteger()
	private val lock = Any()
	private var held: MutableList<Socket>? = null

	val url = "ws://127.0.0.1:${server.localPort}"

	/** Connections accepted so far, held ones included. */
	val attempts: Int get() = accepted.get()

	init {
		threads += thread(isDaemon = true, name = "sourcebeam-test-proxy") {
			while (!server.isClosed) {
				val client = runCatching { server.accept() }.getOrNull() ?: break
				sockets.add(client)
				accepted.incrementAndGet()
				val queued = synchronized(lock) { held?.add(client) == true }
				if (!queued) forward(client)
			}
		}
	}

	/** Resets every open connection on both sides. */
	fun drop() {
		for (socket in sockets) {
			sockets.remove(socket)
			runCatching {
				socket.setSoLinger(true, 0)
				socket.close()
			}
		}
	}

	/** New connections are accepted but not forwarded until [release], so a handshake just waits. */
	fun hold() = synchronized(lock) { if (held == null) held = ArrayList() }

	fun release() {
		val queue = synchronized(lock) { held.also { held = null } }
		queue?.forEach(::forward)
	}

	/** Waits for its threads too: the platform test case fails a test that leaves threads behind. */
	override fun close() {
		server.close()
		drop()
		threads.forEach { it.join(5_000) }
	}

	private fun forward(client: Socket) {
		if (client.isClosed) return
		val upstream = runCatching { Socket(loopback, targetPort) }.getOrElse {
			client.close()
			return
		}
		sockets.add(upstream)
		pipe(client, upstream)
		pipe(upstream, client)
	}

	private fun pipe(from: Socket, to: Socket) {
		threads += thread(isDaemon = true, name = "sourcebeam-test-proxy-pipe") {
			runCatching { from.getInputStream().transferTo(to.getOutputStream()) }
			runCatching { to.shutdownOutput() }
		}
	}
}
