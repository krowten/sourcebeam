package com.github.krowten.sourcebeam.integration

import com.github.krowten.sourcebeam.Json
import com.github.krowten.sourcebeam.stringList
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.WebSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

const val SERVER_URL = "ws://localhost:4173"
const val HTTP_URL = "http://localhost:4173"

/** A viewer as the browser page would be one: follows the invite link for its cookie, then opens
 * the viewer socket and records every message the server sends it. */
class TestViewer private constructor() {
	val messages = CopyOnWriteArrayList<Map<String, Any?>>()
	val closeCode = CompletableFuture<Int>()
	private lateinit var socket: WebSocket

	/** Every path the viewer's tree_update messages have added so far. */
	fun added(): List<String> = messages.filter { it["type"] == "tree_update" }.flatMap { it.stringList("added") }

	fun removed(): List<String> = messages.filter { it["type"] == "tree_update" }.flatMap { it.stringList("removed") }

	fun firstTree(): List<String>? = messages.firstOrNull { it["type"] == "tree" }?.stringList("paths")

	fun subscribe(path: String) {
		socket.sendText(Json.obj("type" to "subscribe", "path" to path), true).get(5, TimeUnit.SECONDS)
	}

	fun close() {
		runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "test done").get(2, TimeUnit.SECONDS) }
		socket.abort()
	}

	private val listener = object : WebSocket.Listener {
		private val buffer = StringBuilder()

		override fun onOpen(webSocket: WebSocket) {
			webSocket.request(1)
		}

		override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
			buffer.append(data)
			if (last) {
				Json.parseObject(buffer.toString())?.let { messages.add(it) }
				buffer.setLength(0)
			}
			webSocket.request(1)
			return null
		}

		override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
			closeCode.complete(statusCode)
			return null
		}

		override fun onError(webSocket: WebSocket, error: Throwable) {
			closeCode.complete(1006)
		}
	}

	companion object {
		private val http: HttpClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()

		/** Mirrors the browser following an invite link: the token-for-cookie exchange in
		 * worker/routing.ts, without loading the page itself. */
		fun cookieFor(inviteUrl: String): String {
			val response = http.send(HttpRequest.newBuilder(URI.create(inviteUrl)).GET().build(), HttpResponse.BodyHandlers.discarding())
			val setCookie = response.headers().firstValue("set-cookie").orElseThrow {
				AssertionError("invite exchange did not set a cookie (status ${response.statusCode()})")
			}
			return setCookie.substringBefore(';')
		}

		fun connect(project: String, cookie: String): TestViewer {
			// The listener only touches the WebSocket it is handed, never `socket`, so callbacks
			// arriving before buildAsync's future completes are safe.
			val viewer = TestViewer()
			viewer.socket = http.newWebSocketBuilder()
				.header("Cookie", cookie)
				.buildAsync(URI.create("$SERVER_URL/ws/$project"), viewer.listener)
				.get(10, TimeUnit.SECONDS)
			return viewer
		}
	}
}
