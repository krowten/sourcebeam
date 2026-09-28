# @sourcebeam/web

The server side of sourcebeam: a Cloudflare Worker that holds each project's state in a
Durable Object, plus the SvelteKit viewer page served from the same Worker.

- `src/worker/`: the Worker entry, request routing, and the `ProjectRoom` Durable Object
  (SQLite-backed file storage, WebSocket Hibernation, host auth against the `HOST_TOKENS`
  KV namespace, invite minting and revocation)
- `src/routes/`, `src/lib/`: the viewer UI, meaning the file tree, Shiki-highlighted
  content, and the live WebSocket client. Syntax highlighting loads a deliberate subset of
  Shiki grammars (see `LANGS` in `src/lib/components/CodeView.svelte`); files outside it
  still render as plain text. Add a grammar there to widen coverage without shipping all of
  Shiki.
- `wrangler.jsonc`: deployment config. `bun run deploy` from the repo root generates
  `wrangler.generated.jsonc` from it with your own KV namespace id.

See the [repository README](../../README.md) for what the project is and how to deploy it.

## Commands

```sh
bun run dev            # SvelteKit dev server
bun run build          # production build
bun run preview        # wrangler dev against the built output, with emulated DO and KV
bun run test:unit      # vitest, browser mode
bun run test:do        # Durable Object tests, @cloudflare/vitest-pool-workers
bun run test:e2e       # Playwright
bun run check          # svelte-check
```
