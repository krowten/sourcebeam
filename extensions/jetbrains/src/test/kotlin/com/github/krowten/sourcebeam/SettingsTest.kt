package com.github.krowten.sourcebeam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SettingsTest {

	@Test
	fun `validateServerUrl accepts a bare ws(s) origin, normalizes a trailing slash away`() {
		assertEquals("wss://sourcebeam.example.workers.dev", validateServerUrl("wss://sourcebeam.example.workers.dev"))
		assertEquals("ws://localhost:8787", validateServerUrl("ws://localhost:8787"))
		assertEquals("wss://h", validateServerUrl("wss://h/"))
		assertEquals("wss://h", validateServerUrl("  wss://h  "))
	}

	@Test
	fun `validateServerUrl rejects anything beyond a bare origin`() {
		assertThrows(IllegalArgumentException::class.java) { validateServerUrl("not a url") }
		assertThrows(IllegalArgumentException::class.java) { validateServerUrl("http://h") }
		assertThrows(IllegalArgumentException::class.java) { validateServerUrl("https://h") }
		assertThrows(IllegalArgumentException::class.java) { validateServerUrl("wss://h/some/path") }
		assertThrows(IllegalArgumentException::class.java) { validateServerUrl("wss://h?x=1") }
		assertThrows(IllegalArgumentException::class.java) { validateServerUrl("wss://h#frag") }
		assertThrows(IllegalArgumentException::class.java) { validateServerUrl("wss://user:pass@h") }
	}

	@Test
	fun `validateConfig normalizes the server to a bare origin and rejects a path-query-creds server`() {
		assertEquals("wss://h", validateConfig("wss://h/", "demo", "t").server)
		assertThrows(IllegalArgumentException::class.java) { validateConfig("wss://h/x", "demo", "t") }
		assertThrows(IllegalArgumentException::class.java) { validateConfig("http://h", "demo", "t") }
	}

	@Test
	fun `sanitizeProjectId lowercases and replaces disallowed characters`() {
		assertEquals("my-project", sanitizeProjectId("My Project"))
		assertEquals("myrepo42", sanitizeProjectId("MyRepo42"))
		assertEquals("a-b-c", sanitizeProjectId("a.b.c"))
		assertEquals("already_valid-id", sanitizeProjectId("already_valid-id"))
	}

	@Test
	fun `sanitizeProjectId strips a leading hyphen or underscore, since isValidProjectId forbids it`() {
		assertEquals("project-name", sanitizeProjectId("-project-name"))
		assertEquals("project-name", sanitizeProjectId("_project-name"))
		assertEquals("project-name", sanitizeProjectId("--__project-name"))
	}

	@Test
	fun `sanitizeProjectId falls back to a fixed name when nothing usable survives`() {
		assertEquals("project", sanitizeProjectId(""))
		assertEquals("project", sanitizeProjectId("---"))
		assertEquals("project", sanitizeProjectId("___"))
	}

	@Test
	fun `sanitizeProjectId output always satisfies isValidProjectId`() {
		for (name in listOf("My Project", "", "---", "already_valid-id", "日本語", "a".repeat(200))) {
			assertEquals(true, isValidProjectId(sanitizeProjectId(name)))
		}
	}
}
