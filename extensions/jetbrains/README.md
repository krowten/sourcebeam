# Sourcebeam for JetBrains IDEs

Live code sharing from IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider and the rest of the
JetBrains family to the browser, read-only. This is the host side of
[sourcebeam](../../README.md): the plugin snapshots the open project, streams
every change to your Worker over one WebSocket, and hands you a link viewers open in a
browser. Where Code With Me shares a whole collaborative session, this shares a read-only
view: nobody edits, nothing executes, viewers just watch the code change live.

Feature parity with [the VS Code extension](../vscode/README.md): the wire protocol, the
file policy and the host commands all match. A project can be broadcast from either editor,
and nothing on the server knows the difference.

## Requirements

- IntelliJ Platform 2024.3 (build 243) or newer, any product.
- A deployed sourcebeam Worker and a host token; see the root README's self-host quickstart.

## Install

From [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34643-sourcebeam):
**Settings/Preferences | Plugins | Marketplace**, search for `Sourcebeam`, **Install**. Or use
**Install to IDE** on the Marketplace page.

For an offline install or a specific version, download `sourcebeam-jetbrains-<version>.zip`
from [GitHub Releases](https://github.com/krowten/sourcebeam/releases), then
**Settings/Preferences | Plugins | ⚙ | Install Plugin from Disk…**, pick the zip and restart
the IDE.

Building it yourself works the same way as the zip route — see
[CONTRIBUTING.md](https://github.com/krowten/sourcebeam/blob/main/CONTRIBUTING.md).

## Setup

Open **Settings | Tools | Sourcebeam** — or the Sourcebeam tool window (View | Tool Windows |
Sourcebeam) and click its **Server** or **Project** link. Everything is on one page:

- **Server URL** — the `wss://` URL printed by `bun run deploy`. Shared by every project you
  open in this IDE.
- **Project id** — lowercase letters, digits, `-` and `_`, can't start with `-` or `_`.
  Per-project; left blank, it defaults to the project's folder name, sanitized.
- **Invite link lifetime (hours)** — how long a new link can be opened; per-project, 6
  unless you change it. Viewers who already joined aren't affected.
- **Host token** — **Set…** asks for the token from the deploy summary and saves it for the
  server URL typed above (no need to press Apply first), shared by every project. It goes into
  the IDE password safe (the OS keychain where there is one), never into a settings file, so a
  committed `.idea/` cannot leak it.

A person broadcasting several projects doesn't need a token per project — mint one per
**person** instead (`bun run token new "name"` on the server, see
[docs/self-hosting.md](../../docs/self-hosting.md#managing-host-tokens)).

## Use

The **Sourcebeam tool window** is the main place to work from:

- its toolbar has **Start** / **Stop Broadcasting**, **Copy Invite Link**, **Revoke Invite
  Links** and **Settings**;
- its body shows the **Server**, **Project**, broadcast **Status** and whether a **Host token**
  is set. Server and Project open the settings page, Host token opens the token dialog.

The **status bar widget** (`Sourcebeam: live` / `reconnecting` / `off`) starts or stops
broadcasting with one click. Every action is also under **Tools | Sourcebeam**, which is the
only place **Delete Project…** lives: a one-click toolbar icon is the wrong place for it.

| Action | What it does |
| --- | --- |
| Start Broadcasting | Snapshots the project, then streams every change |
| Stop Broadcasting | Disconnects; viewers keep seeing the last broadcast state |
| Copy Invite Link | Mints a viewer link that can be opened for the invite link lifetime and copies it; whoever opens it stays in the project until you revoke invites |
| Revoke Invite Links | Invalidates every link handed out and disconnects current viewers |
| Settings… | Opens Settings \| Tools \| Sourcebeam |
| Set Host Token… | Stores the token in the password safe |
| Delete Project… | After a confirmation, deletes the project and its files on the server |

Copy Invite Link, Revoke and Delete need broadcasting to be running. If something goes wrong, an IDE notification
says why.

## What gets sent

Three filters, in order:

1. **Git internals.** Nothing under `.git/` is ever sent. That's the only fixed rule — `.env`
   files and keys are sent unless `.gitignore` excludes them.
2. **The project's `.gitignore`.** Full gitignore semantics: negation, anchoring,
   directory-only rules, `**`. Ignored directories are pruned during the walk, so a
   `node_modules` costs nothing.
3. **Text only, within a size cap.** Any text file passes, whatever its extension; binaries
   (not valid UTF-8, or containing NUL bytes) are skipped, and so are files over 512 KB — a cap
   the Worker publishes as the first frame of every connection.

A project over 500 broadcastable files is refused rather than uploaded; add the extras to
`.gitignore`.

Contributing to the plugin itself? See [CONTRIBUTING.md](https://github.com/krowten/sourcebeam/blob/main/CONTRIBUTING.md)
in the main repository.
