import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.models.ProductRelease
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode

plugins {
	id("java")
	id("org.jetbrains.kotlin.jvm") version "2.4.10"
	id("org.jetbrains.intellij.platform") version "2.18.1"
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
	}
}
