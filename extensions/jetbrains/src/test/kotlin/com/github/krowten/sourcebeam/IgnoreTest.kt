package com.github.krowten.sourcebeam

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IgnoreTest {

	private fun matcher(vararg lines: String) = IgnoreMatcher.parse(lines.joinToString("\n"))

	@Test
	fun `no rules ignores nothing except git internals`() {
		val ig = IgnoreMatcher.parse(null)
		assertFalse(ig.ignores("src/main.ts"))
		assertFalse(ig.ignores(".env"))
		assertTrue(ig.ignores(".git/config"))
	}

	@Test
	fun `basename rules match at any depth`() {
		val ig = matcher("node_modules")
		assertTrue(ig.ignores("node_modules/x.js"))
		assertTrue(ig.ignores("apps/web/node_modules/y/z.js"))
		assertTrue(ig.ignoresDirectory("node_modules"))
		assertFalse(ig.ignores("src/node_modules_helper.ts"))
	}

	@Test
	fun `a leading slash anchors to the root`() {
		val ig = matcher("/dist")
		assertTrue(ig.ignores("dist/app.js"))
		assertFalse(ig.ignores("packages/protocol/dist/app.js"))
	}

	@Test
	fun `a trailing slash restricts the rule to directories`() {
		val ig = matcher("build/")
		assertTrue(ig.ignores("build/out.js"))
		assertTrue(ig.ignoresDirectory("build"))
		// A *file* called "build" is not covered by a directory-only rule.
		assertFalse(ig.ignores("build"))
	}

	@Test
	fun `star does not cross a path separator`() {
		val ig = matcher("*.log")
		assertTrue(ig.ignores("server.log"))
		assertTrue(ig.ignores("logs/server.log"))
		assertFalse(ig.ignores("server.log.ts"))
	}

	@Test
	fun `double star spans directories`() {
		val ig = matcher("docs/**/tmp")
		assertTrue(ig.ignores("docs/tmp"))
		assertTrue(ig.ignores("docs/a/b/tmp"))
		assertFalse(ig.ignores("other/docs/a/tmp"))
	}

	@Test
	fun `question mark matches exactly one character`() {
		val ig = matcher("file?.txt")
		assertTrue(ig.ignores("file1.txt"))
		assertFalse(ig.ignores("file12.txt"))
		assertFalse(ig.ignores("file.txt"))
	}

	@Test
	fun `the last matching rule wins so negation re-includes`() {
		val ig = matcher("*.log", "!keep.log")
		assertTrue(ig.ignores("server.log"))
		assertFalse(ig.ignores("keep.log"))
	}

	@Test
	fun `a negation cannot resurrect a file inside an ignored directory`() {
		// This is real git behaviour: git never descends into an excluded directory.
		val ig = matcher("build/", "!build/keep.txt")
		assertTrue(ig.ignores("build/keep.txt"))
	}

	@Test
	fun `comments and blank lines are skipped`() {
		val ig = matcher("# a comment", "", "   ", "*.tmp")
		assertTrue(ig.ignores("x.tmp"))
		assertFalse(ig.ignores("a comment"))
	}

	@Test
	fun `an escaped hash is a literal pattern`() {
		val ig = matcher("\\#weird")
		assertTrue(ig.ignores("#weird"))
	}

	@Test
	fun `trailing whitespace is stripped unless escaped`() {
		assertTrue(matcher("*.tmp   ").ignores("x.tmp"))
		assertTrue(matcher("with\\ space").ignores("with space"))
	}

	@Test
	fun `character classes work`() {
		val ig = matcher("report[0-9].txt")
		assertTrue(ig.ignores("report1.txt"))
		assertFalse(ig.ignores("reportX.txt"))
	}

	@Test
	fun `env files are excluded exactly when gitignore says so, git internals always`() {
		val ig = matcher(".env*\n!.env.example\n!.git/config")
		assertTrue(ig.ignores(".env"))
		assertTrue(ig.ignores("apps/web/.env.local"))
		assertFalse(ig.ignores(".env.example"))
		assertTrue(ig.ignores(".git/config"))
	}

	@Test
	fun `a nested path rule is anchored`() {
		val ig = matcher("apps/web/dist")
		assertTrue(ig.ignores("apps/web/dist/index.js"))
		assertFalse(ig.ignores("other/apps/web/dist/index.js"))
	}

	@Test
	fun `a leading double star matches at the root too`() {
		val ig = matcher("**/tmp")
		assertTrue(ig.ignores("tmp"))
		assertTrue(ig.ignores("a/b/tmp"))
		assertFalse(ig.ignores("tmpfile"))
	}

	@Test
	fun `a trailing double star spans everything under the prefix`() {
		val ig = matcher("gen/**")
		assertTrue(ig.ignores("gen/a.ts"))
		assertTrue(ig.ignores("gen/deep/b.ts"))
		assertFalse(ig.ignores("regen/a.ts"))
	}

	@Test
	fun `question mark does not cross a path separator`() {
		val ig = matcher("a?c")
		assertTrue(ig.ignores("abc"))
		assertFalse(ig.ignores("a/c"))
	}

	@Test
	fun `an escaped bang is a literal pattern`() {
		val ig = matcher("\\!important")
		assertTrue(ig.ignores("!important"))
		assertFalse(ig.ignores("important"))
	}

	@Test
	fun `an unclosed bracket is treated as a literal character`() {
		val ig = matcher("a[b")
		assertTrue(ig.ignores("a[b"))
		assertFalse(ig.ignores("ab"))
	}

	@Test
	fun `a negated character class works`() {
		val ig = matcher("file[!0-9].txt")
		assertTrue(ig.ignores("fileX.txt"))
		assertFalse(ig.ignores("file1.txt"))
	}

	@Test
	fun `lines that reduce to nothing produce no rules`() {
		// "!" alone, "/" alone and a bare backslash must not throw or match anything.
		val ig = matcher("!", "/", "\\")
		assertFalse(ig.ignores("src/main.ts"))
	}

	@Test
	fun `crlf line endings parse like lf`() {
		val ig = IgnoreMatcher.parse("dist/\r\n*.log\r\n")
		assertTrue(ig.ignores("dist/bundle.js"))
		assertTrue(ig.ignores("app.log"))
		assertFalse(ig.ignores("src/main.ts"))
	}

	@Test
	fun `a single star in an anchored rule stays within one segment`() {
		val ig = matcher("docs/*.md")
		assertTrue(ig.ignores("docs/a.md"))
		assertFalse(ig.ignores("docs/sub/a.md"))
		assertFalse(ig.ignores("other/docs/a.md"))
	}

	@Test
	fun `unicode file names match literal rules`() {
		val ig = matcher("заметки.md")
		assertTrue(ig.ignores("заметки.md"))
		assertTrue(ig.ignores("докиand/заметки.md"))
	}

	@Test
	fun `parseNested folds in a nested gitignore, scoped to its own directory`() {
		val ig = IgnoreMatcher.parseNested(
			listOf(
				IgnoreMatcher.Source("", "dist/\n*.log"),
				IgnoreMatcher.Source("apps/web", "*.secret\n.env.local"),
			),
		)
		assertTrue(ig.ignores("dist/bundle.js")) // root rule
		assertTrue(ig.ignores("apps/web/config.secret")) // nested rule, own subtree
		assertTrue(ig.ignores("apps/web/.env.local"))
		assertFalse(ig.ignores("other/config.secret")) // same pattern, different subtree
		assertFalse(ig.ignores("apps/web/src/main.ts"))
		assertFalse(ig.ignores(".env")) // no rule excludes it at the root
	}

	@Test
	fun `parseNested keeps a nested unanchored pattern scoped to its own subtree`() {
		val ig = IgnoreMatcher.parseNested(listOf(IgnoreMatcher.Source("pkg", "build")))
		assertTrue(ig.ignores("pkg/build"))
		assertTrue(ig.ignores("pkg/nested/build")) // unanchored, matches at any depth *within pkg*
		assertFalse(ig.ignores("build")) // outside the nested gitignore's own directory
		assertFalse(ig.ignores("other/build"))
	}

	@Test
	fun `parseNested with no sources ignores only git internals`() {
		val ig = IgnoreMatcher.parseNested(emptyList())
		assertFalse(ig.ignores("src/main.ts"))
		assertFalse(ig.ignores(".env"))
		assertTrue(ig.ignores(".git/HEAD"))
	}
}
