package com.github.krowten.sourcebeam

/**
 * A minimal JSON encoder/parser for the sourcebeam wire protocol.
 *
 * The platform bundles Gson, but it is not part of the documented plugin API and pinning a second
 * copy risks a classloader clash. The protocol is seven outbound message shapes and eight inbound
 * ones, so the few hundred lines here are cheaper than either gamble — and, unlike the platform
 * classes, they unit-test without an IDE fixture.
 */
object Json {

	// --- encoding ---------------------------------------------------------

	fun escape(value: String): String {
		val out = StringBuilder(value.length + 16)
		for (ch in value) {
			when (ch) {
				'"' -> out.append("\\\"")
				'\\' -> out.append("\\\\")
				'\n' -> out.append("\\n")
				'\r' -> out.append("\\r")
				'\t' -> out.append("\\t")
				'\b' -> out.append("\\b")
				'\u000C' -> out.append("\\f")
				else ->
					// Everything below 0x20 must be escaped. U+2028/U+2029 are legal JSON but break
					// naive JavaScript consumers, so they are escaped too; lone surrogates are left
					// as-is, since the strict UTF-8 decode upstream cannot produce them.
					if (ch < ' ' || ch == '\u2028' || ch == '\u2029') {
						out.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
					} else {
						out.append(ch)
					}
			}
		}
		return out.toString()
	}

	fun obj(vararg fields: Pair<String, Any?>): String =
		fields.joinToString(",", "{", "}") { (key, value) -> "\"${escape(key)}\":${encodeValue(value)}" }

	private fun encodeValue(value: Any?): String = when (value) {
		null -> "null"
		is String -> "\"${escape(value)}\""
		is Boolean -> value.toString()
		is Int, is Long -> value.toString()
		is Double -> if (value.isFinite()) value.toString() else "null"
		else -> "\"${escape(value.toString())}\""
	}

	// --- parsing ----------------------------------------------------------

	/** Parses a JSON object into a map. Returns null for malformed input or a non-object top level. */
	fun parseObject(raw: String): Map<String, Any?>? = try {
		val parser = Parser(raw)
		parser.skipWhitespace()
		val value = parser.readValue()
		parser.skipWhitespace()
		@Suppress("UNCHECKED_CAST")
		if (parser.atEnd() && value is Map<*, *>) value as Map<String, Any?> else null
	} catch (_: Exception) {
		null
	}

	private class Parser(private val src: String) {
		private var pos = 0

		fun atEnd(): Boolean = pos >= src.length

		fun skipWhitespace() {
			while (pos < src.length && src[pos].isWhitespace()) pos++
		}

		fun readValue(): Any? {
			skipWhitespace()
			return when (val c = src[pos]) {
				'{' -> readObject()
				'[' -> readArray()
				'"' -> readString()
				't' -> literal("true", true)
				'f' -> literal("false", false)
				'n' -> literal("null", null)
				else -> if (c == '-' || c.isDigit()) readNumber() else error("unexpected '$c' at $pos")
			}
		}

		private fun literal(text: String, value: Any?): Any? {
			require(src.startsWith(text, pos)) { "bad literal at $pos" }
			pos += text.length
			return value
		}

		private fun readObject(): Map<String, Any?> {
			pos++ // '{'
			val map = LinkedHashMap<String, Any?>()
			skipWhitespace()
			if (src[pos] == '}') {
				pos++
				return map
			}
			while (true) {
				skipWhitespace()
				val key = readString()
				skipWhitespace()
				require(src[pos] == ':') { "expected ':' at $pos" }
				pos++
				map[key] = readValue()
				skipWhitespace()
				when (src[pos]) {
					',' -> pos++
					'}' -> {
						pos++
						return map
					}

					else -> error("expected ',' or '}' at $pos")
				}
			}
		}

		private fun readArray(): List<Any?> {
			pos++ // '['
			val list = ArrayList<Any?>()
			skipWhitespace()
			if (src[pos] == ']') {
				pos++
				return list
			}
			while (true) {
				list.add(readValue())
				skipWhitespace()
				when (src[pos]) {
					',' -> pos++
					']' -> {
						pos++
						return list
					}

					else -> error("expected ',' or ']' at $pos")
				}
			}
		}

		private fun readString(): String {
			require(src[pos] == '"') { "expected string at $pos" }
			pos++
			val out = StringBuilder()
			while (true) {
				when (val c = src[pos++]) {
					'"' -> return out.toString()
					'\\' -> when (val esc = src[pos++]) {
						'"' -> out.append('"')
						'\\' -> out.append('\\')
						'/' -> out.append('/')
						'n' -> out.append('\n')
						'r' -> out.append('\r')
						't' -> out.append('\t')
						'b' -> out.append('\b')
						'f' -> out.append('\u000C')
						'u' -> {
							out.append(src.substring(pos, pos + 4).toInt(16).toChar())
							pos += 4
						}

						else -> error("bad escape '\\$esc' at $pos")
					}

					else -> out.append(c)
				}
			}
		}

		private fun readNumber(): Any {
			val start = pos
			if (src[pos] == '-') pos++
			while (pos < src.length && (src[pos].isDigit() || src[pos] in ".eE+-")) pos++
			val text = src.substring(start, pos)
			return text.toLongOrNull() ?: text.toDouble()
		}
	}
}

/** Reads a numeric field as Int regardless of whether it arrived as a Long or a Double. */
fun Map<String, Any?>.intField(key: String): Int? = when (val v = this[key]) {
	is Long -> v.toInt()
	is Int -> v
	is Double -> v.toInt()
	else -> null
}

fun Map<String, Any?>.stringList(key: String): List<String> =
	(this[key] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
