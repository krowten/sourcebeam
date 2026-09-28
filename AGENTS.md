# Contributor and agent notes

## Stack

Bun workspaces. `apps/web` is a SvelteKit app deployed to Cloudflare Workers via
`@sveltejs/adapter-cloudflare`, with a Durable Object holding each project's state;
`packages/protocol` is shared wire types and file policy; `extensions/vscode` is the host-side
VS Code extension. Vite (through SvelteKit) builds the web app — this is not a `Bun.serve`
project.

`extensions/jetbrains` is the odd one out: a Kotlin/Gradle plugin for the JetBrains IDEs, not a
Bun workspace member. It has no `package.json`, is built with its own Gradle wrapper, and
duplicates the wire protocol and file policy in Kotlin — when `packages/protocol` changes, that
port has to follow.

## Code style

- Functions over classes wherever a class isn't strictly required (a Durable Object is: the
  platform demands a class).
- `type` over `interface` unless something needs declaration merging.
- Read environment variables by destructuring `process.env` once, right after the imports, with
  defaults inline: `const { PORT = "3000", NO_COLOR } = process.env;` — never
  `process.env.PORT ?? "3000"` in the middle of a function. The exception is code that must see
  env changed at runtime (a test sets it per case); say so in a comment.
- SvelteKit: remote functions instead of `+server.ts` API routes; no `load` functions — use
  top-level `await` in components plus hydration (the experimental `async` / `remoteFunctions`
  flags are already enabled in `apps/web`).
- Svelte 5 runes (`$state`, `$derived`, `$effect`), not the Svelte 4 store API.

## Tooling

Bun, not Node:

- `bun <file>` instead of `node <file>` / `ts-node <file>`
- `bun install`, `bun run <script>`, `bunx <package>` instead of the npm/yarn/pnpm equivalents
- `bun test` for `packages/protocol` and `extensions/vscode`; `apps/web` uses vitest
  (`@cloudflare/vitest-pool-workers` for the Durable Object) and Playwright for e2e
- Bun loads `.env` on its own — don't add `dotenv`

Where Bun has a native API, use it instead of the Node one or an npm package (`file` / `write`
over `node:fs`, `spawn` / `$` over `execa`); fall back to `node:*` only where Bun has no
equivalent. Import them by name — `import { file, spawn } from "bun"` — never call `Bun.*`
directly. Code shared with the VS Code extension is the exception: it runs under Node in the
editor host, so use `node:crypto` and friends there, never Bun APIs.

## Tests

```sh
bun test --cwd packages/protocol         # protocol + policy + invite signing
bun run --cwd apps/web test:unit -- --run   # vitest, browser mode (watch without --run)
bun run --cwd apps/web test:do           # Durable Object, workers pool
bun run --cwd apps/web test:e2e          # Playwright
bun run --cwd extensions/vscode test     # extension unit tests (excludes tests/integration/**)
bun run --cwd extensions/vscode test:integration   # real editor host, needs a display
```

Call the package script rather than retyping its command — `bun test --cwd extensions/vscode`
loses the script's `--path-ignore-patterns` and picks up the integration suite, which cannot
resolve `vscode` outside an editor host.

The JetBrains plugin builds separately, with JDK 21:

```sh
cd extensions/jetbrains
./gradlew test          # policy, gitignore matching, JSON codec
./gradlew buildPlugin   # installable zip in build/distributions/
./gradlew runIde        # sandboxed IDE with the plugin loaded
```

CI runs all of these; the VS Code integration suite runs under `xvfb-run`.
