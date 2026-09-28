# Changelog

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
