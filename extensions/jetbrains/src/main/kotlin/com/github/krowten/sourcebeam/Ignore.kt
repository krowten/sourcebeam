package com.github.krowten.sourcebeam

/**
 * gitignore matching.
 *
 * The VS Code extension gets this from the `ignore` npm package; there is no equivalent on the
 * platform side that works without the Git plugin, so the subset of gitignore(5) the project
 * actually needs is implemented here:
 *
 *  - blank lines and `#` comments are skipped; `\#` escapes a leading hash;
 *  - trailing whitespace is stripped unless escaped with a backslash;
 *  - `!` negates, and the LAST matching rule wins;
 *  - a trailing `/` restricts the rule to directories;
 *  - a `/` anywhere but the end anchors the rule to the repository root, otherwise the rule
 *    matches the basename at any depth;
 *  - `*` matches within one path segment, `**` spans segments, `?` matches one non-slash
 *    character, and `[...]` is passed through as a character class.
 *
 * Ignoring a directory ignores everything under it, so each path is also tested against its own
 * ancestor prefixes — without that, `node_modules/` would not exclude `node_modules/x/y.js`.
 *
 * A project can have more than one .gitignore — [parseNested] folds a root file together with
 * any nested ones (e.g. `apps/web/.gitignore`) into a single matcher, each scoped to its own
 * directory: a nested file's rules are only tested against paths under its own directory,
 * rebased relative to it, mirroring git's per-directory .gitignore semantics. A file is excluded
 * if any applicable level, root down to its containing directory, matches it. Cross-level
 * negation (a nested file un-ignoring something a parent excluded) isn't modeled — that only
 * errs toward excluding a touch more than git would, never toward leaking a file a shallower
 * rule meant to keep out.
 */
class IgnoreMatcher private constructor(private val levels: List<Level>) {

	private class Rule(val regex: Regex, val negated: Boolean, val directoryOnly: Boolean)
	private class Level(val dir: String, val rules: List<Rule>)

	/** dir: posix path (relative to the project root) of the directory containing that
	 * .gitignore — "" for the root itself. */
	data class Source(val dir: String, val text: String)

	/** @param relPath posix-relative path of a file. */
	fun ignores(relPath: String): Boolean = isIgnored(relPath, isDirectory = false)

	/**
	 * Same test for a directory, so the traversal can prune instead of descending. Without it a
	 * `node_modules/` rule would still cost a full walk of everything underneath.
	 */
	fun ignoresDirectory(relPath: String): Boolean = isIgnored(relPath, isDirectory = true)

	private fun isIgnored(relPath: String, isDirectory: Boolean): Boolean {
		if (isHardBlocked(relPath)) return true
		for (level in levels) {
			if (level.dir.isNotEmpty() && !relPath.startsWith("${level.dir}/")) continue
			val sub = if (level.dir.isEmpty()) relPath else relPath.removePrefix("${level.dir}/")
			if (sub.isNotEmpty() && isIgnoredByLevel(level.rules, sub, isDirectory)) return true
		}
		return false
	}

	private fun isIgnoredByLevel(rules: List<Rule>, relPath: String, isDirectory: Boolean): Boolean {
		if (rules.isEmpty()) return false

		// Test every ancestor directory first, then the entry itself: a directory rule that matches
		// an ancestor hides the whole subtree, and a later negation can bring it back.
		val segments = relPath.split('/')
		var ignored = false
		for (i in segments.indices) {
			val candidate = segments.subList(0, i + 1).joinToString("/")
			val lastSegment = i == segments.lastIndex
			val candidateIsDirectory = !lastSegment || isDirectory
			for (rule in rules) {
				if (rule.directoryOnly && !candidateIsDirectory) continue
				if (rule.regex.matches(candidate)) ignored = !rule.negated
			}
			// git never descends into an ignored directory, so a negation deeper inside it cannot
			// resurrect the entry — stop as soon as an ancestor directory is excluded.
			if (ignored && !lastSegment) return true
		}
		return ignored
	}

	companion object {
		fun parse(gitignoreText: String?): IgnoreMatcher = IgnoreMatcher(listOf(Level("", compileRules(gitignoreText))))

		fun parseNested(sources: List<Source>): IgnoreMatcher =
			IgnoreMatcher(sources.map { Level(it.dir, compileRules(it.text)) })

		private fun compileRules(gitignoreText: String?): List<Rule> {
			if (gitignoreText.isNullOrEmpty()) return emptyList()
			return gitignoreText.split(Regex("\r?\n")).mapNotNull { compile(it) }
		}

		private fun compile(rawLine: String): Rule? {
			var line = stripTrailingSpaces(rawLine)
			if (line.isEmpty() || line.startsWith("#")) return null

			val negated = line.startsWith("!")
			if (negated) line = line.substring(1)
			if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.substring(1)
			if (line.isEmpty()) return null

			val directoryOnly = line.endsWith("/")
			if (directoryOnly) line = line.dropLast(1)
			if (line.isEmpty()) return null

			// A slash anywhere except the (already removed) trailing one anchors to the root.
			val anchored = line.contains('/')
			if (line.startsWith("/")) line = line.substring(1)

			val body = globToRegex(line)
			val pattern = if (anchored) body else "(?:.*/)?$body"
			return Rule(Regex(pattern), negated, directoryOnly)
		}

		/** Trailing spaces are not part of a pattern unless the last one is backslash-escaped. */
		private fun stripTrailingSpaces(line: String): String {
			var end = line.length
			while (end > 0 && line[end - 1] == ' ' && (end < 2 || line[end - 2] != '\\')) end--
			return line.substring(0, end).replace("\\ ", " ")
		}

		private fun globToRegex(glob: String): String {
			val out = StringBuilder()
			var i = 0
			while (i < glob.length) {
				when (val c = glob[i]) {
					'*' -> {
						val doubled = i + 1 < glob.length && glob[i + 1] == '*'
						if (doubled) {
							// `**/` spans zero or more directories; a bare `**` spans anything.
							if (i + 2 < glob.length && glob[i + 2] == '/') {
								out.append("(?:.*/)?")
								i += 3
								continue
							}
							out.append(".*")
							i += 2
							continue
						}
						out.append("[^/]*")
					}

					'?' -> out.append("[^/]")

					'[' -> {
						val close = glob.indexOf(']', i + 1)
						if (close < 0) {
							out.append("\\[")
						} else {
							// Character classes are close enough between glob and regex to pass
							// through, with gitignore's `!` negation rewritten to regex's `^`.
							val cls = glob.substring(i + 1, close)
							out.append('[').append(if (cls.startsWith("!")) "^" + cls.substring(1) else cls).append(']')
							i = close + 1
							continue
						}
					}

					'\\' -> {
						if (i + 1 < glob.length) {
							out.append(Regex.escape(glob[i + 1].toString()))
							i += 2
							continue
						}
						out.append("\\\\")
					}

					else -> out.append(Regex.escape(c.toString()))
				}
				i++
			}
			return out.toString()
		}
	}
}
