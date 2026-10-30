import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.models.ProductRelease
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode

plugins {
	id("java")
	id("org.jetbrains.kotlin.jvm") version "2.4.21"
	id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
	mavenCentral()
	intellijPlatform {
		defaultRepositories()
	}
}

dependencies {
	intellijPlatform {
		create(
			providers.gradleProperty("platformType"),
			providers.gradleProperty("platformVersion"),
		)
		testFramework(TestFrameworkType.Platform)
		// Unified IntelliJ IDEA (2025.3+) can't open a test project without its ultimate module on
		// the test classpath — the same line JetBrains' own plugin template carries.
		testBundledPlugins("com.intellij.modules.ultimate")
	}
	// kotlin.stdlib.default.dependency=false: the platform ships its own stdlib, and bundling a
	// second copy is the classic source of "class file version" conflicts at runtime.
	testImplementation(kotlin("test"))
	testImplementation("junit:junit:4.13.2")
}

kotlin {
	jvmToolchain(21)
	compilerOptions {
		// Without this, Kotlin emits compatibility bridges in every class implementing a platform
		// interface (ToolWindowFactory's getIcon/getAnchor/manage…), and verifyPlugin counts each
		// bridge as overriding an @ApiStatus.Internal method and fails the task.
		jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
	}
}

intellijPlatform {
	pluginConfiguration {
		name = providers.gradleProperty("pluginName")
		version = providers.gradleProperty("pluginVersion")
		changeNotes =
			"""
			<h3>0.1.5</h3>
			<ul>
				<li>Starting a broadcast against a server that can't be reached, or that isn't a
				Sourcebeam server (an HTTP 404 and the like), now stops it with an error naming the
				address and the reason, instead of retrying silently.</li>
				<li>Copy Invite Link, Revoke Invite Links and Delete Project are enabled only once the
				broadcast is connected. Before, Copy Invite Link could report "Failed to get an invite
				— Start broadcasting first." while broadcasting was on.</li>
				<li>After a connection that was live drops, reconnecting starts again from the
				shortest wait. Before, every drop in a long session waited longer than the last, up
				to 30 s.</li>
				<li>A broadcast that gives up (rejected token, project taken over) releases its file
				listener.</li>
				<li>Server update (<code>bun run deploy</code>): a viewer's tab shows "no access" right
				away when you revoke invite links, and closing a connection from the client side no
				longer takes ~10 s.</li>
			</ul>
			<h3>0.1.4</h3>
			<ul>
				<li>Renaming or moving a folder while broadcasting now updates the viewer: the files
				under the new path are sent along with the old ones being removed.</li>
			</ul>
			<h3>0.1.3</h3>
			<ul>
				<li>Built against IntelliJ Platform 2026.2 and verified on every supported IDE from
				2024.3 to 2026.2.</li>
				<li>Server update (<code>bun run deploy</code>): the viewer moves to SvelteKit 3 with
				updated dependencies, and the server no longer logs an error when a viewer closes its
				tab while a reply is on the way.</li>
			</ul>
			<h3>0.1.2</h3>
			<ul>
				<li>Editing a .gitignore while broadcasting now takes effect at once: files it newly
				excludes are removed from the server, files it no longer excludes are sent.</li>
				<li>Plain ws:// server URLs are accepted only for localhost; anything else needs
				wss://, so code and the host token never travel unencrypted.</li>
			</ul>
			<h3>0.1.1</h3>
			<ul>
				<li>Invite links: the lifetime setting now limits how long a link can be opened. A
				viewer who opened it in time stays in the project until you revoke invite links or
				delete the project. Needs the matching server update (<code>bun run deploy</code>).</li>
				<li>The viewer page reconnects on its own after a network drop, and shows "no
				access" or "deleted" once access is gone for good (server update).</li>
				<li>No deprecated platform API usage left on 2026.1 and newer.</li>
			</ul>
			<h3>0.1.0</h3>
			<p>Initial release.</p>
			<ul>
				<li>Broadcast the open project to a read-only live viewer: every text file the
				project's .gitignore doesn't exclude, up to the server's size cap, with invite links
				and a status bar widget.</li>
				<li>A Sourcebeam tool window (View | Tool Windows | Sourcebeam): server, project id,
				host token and live/reconnecting/off status at a glance, each clickable. The toolbar
				covers start/stop, invite management and a settings shortcut; Delete Project stays
				in the Tools | Sourcebeam menu on purpose — not a one-click toolbar button.</li>
				<li>Every setting on one page (Settings | Tools | Sourcebeam). Server URL and host
				token are shared by all projects; the project id and invite link lifetime are
				per-project, defaulting to the folder name and 6 hours.</li>
			</ul>
			""".trimIndent()
		ideaVersion {
			sinceBuild = providers.gradleProperty("pluginSinceBuild")
			untilBuild = provider { null }
		}
	}
	pluginVerification {
		// The plugin declares only `com.intellij.modules.platform`, so the Marketplace already
		// lists it as compatible with every product on that platform version — recommended()
		// alone only checks it against the one we compile against. Select a representative
		// spread of product families explicitly so verifyPlugin actually catches a
		// non-platform API creeping in before it reaches users of other IDEs.
		// IntellijIdeaCommunity/IntellijIdeaUltimate are deprecated as of platform 2025.3 —
		// IntelliJ IDEA is a single unified edition now (still the IU product code).
		ides {
			select {
				types = listOf(
					IntelliJPlatformType.IntellijIdea,
					IntelliJPlatformType.PyCharmCommunity,
					IntelliJPlatformType.PyCharmProfessional,
					IntelliJPlatformType.WebStorm,
					IntelliJPlatformType.PhpStorm,
					IntelliJPlatformType.Rider,
					IntelliJPlatformType.GoLand,
					IntelliJPlatformType.CLion,
					IntelliJPlatformType.RubyMine,
					IntelliJPlatformType.RustRover,
				)
				channels = listOf(ProductRelease.Channel.RELEASE)
				sinceBuild = providers.gradleProperty("pluginSinceBuild")
			}
		}
	}
}

tasks {
	wrapper {
		gradleVersion = providers.gradleProperty("gradleVersion").get()
	}
	test {
		useJUnit()
		// The plugin against a real server (src/test/.../integration) needs the local preview server
		// on :4173 (`bun run --cwd apps/web preview`): `./gradlew test -Pintegration` runs only those,
		// plain `./gradlew test` everything else. One task rather than a separate testIde one, so the
		// sandbox the tests load the plugin from is always rebuilt from the current sources.
		if (providers.gradleProperty("integration").isPresent) {
			filter { includeTestsMatching("com.github.krowten.sourcebeam.integration.*") }
		} else {
			exclude("com/github/krowten/sourcebeam/integration/**")
		}
	}
}
