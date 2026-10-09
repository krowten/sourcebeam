# Changelog

## 0.1.2

- Editing a `.gitignore` while broadcasting now takes effect at once: files it newly excludes
  are removed from the server, files it no longer excludes are sent. Before, the rules were
  read only when broadcasting started.
- Plain `ws://` server URLs are accepted only for `localhost`; anything else needs `wss://`, so
  code and the host token never travel unencrypted.
- A clearer Privacy section: where the data goes, who can read it and how long it's kept.
- Third-party notices for the bundled `ignore` library.

## 0.1.1

- Invite links: the lifetime setting now limits how long a link can be opened. A viewer who
  opened it in time stays in the project — a tab reopened the next day still works — until you
  revoke invite links or delete the project. Needs the matching server update (`bun run deploy`).
- Viewer page reconnects on its own after a network drop instead of needing a reload, and says
  "no access" or "deleted" instead of "reconnecting…" once access is gone for good (server
  update).
- The listing gains a Privacy section: the extension talks only to the server you configure and
  sends no telemetry.

## 0.1.0

Initial release.

- Snapshot the open workspace and stream file changes to a sourcebeam server over a single
  WebSocket, with edits coalesced per file.
- Broadcast every text file the project's `.gitignore` doesn't exclude, whatever its extension,
  up to the server's size cap; binaries are skipped and nothing under `.git/` is ever sent.
- Commands: start/stop broadcasting, set host token (stored in VS Code Secret Storage), set
  project/server URL, copy invite link, revoke invite links, delete project.
- Sourcebeam view in the Activity Bar — project, start/stop broadcasting, copy invite link and
  **Settings…**, a single form with every setting — with the same actions as title-bar icons,
  alongside the status bar item and the Command Palette.
- Server URL and host token are global (one token per server); the project id and invite link
  lifetime are per-workspace, defaulting to the folder's name and 6 hours.
- Works in Restricted Mode (Workspace Trust) — the extension never executes anything from the
  workspace, only reads files through the same filters it applies before broadcasting.
