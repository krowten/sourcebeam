package com.github.krowten.sourcebeam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/protocol/src/policy.spec.ts — the two implementations must agree. */
class PolicyTest {

	private fun allowed(path: String, size: Int = 10, content: String = "x") =
		!isHardBlocked(path) && allowedByPolicy(size, content, DEFAULT_POLICY)

	@Test
	fun `any text file passes, whatever its name or extension`() {
		for (name in listOf("src/main.py", "Dockerfile", ".gitignore", ".prettierrc", ".editorconfig", "LICENSE", "notes.weird-ext", "icon.svg", "weird.", "доки/заметки.md")) {
			assertTrue(name, allowed(name, content = "{}"))
		}
	}

	@Test
	fun `binary content is rejected - a NUL byte or a lossy-decode marker`() {
		assertFalse(allowed("image.png", content = "PNG\u0000data"))
		assertFalse(allowed("a.txt", content = "hello�world"))
	}

	@Test
	fun `size cap - exactly at maxBytes passes, one over does not, a smaller server cap is honored`() {
		assertTrue(allowed("a.ts", DEFAULT_POLICY.maxBytes))
		assertFalse(allowed("a.ts", DEFAULT_POLICY.maxBytes + 1))
		assertFalse(allowedByPolicy(11, "x", FilePolicy(maxBytes = 10)))
	}

	@Test
	fun `empty content at zero bytes is allowed`() {
		assertTrue(allowedByPolicy(0, "", DEFAULT_POLICY))
	}

	@Test
	fun `strict utf8 decode rejects invalid bytes`() {
		assertEquals("héllo", decodeUtf8Strict("héllo".toByteArray(Charsets.UTF_8)))
		// 0xFF is not a valid UTF-8 lead byte — the marker of a binary file.
		assertNull(decodeUtf8Strict(byteArrayOf(0x68, 0xFF.toByte(), 0x69)))
	}

	@Test
	fun `git must be a whole path segment to hard-block`() {
		assertTrue(isHardBlocked(".git/config"))
		assertTrue(isHardBlocked("deep/.git/hooks/pre-commit.sh"))
		assertFalse(isHardBlocked("a.git/b.ts"))
		assertFalse(isHardBlocked(".github/workflows/ci.yml"))
		assertFalse(isHardBlocked("src/.gitignore"))
	}

	@Test
	fun `env, keys and token files are the project's call via gitignore, not blocked here`() {
		for (name in listOf(".env", "a/b/.env.production", ".env.example", "certs/localhost.pem", "id_rsa", ".npmrc")) {
			assertFalse(name, isHardBlocked(name))
			assertTrue(name, allowed(name, content = "x=1"))
		}
	}
}
