# Sourcebeam for VS Code

Live code sharing from VS Code to the browser, read-only. The extension broadcasts the files
in your open workspace to a page that anyone with an invite link can watch update each time
you save. Nothing runs in a terminal; the Sourcebeam icon in the Activity Bar, the Command
Palette and the status bar drive everything. Good for teaching, mentoring, code walkthroughs
and review sessions where the audience only needs to watch. The server is one you deploy
yourself, on your own Cloudflare account.

![Viewer page, light theme](https://raw.githubusercontent.com/krowten/sourcebeam/main/assets/viewer-light.png)

Requires **VS Code ≥ 1.101** (Help → About) and a running sourcebeam deployment. The
[self-hosting guide](https://github.com/krowten/sourcebeam/blob/main/docs/self-hosting.md#one-command-deploy)
shows how to stand one up with a single command.

## 1. Install

Open the Extensions view (`Ctrl+Shift+X`), search for **Sourcebeam** and press **Install**.

## 2. Set up

Click the Sourcebeam icon in the Activity Bar, then **Settings…** in its panel (or the gear icon
in the panel's title bar). One form holds every setting:

- **Server URL** — the `wss://` URL printed by `bun run deploy`. Global: one value for every
  workspace.
- **Project id** — lowercase letters, digits, `-` and `_`. Per-workspace, so each folder you open
  keeps its own; left blank, it defaults to the folder's name, sanitized.
- **Invite link lifetime (hours)** — how long a new link can be opened; per-workspace, 6
  unless you change it. Viewers who already joined aren't affected.
- **Host token** — paste the token from the deploy summary and press **Save**; leave the field
  blank to keep the current one. Saved per server URL and shared by every workspace, in VS
  Code's encrypted `SecretStorage`, never in `settings.json`.

A person broadcasting several projects doesn't need a token per project — mint one per
**person** instead (`bun run token new "name"` on the server, see
[docs/self-hosting.md](https://github.com/krowten/sourcebeam/blob/main/docs/self-hosting.md#managing-host-tokens)).
Don't share it: whoever holds it can broadcast under your project id and delete it.

Prefer the Command Palette (`Ctrl+Shift+P`)? **Sourcebeam: Set Server URL**, **Sourcebeam: Set
Project** and **Sourcebeam: Set Host Token** do the same one field at a time. In
`settings.json`, `sourcebeam.serverUrl` goes in User settings; `sourcebeam.project` and
`sourcebeam.inviteTtlHours` go in the workspace's settings.

## 3. The Sourcebeam panel

Four rows, one click each:

- **Project** — change the project id;
- **Start Broadcasting** / **Stop Broadcasting**;
- **Copy Invite Link**;
- **Settings…** — the form above, which also holds **Revoke Invite Links** and **Delete
  Project**.

The panel's title bar has the same actions as icons (they show when the mouse is over the
panel): play / stop for **Start** / **Stop Broadcasting**, a link for **Copy Invite Link**, a
circle with a slash for **Revoke Invite Links**, and a gear for **Settings**. Delete Project
has no icon on purpose — one click is too easy for it.

While you're broadcasting, a small badge sits on the Sourcebeam icon in the Activity Bar, and
the status bar shows `sourcebeam: live` (or `reconnecting`); clicking it stops broadcasting.
Every action is also in the Command Palette under **Sourcebeam:**.

## 4. Broadcast and share

1. Open the project folder you want to share.
2. Press **Start Broadcasting**. The status bar shows `live` once connected, and the project's
   files go out right after.
3. Press **Copy Invite Link** (it works while broadcasting). The link carries a signed token
   that can be opened for the invite link lifetime; send it to whoever should watch. Whoever
   opens it in time stays in the project, even in a tab reopened days later, until you revoke
   invite links or delete the project.

Every file you save shows up for viewers within about a second, and autosave works too.
**Stop Broadcasting** (row, title-bar icon or status bar) disconnects; viewers keep seeing the last
broadcast state.

Two actions need broadcasting to be running:

- **Revoke Invite Links** (title-bar icon, Settings form or Command Palette) invalidates every
  link issued so far and disconnects everyone watching — for the day a link ends up somewhere
  it shouldn't have.
- **Delete Project** (Settings form → Danger zone, or the Command Palette) permanently deletes
  the project and its files on the server, after a confirmation. Viewers are disconnected and
  old links stop working.

## What gets sent

Every text file your project's `.gitignore` doesn't exclude, whatever its extension — there is
no separate ignore file to maintain. That includes `.env` files and keys, so list the ones that
must stay private in `.gitignore`. Nothing under `.git/` is ever sent.

- Editing a `.gitignore` while broadcasting takes effect at once: files it now excludes are
  removed from the server, files it no longer excludes are sent.
- Binaries are skipped (not valid UTF-8, or containing NUL bytes).
- Files over 512 KB are skipped; the server publishes this cap on connect.
- A project with more than 500 files left after `.gitignore` is refused rather than uploaded —
  add the extras to `.gitignore` and start again.

## Privacy

- **Where data goes.** The extension connects to one place only: the server URL you configure.
  That server is your own deployment, running on your own Cloudflare account, so Cloudflare
  processes the data as your hosting provider. Nothing is sent to the extension's author.
- **What is sent, and when.** Only while you're broadcasting, and only the files described in
  [What gets sent](#what-gets-sent). Project files can contain personal data; keep anything that
  must stay private out of the broadcast with `.gitignore`.
- **Who can read it.** Viewers you give an invite link to, and whoever administers the
  Cloudflare account the server runs on. **Revoke Invite Links** removes every viewer at once.
- **How long it's kept.** The server keeps the last broadcast files after you stop, so viewers
  still see them. **Delete Project** removes them; the server can also be configured to delete
  projects that sit idle (see the self-hosting guide).
- **No telemetry**, analytics or usage tracking of any kind.
- The host token stays in VS Code's encrypted `SecretStorage` and only goes to your server.
- The source is public under the MIT license:
  [github.com/krowten/sourcebeam](https://github.com/krowten/sourcebeam).

## Good to know

- **Something wrong?** View → Output → the **sourcebeam** channel says why a file was skipped
  or a connection failed.
- Network drops aren't fatal: the extension reconnects on its own, showing
  `sourcebeam: reconnecting` in the status bar while it does.
