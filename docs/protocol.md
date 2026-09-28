# Wire protocol

Everything travels over one WebSocket per session, as JSON text frames. The shared message
types live in [`packages/protocol`](../packages/protocol/src/index.ts) and are the source of
truth; the JetBrains plugin duplicates them in Kotlin and must track them.

Two roles connect to the same endpoint:

- the **host** (the editor extension), authenticated by a host token, allowed to write;
- a **viewer** (the browser page), authenticated by an invite cookie, read-only.

## Connecting

`GET wss://<server>/ws/<project>` with `Upgrade: websocket`. `<project>` must match
`[a-z0-9][a-z0-9_-]{0,63}`; each project id maps to its own Durable Object.

Auth, checked in this order:

1. `Authorization: Bearer <host token>`. The connection becomes the project's host if the
   token exists in the `HOST_TOKENS` KV namespace; unknown tokens are rejected with `403`.
   A project has at most one live host, so a second host connection closes the first with
   code `4000`.
2. A `sb_view_<project>=<invite token>` cookie. The connection becomes a viewer if the token
   verifies (see [Invites](#invites)). Anything else is rejected with `403` before the
   upgrade completes.

The first frame the server sends to **everyone** is `policy`:

```json
{ "type": "policy", "maxBytes": 524288 }
```

Viewers then immediately receive the current file tree; the host does not:

```json
{ "type": "tree", "paths": ["src/app.ts", "README.md"] }
```

## Host → server

| Message | Shape | Semantics |
| --- | --- | --- |
| `snapshot_begin` | `{}` | Starts a full snapshot; the server begins tracking which paths the snapshot mentions. |
| `file_put` | `{ path, hash, content }` | Upserts one file. If `hash` equals the stored hash, subscribers are not notified. A path new to the tree broadcasts `tree_update` to every viewer. |
| `file_delete` | `{ path }` | Removes a file and broadcasts `tree_update`. |
| `snapshot_end` | `{}` | Ends the snapshot. Files that were present before `snapshot_begin` but absent from the snapshot get deleted (stale cleanup). |
| `mint_invite` | `{ ttlSeconds }` | Mints a signed invite; the server replies with `invite`. |
| `rotate_view_secret` | `{}` | Invalidates every invite issued so far and disconnects current viewers (close `4001`); the server replies with `ok`. |
| `delete_project` | `{}` | Sends `project_deleted` to viewers, wipes storage (files **and** the view secret), and closes every connection with `4001`. |

Every `file_put` is validated against the policy (path shape, size cap, text content, hard
blocks) and rejected with an `error` frame if it fails. Hard blocks can never be overridden. Messages on one connection are processed
strictly in order.

## Viewer → server

| Message | Shape | Semantics |
| --- | --- | --- |
| `subscribe` | `{ path }` | Subscribes to one file. The server replies with a full `file` frame and pushes a new one on every content change. A new `subscribe` replaces the previous subscription, so a viewer follows at most one file. |

Role violations (a viewer sending host messages, and vice versa) get an `error` frame. Ten
consecutive invalid messages from a viewer close its connection with code `1008`. The host's
connection is never closed for invalid messages: losing the live broadcast over a malformed
frame would hurt the viewers more than it protects the room.

## Server → client

| Message | Sent to | When |
| --- | --- | --- |
| `policy` | both | First frame after connect. |
| `tree` | viewers | Right after `policy`, full list of paths. |
| `tree_update` | all viewers | `{ added, removed }` on any tree change. |
| `file` | the subscriber | `{ path, hash, content }` on subscribe and on every change of that file. |
| `invite` | the host | `{ url, expiresAt }`, where `url` is site-relative: `/<project>?token=<invite token>`. |
| `ok` | the host | Confirms `rotate_view_secret`. |
| `error` | sender | `{ message }` for any invalid message. |
| `project_deleted` | viewers | Before the sockets close on `delete_project`, or when the idle-TTL alarm collects the project (see [self-hosting.md](self-hosting.md#expiring-idle-projects)). |

Close codes: `4000` means the host was replaced by a newer host connection; `4001` means
invites were rotated or the project was deleted; `1008` means too many invalid messages.

## Invites

An invite token is `"<expiryUnix>.<hmac>"` where the MAC is
`HMAC-SHA-256("<project>.<expiryUnix>", viewSecret)` in lowercase hex. The view secret is
random per project, created on first use and persisted in the Durable Object. Both
`rotate_view_secret` and `delete_project` replace it, which is what invalidates old tokens.

The viewer never sees the WebSocket handshake details. Opening
`https://<server>/<project>?token=...` verifies the token, `302`-redirects to the clean URL,
and sets the `sb_view_<project>` cookie (`HttpOnly; Secure; SameSite=Lax`) with `Max-Age`
matching the token's remaining lifetime. Tokens that don't match `^\d+\.[0-9a-f]{64}$` are
rejected before any storage is touched.

## File policy

Defined in [`packages/protocol/src/policy.ts`](../packages/protocol/src/policy.ts) and
whose size cap is published to every client as the `policy` frame. Any text file passes,
whatever its name or extension, as long as it clears all of:

- `maxBytes`: 512 KiB per file;
- text: valid UTF-8 with no NUL bytes (git's binary heuristic), so binaries don't broadcast;
- not under `.git/` — the one hard block, since git internals are never project content.

There is no built-in list of secret files: `.env`, keys and tokens are broadcast unless the
project's `.gitignore` excludes them, so a teaching project can share a demo `.env` on
purpose.

Clients apply the same policy before sending (plus the project's `.gitignore`); the server
enforces it again on every `file_put`.

## Timing constants

- `DEBOUNCE_MS = 300`: editors coalesce change bursts per file for this long before re-reading.
- `RECONNECT_MIN_MS = 1000`, `RECONNECT_MAX_MS = 30000`: client reconnect backoff bounds.
