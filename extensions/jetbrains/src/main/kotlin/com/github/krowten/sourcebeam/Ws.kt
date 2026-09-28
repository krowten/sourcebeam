package com.github.krowten.sourcebeam

import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.net.http.WebSocketHandshakeException
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.CompletionStage
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Marks an error the reconnect loop must not retry — a rejected token, or a project too large. */
class FatalException(message: String) : RuntimeException(message)

/**
 * One WebSocket connection to the sourcebeam Worker.
 *
 * Built on `java.net.http.WebSocket` (JDK 11+, present in every JetBrains runtime) rather than a
 * bundled client, which also solves the problem the VS Code extension had to work around by hand:
 * a failed handshake here throws [WebSocketHandshakeException], carrying the HTTP response, so a
 * 403 from a bad host token is distinguishable from a transient network failure without a second
 * probe request.
 */
class WsConnection private constructor(
	private val socket: WebSocket,
	private val incoming: LinkedBlockingQueue<String>,
	private val closed: AtomicBoolean,
	private val closeLatch: CountDownLatch,
	private val closeCodeRef: java.util.concurrent.atomic.AtomicInteger,
) {
	// java.net.http.WebSocket forbids a second sendText() before the previous one's future
	// completes. Every send is therefore chained onto the last, which also preserves frame order —
	// snapshot_begin ... file_put ... snapshot_end must arrive in exactly that sequence.
	private var sendChain: CompletableFuture<WebSocket> = CompletableFuture.completedFuture(socket)
	private val sendLock = Any()

	val isClosed: Boolean get() = closed.get()

	fun send(text: String) {
		synchronized(sendLock) {
			sendChain = sendChain.thenCompose { ws -> ws.sendText(text, true) }
		}
	}

	/** Blocks until every queued frame has been handed to the transport, or the timeout expires. */
	fun flush(timeoutMs: Long) {
		val chain = synchronized(sendLock) { sendChain }
		runCatching { chain.get(timeoutMs, TimeUnit.MILLISECONDS) }
	}

	/** Next inbound frame, or null if none arrived within [timeoutMs]. */
	fun poll(timeoutMs: Long): String? = incoming.poll(timeoutMs, TimeUnit.MILLISECONDS)

	/** Blocks until the peer closes the socket or [close] is called, then returns the WS close
	 * code — 1006 (abnormal closure) for a local [close]/onError with no code of its own, the
	 * standard convention for "the socket ended without a proper close frame". */
	fun awaitClose(): Int {
		closeLatch.await()
		return closeCodeRef.get()
	}

	fun close() {
		if (closed.getAndSet(true)) return
		runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "bye") }
		runCatching { socket.abort() }
		closeLatch.countDown()
	}

	companion object {
		private val client: HttpClient by lazy {
			HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
		}

		/**
		 * @throws FatalException when the server answers 403 — a wrong host token, which retrying
		 *   cannot fix.
		 */
		fun connect(url: String, token: String): WsConnection {
			val incoming = LinkedBlockingQueue<String>()
			// Created before the listener so a close arriving during the handshake is recorded
			// rather than lost against a not-yet-assigned connection object.
			val closed = AtomicBoolean(false)
			val closeLatch = CountDownLatch(1)
			// 1006 (abnormal closure): the RFC 6455 placeholder for "the connection ended without
			// carrying its own close code" — the outcome for a local close() or onError.
			val closeCodeRef = java.util.concurrent.atomic.AtomicInteger(1006)

			fun markClosed() {
				if (!closed.getAndSet(true)) closeLatch.countDown()
			}

			val listener = object : WebSocket.Listener {
				// Text frames may arrive in fragments; accumulate until `last`.
				private val buffer = StringBuilder()

				override fun onOpen(webSocket: WebSocket) {
					webSocket.request(1)
				}

				override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
					buffer.append(data)
					if (last) {
						incoming.offer(buffer.toString())
						buffer.setLength(0)
					}
					webSocket.request(1)
					return null
				}

				override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
					closeCodeRef.set(statusCode)
					markClosed()
					return null
				}

				override fun onError(webSocket: WebSocket, error: Throwable) {
					markClosed()
				}
			}

			val socket = try {
				client.newWebSocketBuilder()
					.header("Authorization", "Bearer $token")
					.connectTimeout(Duration.ofSeconds(10))
					.buildAsync(URI.create(url), listener)
					.get(20, TimeUnit.SECONDS)
			} catch (e: Exception) {
				val cause = if (e is CompletionException || e is ExecutionException) e.cause else e
				val status = (cause as? WebSocketHandshakeException)?.response?.statusCode()
				if (status == 403) {
					throw FatalException(
						"Server rejected the connection: HTTP 403 (invalid host token). " +
							"Set it via \"Sourcebeam: Set Host Token\" — retrying will not help.",
					)
				}
				throw RuntimeException("websocket handshake failed" + (status?.let { " (status $it)" } ?: ""), cause)
			}

			return WsConnection(socket, incoming, closed, closeLatch, closeCodeRef)
		}
	}
}
