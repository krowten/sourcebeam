package com.github.krowten.sourcebeam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonTest {

	@Test
	fun `encodes a file_put frame`() {
		val frame = Json.obj("type" to "file_put", "path" to "src/a.ts", "hash" to "ab12", "content" to "x")
		assertEquals("""{"type":"file_put","path":"src/a.ts","hash":"ab12","content":"x"}""", frame)
	}

	@Test
	fun `escapes what would otherwise break the frame`() {
		assertEquals("""a\"b""", Json.escape("a\"b"))
		assertEquals("""a\\b""", Json.escape("a\\b"))
		assertEquals("""line1\nline2""", Json.escape("line1\nline2"))
		assertEquals("""a\tb""", Json.escape("a\tb"))
		assertEquals("""\u0000""", Json.escape("\u0000"))
		assertEquals("""\u001f""", Json.escape("\u001F"))
		assertEquals("""\f""", Json.escape("\u000C"))
		assertEquals("""\u2028""", Json.escape("\u2028"))
	}

	@Test
	fun `round-trips file content through encode and parse`() {
		val content = "const s = \"tab\\there\";\n// ünïcode ✓\r\n\u0007bell"
		val frame = Json.obj("type" to "file_put", "content" to content)
		val parsed = Json.parseObject(frame)!!
		assertEquals(content, parsed["content"])
	}

	@Test
	fun `parses a policy frame`() {
		val raw = """{"type":"policy","maxBytes":524288,"extensions":["ts","md"],"names":["Dockerfile"]}"""
		val msg = Json.parseObject(raw)!!
		assertEquals("policy", msg["type"])
		assertEquals(524288, msg.intField("maxBytes"))
		assertEquals(listOf("ts", "md"), msg.stringList("extensions"))
		assertEquals(listOf("Dockerfile"), msg.stringList("names"))
	}

	@Test
	fun `parses an invite frame`() {
		val msg = Json.parseObject("""{"type":"invite","url":"/p/demo?token=1.ab","expiresAt":1790000000}""")!!
		assertEquals("/p/demo?token=1.ab", msg["url"])
		assertEquals(1790000000, msg.intField("expiresAt"))
	}

	@Test
	fun `handles nested structures and escapes on the way in`() {
		val msg = Json.parseObject("""{"a":{"b":[1,"two",null,true]},"c":"xAy\/z"}""")!!
		@Suppress("UNCHECKED_CAST")
		val a = msg["a"] as Map<String, Any?>
		assertEquals(listOf(1L, "two", null, true), a["b"])
		assertEquals("xAy/z", msg["c"])
	}

	@Test
	fun `rejects malformed input instead of throwing`() {
		assertNull(Json.parseObject("{"))
		assertNull(Json.parseObject("not json"))
		assertNull(Json.parseObject("[1,2]"))
		assertNull(Json.parseObject(""))
		assertNull(Json.parseObject("""{"a":1}trailing"""))
	}

	@Test
	fun `parses unicode escapes including surrogate pairs`() {
		val msg = Json.parseObject("""{"a":"\u0041","emoji":"\ud83d\ude00","raw":"😀"}""")!!
		assertEquals("A", msg["a"])
		assertEquals("😀", msg["emoji"])
		assertEquals("😀", msg["raw"])
	}

	@Test
	fun `parses negative, decimal and exponent numbers`() {
		val msg = Json.parseObject("""{"neg":-5,"dec":1.5,"exp":1e3}""")!!
		assertEquals(-5L, msg["neg"])
		assertEquals(1.5, msg["dec"])
		assertEquals(1000.0, msg["exp"])
		assertEquals(-5, msg.intField("neg"))
		assertEquals(1, msg.intField("dec"))
		assertEquals(1000, msg.intField("exp"))
	}

	@Test
	fun `duplicate keys keep the last value`() {
		assertEquals("b", Json.parseObject("""{"k":"a","k":"b"}""")!!["k"])
	}

	@Test
	fun `empty containers and heavy whitespace parse`() {
		val msg = Json.parseObject(" \t\n{ \"a\" : { } , \"b\" : [ ] }\r\n ")!!
		assertEquals(emptyMap<String, Any?>(), msg["a"])
		assertEquals(emptyList<Any?>(), msg["b"])
	}

	@Test
	fun `more malformed inputs return null instead of throwing`() {
		assertNull(Json.parseObject("""{"a":}"""))
		assertNull(Json.parseObject("""{"a" 1}"""))
		assertNull(Json.parseObject("""{"a":"unterminated"""))
		assertNull(Json.parseObject("""{"a":"\x"}"""))
		assertNull(Json.parseObject("""{"n":1e}"""))
		assertNull(Json.parseObject("""{'a':1}"""))
	}

	@Test
	fun `encodes every scalar shape the protocol uses`() {
		val frame = Json.obj(
			"s" to "x", "n" to null, "b" to true, "i" to 42, "l" to 42L, "d" to 1.5,
			"nan" to Double.NaN,
		)
		assertEquals("""{"s":"x","n":null,"b":true,"i":42,"l":42,"d":1.5,"nan":null}""", frame)
	}

	@Test
	fun `stringList drops non-string entries instead of failing`() {
		val msg = Json.parseObject("""{"a":["x",1,null,"y"],"b":"not a list"}""")!!
		assertEquals(listOf("x", "y"), msg.stringList("a"))
		assertEquals(emptyList<String>(), msg.stringList("b"))
		assertEquals(emptyList<String>(), msg.stringList("missing"))
	}

	@Test
	fun `intField returns null for missing or non-numeric values`() {
		val msg = Json.parseObject("""{"s":"42"}""")!!
		assertNull(msg.intField("s"))
		assertNull(msg.intField("missing"))
	}

	@Test
	fun `escaped output is itself parseable for a pathological payload`() {
		// A file that contains the frame delimiters is the obvious way to break a hand-rolled
		// encoder, so assert the round trip explicitly.
		val nasty = """{"type":"file_delete","path":"../../etc/passwd"}"""
		val parsed = Json.parseObject(Json.obj("content" to nasty))!!
		assertEquals(nasty, parsed["content"])
		assertTrue(parsed.size == 1)
	}
}
