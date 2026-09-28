#!/usr/bin/env bun
// Manage host tokens for an already-deployed sourcebeam worker: mint, list, rename, rotate,
// revoke. Handy for a worker shared by several people (a school, a team) who each want their
// own named, individually revocable token instead of sharing one.
import { randomBytes } from "node:crypto";
import {
	ensureLoggedIn,
	fail,
	findNamespace,
	listNamespaces,
	namespaceTitleFor,
	resolveWorkerName,
	wrangler,
} from "./lib/cloudflare";

type TokenMeta = { label?: string };
type KvKey = { name: string };

function usage(): never {
	console.log(`Usage:
  bun run token new [name]              mint a new host token, optionally labeled
  bun run token list                    list existing tokens with their labels
  bun run token rename <token|name> <name>   relabel a token, keeping the same secret
  bun run token rotate <token|name>     replace a token's secret, keeping its label
  bun run token revoke <token|name>     delete a token

"<token|name>" accepts either the raw token or a label, as long as the label matches
exactly one token.`);
	process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !["new", "list", "rename", "rotate", "revoke"].includes(cmd)) usage();

const workerName = resolveWorkerName();
await ensureLoggedIn();
const namespaces = await listNamespaces();
const ns = findNamespace(namespaces, workerName);
if (!ns) {
	fail(
		`no KV namespace named "${namespaceTitleFor(workerName)}" (or legacy "HOST_TOKENS") found. ` +
			`Run \`bun run deploy\` first — this script only manages tokens for a worker that's already deployed.`,
	);
}
const nsId = ns.id;

async function listKeys(): Promise<KvKey[]> {
	const res = await wrangler(["kv", "key", "list", "--namespace-id", nsId, "--remote"]);
	if (res.exitCode !== 0) fail(`\`wrangler kv key list\` failed:\n${res.stderr}`);
	try {
		return JSON.parse(res.stdout) as KvKey[];
	} catch {
		fail(`could not parse \`wrangler kv key list\` output as JSON:\n${res.stdout}`);
	}
}

async function getMeta(token: string): Promise<TokenMeta> {
	const res = await wrangler(["kv", "key", "get", "--namespace-id", nsId, "--remote", token]);
	if (res.exitCode !== 0) fail(`\`wrangler kv key get\` failed:\n${res.stderr}`);
	try {
		return JSON.parse(res.stdout) as TokenMeta;
	} catch {
		return {};
	}
}

async function putMeta(token: string, meta: TokenMeta) {
	const res = await wrangler(["kv", "key", "put", "--namespace-id", nsId, "--remote", token, JSON.stringify(meta)]);
	if (res.exitCode !== 0) fail(`\`wrangler kv key put\` failed:\n${res.stderr}`);
}

/** Resolves a CLI argument that may be a raw token or a (unique) label to the actual token. */
async function resolveToken(arg: string): Promise<string> {
	const keys = await listKeys();
	if (keys.some((k) => k.name === arg)) return arg;

	const matches: string[] = [];
	for (const k of keys) {
		if ((await getMeta(k.name)).label === arg) matches.push(k.name);
	}
	if (matches.length === 1) return matches[0]!;
	if (matches.length === 0) fail(`no token found matching "${arg}" (checked as both a token and a label).`);
	fail(`"${arg}" matches ${matches.length} tokens with that label — use the full token instead.`);
}

switch (cmd) {
	case "new": {
		const label = args[0];
		const token = randomBytes(24).toString("hex");
		await putMeta(token, label ? { label } : {});
		console.log(`New host token${label ? ` for "${label}"` : ""} (shown once — save it now):\n${token}`);
		console.log('\nUse it with "sourcebeam: Set Host Token" in the editor extension.');
		break;
	}
	case "list": {
		const keys = await listKeys();
		if (keys.length === 0) {
			console.log('No host tokens yet. Mint one with "bun run token new [name]".');
			break;
		}
		const rows = await Promise.all(
			keys.map(async (k) => ({ token: k.name, label: (await getMeta(k.name)).label ?? "" })),
		);
		console.table(rows);
		break;
	}
	case "rename": {
		const [arg, name] = args;
		if (!arg || !name) usage();
		const token = await resolveToken(arg);
		await putMeta(token, { label: name });
		console.log(`Relabeled to "${name}".`);
		break;
	}
	case "rotate": {
		const [arg] = args;
		if (!arg) usage();
		const token = await resolveToken(arg);
		const meta = await getMeta(token);
		const newToken = randomBytes(24).toString("hex");
		// New key first, old key deleted only once it exists — a failed delete then just
		// leaves two live tokens for the same person instead of zero.
		await putMeta(newToken, meta);
		const res = await wrangler(["kv", "key", "delete", "--namespace-id", nsId, "--remote", token]);
		if (res.exitCode !== 0) fail(`\`wrangler kv key delete\` failed:\n${res.stderr}`);
		console.log(
			`New host token${meta.label ? ` for "${meta.label}"` : ""} (shown once — save it now):\n${newToken}`,
		);
		console.log("\nThe old token stops working immediately for new connections; an already-connected");
		console.log("host stays connected until it reconnects with the new one.");
		break;
	}
	case "revoke": {
		const [arg] = args;
		if (!arg) usage();
		const token = await resolveToken(arg);
		const res = await wrangler(["kv", "key", "delete", "--namespace-id", nsId, "--remote", token]);
		if (res.exitCode !== 0) fail(`\`wrangler kv key delete\` failed:\n${res.stderr}`);
		console.log(
			"Revoked. New connections with that token are rejected from now on. A host that's " +
				"already connected and broadcasting stays connected until it reconnects.",
		);
		break;
	}
}
