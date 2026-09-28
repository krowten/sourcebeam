package com.github.krowten.sourcebeam

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

const val COALESCE_MS = 300L
const val MAX_FILES = 500
const val RECONNECT_MIN_MS = 1000L
const val RECONNECT_MAX_MS = 30_000L

fun nextReconnectDelay(current: Long): Long = minOf(current * 2, RECONNECT_MAX_MS)

/**
 * Per-path coalescing: a burst of VFS events on the same path (a save plus the IDE's own
 * post-write refresh, a git checkout, a formatter run) collapses into one fire after [delayMs] of
 * silence on that path.
 *
 * This is the load-bearing part of the whole client: a watcher that re-reads on every event can
 * re-trigger itself through its own reads and flood the server. Coalescing plus "only re-read on
 * a settled path" is what keeps an idle project at zero frames (see the README for the history).
 */
class Coalescer(private val delayMs: Long, private val onFire: (String) -> Unit) {
	private val timers = ConcurrentHashMap<String, ScheduledFuture<*>>()
	private val scheduler: ScheduledExecutorService =
		Executors.newSingleThreadScheduledExecutor { runnable ->
			Thread(runnable, "sourcebeam-coalescer").apply { isDaemon = true }
		}

	fun touch(key: String) {
		timers.put(
			key,
			scheduler.schedule({
				timers.remove(key)
				onFire(key)
			}, delayMs, TimeUnit.MILLISECONDS),
		)?.cancel(false)
	}

	fun cancelAll() {
		for (timer in timers.values) timer.cancel(false)
		timers.clear()
	}

	fun dispose() {
		cancelAll()
		scheduler.shutdownNow()
	}
}
