# Contributing

Issues and pull requests are welcome. This page is the practical minimum; `AGENTS.md` holds
the same conventions in more detail. Taking part means following the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

[Bun](https://bun.sh) ≥ 1.2 is the only prerequisite for the TypeScript side:

```sh
bun install
```

The JetBrains plugin (`extensions/jetbrains`) is a separate Kotlin/Gradle build and needs
JDK 21; its Gradle wrapper downloads everything else.

## Tests

```sh
bun test --cwd packages/protocol                   # protocol + policy + invite signing
bun run --cwd apps/web test:unit -- --run          # viewer UI logic (vitest, browser mode)
bun run --cwd apps/web test:do                     # ProjectRoom Durable Object (workers pool)
bun run --cwd apps/web test:e2e                    # Playwright against a real wrangler dev
bun run --cwd extensions/vscode test               # extension unit tests
bun run --cwd extensions/vscode test:integration   # real VS Code host; needs a display
cd extensions/jetbrains && ./gradlew test          # Kotlin policy/ignore/codec tests
```

Use the package scripts rather than retyping the commands they contain. Several carry flags
that matter; the VS Code `test` script, for one, excludes `tests/integration/**`, which
cannot run outside an editor.

Checks that must be green before a PR: the suites above plus `bun run --cwd apps/web check`
(svelte-check) and `bun run --cwd apps/web lint` (prettier + eslint).

## Conventions

- Functions over classes unless the platform demands one (Durable Objects do).
- `type` over `interface` unless something needs declaration merging.
- Svelte 5 runes, remote functions instead of `+server.ts` routes, no `load` functions.
- Comments explain what the code can't say itself.

## VS Code extension internals

This is the host side of the wire protocol (types in [packages/protocol](packages/protocol)),
built on native vscode APIs: the snapshot comes from `workspace.findFiles` + `workspace.fs`,
and change detection from `onDidSaveTextDocument` + `FileSystemWatcher` through a shared
300 ms coalescer. Ignore rules come from the `ignore` package; message types and
`DEFAULT_POLICY` come from `@sourcebeam/protocol` (a workspace dependency, bundled in).
`src/core.ts` holds the pure, testable logic: policy filter, ignore matcher, config
validation. `src/extension.ts` is the vscode glue, covering `SecretStorage` for the token,
the `serverUrl`/`project`/`inviteTtlHours` settings, and the invite/revoke/delete commands.
`stop()` guarantees full silence: it cancels every pending coalescer timer, aborts any
in-flight backoff wait, disposes subscriptions, and closes the WebSocket.

`src/sidebar.ts` is the Activity Bar view: a `vscode.TreeDataProvider` built as a factory
function (not a class — the interface doesn't require one) over a `getState()` callback that
`extension.ts` supplies. It has no state of its own; `extension.ts` calls the returned
`refresh()` whenever status, running or project changes (see `sidebarRefresh` and every call
site of `setStatus()`). Deliberately only 4 rows — project, start/stop, copy invite link,
and a `moreActions()` QuickPick catch-all for server URL, host token, invite TTL, revoke and
delete — everything infrequent or global lives one level down instead of turning the panel
into a wall of buttons. `media/sidebar-icon.png` is a raster crop of the real lantern mark
(rays included) — same source as
[extensions/jetbrains/src/main/resources/META-INF/pluginIcon.svg](extensions/jetbrains/src/main/resources/META-INF/pluginIcon.svg),
regenerate from there if the brand mark changes. Two other directions got tried and reverted:
stripping the rays out of the crop, and redrawing it as a plain codicon-style outline glyph
(via nano-banana-pro/edit) to match the Activity Bar's other monochrome icons more closely —
both looked worse in practice than the original full crop, even after VS Code's masking
flattens it to one theme color. Status isn't a row — `sidebarView.badge` (`badgeFor()`) puts
a small badge directly on that icon while live/reconnecting, since VS Code has no API to swap
a view container's icon at runtime.

`sourcebeam.project` is `"scope": "window"` in `package.json`, written via
`ConfigurationTarget.Workspace` from `pickProject()`, so each workspace keeps its own —
mirroring the JetBrains plugin's per-project `.idea/sourcebeam.xml`. `sourcebeam.serverUrl` is
`"scope": "application"`: one value for every workspace, User settings only. The host token is
one `SecretStorage` entry per server origin, shared by every workspace: it identifies a
*person*, not a project, so one person broadcasting several projects from one machine needs one
token, not one per project — see `bun run token` in the root `scripts/`. The JetBrains plugin
does the same (application-level server URL, one PasswordSafe entry per origin).

```sh
cd extensions/vscode
bun install && bun test   # unit tests for core.ts
bun run typecheck         # tsc: src (@types/node + vscode) and tests (+ bun) checked separately
bun run build             # bun build → dist/extension.js (CJS, vscode external)
bun run package           # build + vsce → the .vsix
```

Transport is the global `WebSocket` available in Node ≥ 22 with the undici-style
`{ headers }` option (not the WHATWG constructor). We verified empirically on Node 24/26
that `Authorization` reaches the server this way. `engines.vscode ^1.101` is the first
VS Code version bundling Node 22.

## JetBrains plugin internals

The code splits into platform-free logic (`Policy.kt`, `Ignore.kt`, `Json.kt`,
`Coalescer.kt`, `Ws.kt`) and the IDE integration (`BroadcastService.kt`, `Actions.kt`, the
settings, status bar and tool window). Only the first half is unit-tested. It is also the
half that has to stay byte-compatible with `packages/protocol`.

`src/main/kotlin/.../ToolWindow.kt` is the Activity Bar counterpart of the VS Code
extension's sidebar (View | Tool Windows | Sourcebeam): a `SimpleToolWindowPanel` whose
toolbar is a `DefaultActionGroup` built from five of the seven actions already defined once
in `plugin.xml` — Start/Stop, Copy Invite, Revoke Invites, Settings — plus three body rows
(project id, status, host token). Delete Project deliberately stays off that toolbar: a
one-click icon button is the wrong place for "destroy everything", so it stays one level
down in the pre-existing Tools | Sourcebeam menu. Project id and host token are the opposite
case — the two things a first-time user must set before anything works, so plain read-only
labels pointing at a menu path turned out to be a real usability dead end (nothing to click,
no indication the menu even existed). Both are now `ActionLink`s: the project row always
opens Settings | Tools | Sourcebeam (`ShowSettingsUtil.showSettingsDialog`, same as the new
toolbar gear icon, `Sourcebeam.OpenSettings`), and the token row runs
`setHostTokenInteractive()` — the password dialog logic factored out of `SetHostTokenAction`
so both the menu action and the tool window link share one implementation. This is the same
shape of decision as the VS Code sidebar's always-clickable rows, just resolved with what
JetBrains already gives you (a Configurable + a menu) instead of QuickPicks and input boxes.
`SourcebeamStatusListener` (declared in `BroadcastService.kt`) is a project-level message bus
topic `setStatus()` publishes on; the tool window panel, `SourcebeamConfigurable.apply()` and
`setHostTokenInteractive()` are its subscribers/publishers today, but it's the general hook
for "something the tool window should reflect changed" rather than a one-off callback. The
toolbar icons (`AllIcons.Actions.Execute`/`Suspend`/`Copy`/`Cancel`,
`AllIcons.General.Settings`) are platform icons referenced by name in `plugin.xml`, not
bundled assets — reusing the IDE's own icon set is the idiomatic choice here, the same way
the action `text`/`description` values already were.
`src/main/resources/icons/sourcebeamToolWindow.svg` (+ `_dark.svg`) is a hand-drawn 13×13
outline glyph, not a
crop of the full-color lantern mark: JetBrains tool window icons are simple single-color
pictograms by convention (`#6C707E` light / `#CED0D6` dark), and a detailed illustration
would be unrecognizable at that size regardless.

**Trusted Projects.** Unlike VS Code, which disables an extension outright in Restricted
Mode unless it opts in via `capabilities.untrustedWorkspaces`, the IntelliJ Platform doesn't
disable plugins wholesale for an untrusted project — only specific actions that could run
unreviewed code unexpectedly (build script auto-import being the canonical example) are
gated behind `TrustedProjects.isTrusted()`. Verified empirically, not just from the docs: the
plugin's tool window, actions and status bar widget all stayed active and functional with a
project opened via "Preview in Safe Mode". Sourcebeam only ever reads files through the same
filters it applies before broadcasting and never executes anything from the project, so there
was nothing to gate — no `isTrusted()` check appears anywhere in this codebase on purpose.

```sh
cd extensions/jetbrains
./gradlew test          # pure-logic unit tests: policy, gitignore matching, JSON codec
./gradlew buildPlugin   # the installable zip
./gradlew runIde        # sandboxed IDE with the plugin
./gradlew verifyPlugin  # JetBrains' compatibility checks (downloads IDEs, slow)
```

Two things in here are load-bearing and easy to break:

- **Coalescing.** A burst of VFS events on one path collapses into a single re-read after
  300 ms of quiet. An earlier watcher in this project re-read files on every event, and its
  own reads re-triggered the watcher, which burned a full day of Cloudflare quota in half an
  hour.
- **The generation counter** in `BroadcastService`. Both start and stop bump it, so a loop
  still unwinding from a previous run sees itself as stale and cannot clobber the state a
  newer run already owns. Removing it brings back two live broadcast loops after a fast
  stop-then-start.

## Releasing

The VS Code extension and the JetBrains plugin share the wire protocol, so they are versioned
and released together, from one tag. What ships to a marketplace is exactly the artifact CI
attached to the GitHub Release, never a local build.

1. Bump the version and write the release notes:

   ```sh
   bun run bump-version 0.2.0   # extensions/vscode/package.json + extensions/jetbrains/gradle.properties
   ```

   then add a heading to `extensions/vscode/CHANGELOG.md` and a bullet to the `changeNotes`
   block in `extensions/jetbrains/build.gradle.kts`.
   For the JetBrains plugin, also run `./gradlew verifyPlugin` from `extensions/jetbrains`. It
   checks the plugin against every supported IDE version, not just the one it compiles against,
   and catches platform APIs that don't exist yet in the oldest supported release — neither the
   build nor the tests can see those. The first run downloads a few dozen IDEs (tens of GB) into
   the Gradle cache; later runs take a couple of minutes.
2. Commit, push to `main`, then push a tag: `v0.2.0`.
3. `release.yml` checks the tag against both versions, builds the `.vsix` and the `.zip`,
   attaches both to one GitHub Release for that tag, and publishes those same files to the
   marketplaces with `scripts/publish.ts`. Publishing runs only for a marketplace whose token
   is in the repository secrets — `VSCE_PAT`, `OVSX_PAT`, `JETBRAINS_TOKEN` (Settings →
   Secrets and variables → Actions); without them the release stops at the GitHub Release.

To publish by hand instead — before the secrets are set, or to retry a failed upload — run the
same script locally (needs the `gh` CLI, signed in):

```sh
VSCE_PAT=... OVSX_PAT=... bun run release:publish vscode 0.2.0
JETBRAINS_TOKEN=... bun run release:publish jetbrains 0.2.0
```

It downloads the file from the release and uploads it as-is — never a local build. Add
`--dry-run` to download and check it without uploading. For VS Code, set either token or
both — a marketplace whose token is missing is skipped.

### One-time setup: VS Code

Two separate registries, two separate accounts and tokens — Microsoft's Marketplace only
serves VS Code itself; Cursor, Windsurf, VSCodium and other forks install from
[Open VSX](https://open-vsx.org) instead, since Microsoft's Marketplace terms restrict it to
VS Code proper.

- **Marketplace**: create the `krowten` publisher at
  [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and get
  an Azure DevOps PAT scoped to "Marketplace: Manage" — that's `VSCE_PAT`.
- **Open VSX**: sign in at [open-vsx.org](https://open-vsx.org) (GitHub or Eclipse account),
  generate a PAT — that's `OVSX_PAT` — and claim the namespace once:
  `bunx ovsx create-namespace krowten` with `OVSX_PAT` exported.

### One-time setup: JetBrains

One registry — [plugins.jetbrains.com](https://plugins.jetbrains.com) — not two: JetBrains
Marketplace serves every IntelliJ Platform IDE (PyCharm, WebStorm, GoLand, IntelliJ IDEA and
the rest) from a single listing, since they all run the same plugin host.

- Sign in with a JetBrains Account and upload the **first** version by hand at
  [plugins.jetbrains.com/plugin/add](https://plugins.jetbrains.com/plugin/add), using the zip
  from its GitHub Release — the upload API only updates an existing listing, it can't create
  one (that's also where license and repository URL get set). It goes through a manual review
  (JetBrains quotes up to two working days); later versions are published right away.
- Generate a token on your Marketplace profile's "My Tokens" page — that's `JETBRAINS_TOKEN`.
  Add it to the repository secrets only after that first upload: until the listing exists, an
  automatic upload from `release.yml` would just fail.

No separate signing step: `signPlugin` only runs when `signPlugin.certificateChain` /
`signPlugin.privateKey` are configured, which they deliberately aren't here — JetBrains
Marketplace signs the uploaded artifact itself if the author didn't, at the cost of an extra
"unsigned by the author" notice in the IDE's install dialog. Setting up an author certificate
is the kind of thing worth doing once there's an actual user base to protect, not before.

## The one structural rule

`packages/protocol` is the source of truth for the wire protocol and the file policy. The
JetBrains plugin duplicates both in Kotlin (`Policy.kt`, `Json.kt` and friends) because it
can't consume a TypeScript package. So: **any change to `packages/protocol` must be mirrored
there in the same PR**, covered by the matching Kotlin test.
