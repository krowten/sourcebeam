# Self-hosting

sourcebeam runs entirely on your own Cloudflare account: one Worker, one Durable Object
class, one KV namespace. The free plan is enough for personal use, since idle projects
hibernate and cost nothing.

## One-command deploy

```sh
bun install
bun run deploy            # add --dry-run to see the plan without touching your account
```

`scripts/deploy.ts` walks through everything:

1. **Login**: runs `wrangler login` (browser OAuth) if you aren't logged in already.
2. **KV namespace**: finds or creates `<worker-name>-HOST_TOKENS`.
3. **Config**: writes `apps/web/wrangler.generated.jsonc` from `wrangler.jsonc`, filling in
   your worker name and KV namespace id. The generated file is overwritten on every run;
   edit `wrangler.jsonc` instead.
4. **Build and deploy**: SvelteKit build, then `wrangler deploy`. The script prints the
   `https://….workers.dev` URL; use it with the `wss://` scheme as the extension's server
   URL.
5. **Host token**: if the namespace has no tokens yet, the script seeds one random token and
   prints it **once**. Store it somewhere safe. That token is what lets an editor broadcast.

The worker name defaults to `sourcebeam` and becomes part of the URL. Override it with
`SOURCEBEAM_WORKER_NAME=myname bun run deploy`.

## Managing host tokens

`bun run deploy` only prints a token the very first time it deploys a worker (when the KV
namespace has none yet). Every run after that just says a token already exists and leaves it
alone, without printing anything — which is easy to mistake for the feature being broken.
For everything past that first token, use `bun run token`. Like `deploy`, it opens the
browser for `wrangler login` itself the first time it needs Cloudflare access — no separate
login step, and nothing to put in `.env`:

```sh
bun run token new [name]              # mint a token, optionally labeled ("Alice")
bun run token list                    # list tokens with their labels
bun run token rename <token|name> <name>   # relabel a token, same secret
bun run token rotate <token|name>     # replace a token's secret, keeping its label
bun run token revoke <token|name>     # delete a token
```

`rename`, `rotate` and `revoke` accept either the full token or a label, as long as the label
matches exactly one token — so day to day you never have to paste the raw secret around. This
is the whole point for a worker several people share, like a school where each teacher gets
their own named, individually revocable token instead of everyone using the same one: mint
one per person with a name (`bun run token new "Alice"`), `bun run token list` to see who has
one, `bun run token revoke "Alice"` the day Alice leaves.

`rotate` is for when a token leaked or you just want to cycle it, but the person should keep
broadcasting under the same name — it swaps in a new secret and prints it once, without
touching the label. `revoke` is for when the person shouldn't have access at all anymore.

Both block new connections with the old token immediately; a host that's already connected
and broadcasting stays connected until it reconnects. There's no redeploy involved in any of
this — it's a KV write against the already-deployed worker.

Invite links are a different mechanism entirely. The host mints them per project from the
editor. A link stops opening once its lifetime is up, but whoever already opened it stays in
the project; **Revoke Invite Links** removes everyone at once; see
[protocol.md](protocol.md#invites).

## Deleting a project

```sh
bun run project delete <project-id>
```

Does exactly what the editor's **Sourcebeam: Delete Project** command does — wipes the
project's files and disconnects everyone — without opening an editor. Handy for cleaning up
old test/demo projects. Targets whatever `bun run deploy` already deployed (same worker name,
same account) automatically; `--server wss://...` overrides that, for a worker sitting behind
a custom domain instead of the default `workers.dev` one.

There's no `bun run project list`. sourcebeam keeps no registry of project ids anywhere —
each one lives only in its own Durable Object, addressed by name, and Cloudflare doesn't
expose a way to enumerate those. You have to already know the id you want gone.

## Expiring idle projects

Since there's no way to list projects, a long-running deployment otherwise accumulates every
demo and one-off lesson anybody ever broadcast. Set `PROJECT_TTL_DAYS` in
`apps/web/wrangler.jsonc` (then redeploy) to have projects collect themselves; a week is a
sensible starting point:

```jsonc
"vars": { "PROJECT_TTL_DAYS": "7" }
```

A project is deleted once that many days pass with no activity, where activity is the last
file change or the last time a host connected — viewers watching don't count, or anyone
holding a live invite link could keep an abandoned project alive by leaving a tab open. The
deletion is the same one **Delete Project** performs: files gone, viewers disconnected with
a `project_deleted` screen, old invite links dead.

Two things this deliberately isn't:

- **Not a way to end access.** A project you broadcast every week never goes idle, so its TTL
  never fires, and everyone who joined on day one keeps watching all term. That's by design;
  **Revoke Invite Links** is what ends access. The idle TTL bounds how long *data* sticks
  around.
- **Not destructive to re-use.** Broadcasting a collected project id again just recreates it
  from the next snapshot, same as a project that was never deleted.

`"never"` (or `"unlimited"`, or leaving the key out) is the default and means projects live
until something deletes them explicitly, so updating an existing deployment never starts
removing data on its own. Anything else that isn't a positive number — `0`, `"7d"`, a typo —
reads as "never" too, on the grounds that a config slip should not be able to wipe a term's
worth of projects.

## Manual deploy (no script)

If you'd rather keep the script out of the loop:

```sh
cd apps/web
bunx wrangler kv namespace create sourcebeam-HOST_TOKENS
# copy wrangler.jsonc to wrangler.local.jsonc (gitignored) and paste the namespace id into it
bun run build
bunx wrangler deploy -c wrangler.local.jsonc
```

Then seed a host token as above (with `-c wrangler.local.jsonc`).

## Local development

```sh
bun run --cwd apps/web dev      # vite dev server, UI only
bun run --cwd apps/web preview  # full stack: wrangler dev + emulated KV/DO, seeds token "dev-host"
```

`preview` is what the Playwright e2e suite runs against. The emulated KV ignores the real
namespace id, so the placeholder in `wrangler.jsonc` never blocks local work.

## Updating

Pull, then run `bun run deploy` again. Durable Object storage (files, view secrets) and KV
(host tokens) survive deploys, and the `migrations` block in `wrangler.jsonc` only ever adds
the `ProjectRoom` class.

## Removing a deployment

```sh
bun run undeploy           # add --dry-run to see what would go, without deleting anything
```

The reverse of `bun run deploy`: deletes the Worker together with its Durable Objects (every
project and its files), the `<worker>-HOST_TOKENS` KV namespace (every host token), and the
local `apps/web/wrangler.generated.jsonc`. It lists what it found and asks you to type the
Worker name back before touching anything; pass `--yes` to skip that in scripts. Respects
`SOURCEBEAM_WORKER_NAME` the same way deploy does. There's no undo — every invite link and host
token stops working, and a later `bun run deploy` starts from scratch with a new token.
