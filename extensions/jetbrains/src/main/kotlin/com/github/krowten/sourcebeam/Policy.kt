package com.github.krowten.sourcebeam

/**
 * File policy — a Kotlin port of packages/protocol/src/policy.ts. Every text file the project's
 * .gitignore doesn't exclude is broadcast; the rules below are the only other filter, and they
 * must match the TypeScript ones: a client stricter than the server merely skips files, a looser
 * one sends files the server will reject.
 *
 * The server sends its size cap as the first frame of every connection, so [DEFAULT_POLICY] is
 * only the fallback used until that frame arrives (or if it never does).
 */
data class FilePolicy(val maxBytes: Int)

val DEFAULT_POLICY = FilePolicy(maxBytes = 524_288)

/**
 * The one rule .gitignore can't override: git's own internals (any `.git` path segment) are never
 * project content. Everything else — `.env`, keys, tokens — is the project's call, made in its
 * .gitignore. Mirrors `isHardBlocked` in policy.ts (which the VS Code extension imports directly).
 */
fun isHardBlocked(relPath: String): Boolean = relPath.split('/').contains(".git")

/**
 * Text means decodable as UTF-8 and free of NUL bytes — git's own binary heuristic. The decode
 * itself is strict (see [decodeUtf8Strict]); a U+FFFD left in the content is the same
 * belt-and-braces check the other clients do, and NUL is valid UTF-8, so it needs its own.
 */
fun isText(content: String): Boolean = !content.contains('\uFFFD') && !content.contains('\u0000')

fun allowedByPolicy(byteLength: Int, content: String, policy: FilePolicy): Boolean =
	byteLength <= policy.maxBytes && isText(content)

/**
 * Strict UTF-8 decode: returns null for anything that is not valid UTF-8, which is how binary
 * files are filtered out before they are ever hashed or sent.
 */
fun decodeUtf8Strict(bytes: ByteArray): String? {
	val decoder = Charsets.UTF_8.newDecoder()
	return try {
		decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
	} catch (_: java.nio.charset.CharacterCodingException) {
		null
	}
}
