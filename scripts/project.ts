#!/usr/bin/env bun
// Force-delete a project's files and connections directly, without an editor extension —
// the same delete_project message "Sourcebeam: Delete Project" sends, just from the CLI.
//
// There's no "list": sourcebeam keeps no registry of project ids anywhere. Each project lives
// only in its own Durable Object, addressed by name (idFromName) — Cloudflare doesn't expose a
// way to enumerate DO instances that have been used, and nothing else in this codebase tracks
// them. If you don't already know the id, this can't find it for you.
import {
	ensureLoggedIn,
	fail,
	findNamespace,
	listNamespaces,
	namespaceTitleFor,
	resolveDefaultServerUrl,
	resolveWorkerName,
	wrangler,
} from "./lib/cloudflare";

const { SOURCEBEAM_SERVER_URL } = process.env;

function usage(): never {
	console.log(`Usage:
  bun run project delete <project-id> [--server wss://sourcebeam.<sub>.workers.dev]

Without --server (or SOURCEBEAM_SERVER_URL), this targets whatever "bun run deploy" already
deployed — same worker name, same account. Pass --server only if the worker sits behind a
custom domain instead of the default workers.dev one.

There's no "list" — see the comment at the top of scripts/project.ts for why.`);
	process.exit(1);
}

const args = process.argv.slice(2);
const [cmd, projectId] = args;
if (cmd !== "delete" || !projectId) usage();
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(projectId)) {
	fail(
		`"${projectId}" isn't a valid project id (lowercase letters, digits, hyphens, underscores; can't start with a hyphen or underscore).`,
	);
}

await ensureLoggedIn();
const workerName = resolveWorkerName();

const serverFlagIdx = args.indexOf("--server");
let serverOverride: string | undefined;
if (serverFlagIdx !== -1) {
	serverOverride = args[serverFlagIdx + 1];
	if (!serverOverride) fail("--server requires a value, e.g. --server wss://sourcebeam.<sub>.workers.dev");
} else {
	serverOverride = SOURCEBEAM_SERVER_URL;
}
const server = serverOverride ?? (await resolveDefaultServerUrl(workerName));
if (!server) {
	fail(
		"couldn't work out the deployed URL automatically — pass --server wss://sourcebeam.<sub>.workers.dev " +
			"or set SOURCEBEAM_SERVER_URL.",
	);
}
if (!/^wss?:\/\//.test(server)) fail(`"${server}" must start with ws:// or wss://`);

const namespaces = await listNamespaces();
const ns = findNamespace(namespaces, workerName);
if (!ns) {
	fail(
		`no KV namespace named "${namespaceTitleFor(workerName)}" (or legacy "HOST_TOKENS") found. ` +
			`Run \`bun run deploy\` first.`,
	);
}

const keysRes = await wrangler(["kv", "key", "list", "--namespace-id", ns.id, "--remote"]);
if (keysRes.exitCode !== 0) fail(`\`wrangler kv key list\` failed:\n${keysRes.stderr}`);
let keys: { name: string }[];
try {
	keys = JSON.parse(keysRes.stdout);
} catch {
	fail(`could not parse \`wrangler kv key list\` output as JSON:\n${keysRes.stdout}`);
}
// delete_project only checks that the token is *some* valid host token, not that it belongs to
// this project (host tokens identify a person, not a project — see bun run token) — any one works.
const token = keys[0]?.name;
if (!token) fail('no host tokens exist yet — run "bun run token new" first.');

const url = `${server.replace(/\/+$/, "")}/ws/${projectId}`;
console.log(`Connecting to ${url} as host...`);

// bun-types only declares the standard (url, protocols?) constructor — Bun's actual runtime
// also accepts an undici-style { headers } option (same gap as extensions/vscode/src/extension.ts).
// @ts-expect-error — see above
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });

const closed = new Promise<{ code: number }>((resolve, reject) => {
	ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "delete_project" })));
	ws.addEventListener("close", (ev) => resolve({ code: (ev as CloseEvent).code }));
	ws.addEventListener("error", () => reject(new Error("websocket connection failed (check --server and that it's deployed)")));
});
// Cleared on both branches below — an uncleared timer is a pending handle that keeps this CLI
// process alive for the rest of the 10s even after a successful, near-instant deletion.
let timeoutId!: ReturnType<typeof setTimeout>;
const timeout = new Promise<never>((_, reject) => {
	timeoutId = setTimeout(() => reject(new Error("timed out waiting for the server to confirm deletion")), 10_000);
});

try {
	const { code } = await Promise.race([closed, timeout]);
	clearTimeout(timeoutId);
	if (code !== 4001) fail(`connection closed with unexpected code ${code} — the project may not have been deleted.`);
	console.log(`Deleted "${projectId}". Any connected viewers were disconnected.`);
} catch (err) {
	clearTimeout(timeoutId);
	fail(err instanceof Error ? err.message : String(err));
}
