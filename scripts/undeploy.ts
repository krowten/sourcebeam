#!/usr/bin/env bun
// The reverse of scripts/deploy.ts: removes everything a deploy created on Cloudflare — the
// Worker (deleting it also deletes its Durable Object namespace, i.e. every project's stored
// files) and the HOST_TOKENS KV namespace — plus the local wrangler.generated.jsonc. Irreversible:
// every host token and invite link stops working. Asks for the Worker name to be typed back unless
// --yes is passed; --dry-run only looks things up (read-only) and deletes nothing.
import { existsSync, rmSync } from "node:fs";
import { amber, bold, dim } from "./lib/colors";
import {
	ensureLoggedIn,
	fail,
	findNamespace,
	listNamespaces,
	namespaceTitleFor,
	resolveWorkerName,
	WEB_DIR,
	wrangler,
} from "./lib/cloudflare";

const dryRun = process.argv.includes("--dry-run");
const yes = process.argv.includes("--yes");

function log(step: string, msg: string) {
	console.log(`[${step}] ${msg}`);
}

const workerName = resolveWorkerName();
const generatedPath = `${WEB_DIR}/wrangler.generated.jsonc`;

await ensureLoggedIn();
const ns = findNamespace(await listNamespaces(), workerName);
// Read-only: `deployments list` fails for a Worker that doesn't exist on this account.
const workerExists = (await wrangler(["deployments", "list", "--name", workerName, "--json"])).exitCode === 0;
const hasGenerated = existsSync(generatedPath);

if (!workerExists && !ns && !hasGenerated) {
	log("summary", `nothing to delete — no Worker "${workerName}" and no "${namespaceTitleFor(workerName)}" KV namespace on this account.`);
	process.exit(0);
}

console.log(`\n${bold("This deletes, with no way back:")}`);
if (workerExists) {
	console.log(`  - Worker ${bold(workerName)} and its Durable Objects — every broadcast project and its files`);
} else {
	console.log(`  - ${dim(`no Worker "${workerName}" on this account — nothing to delete there`)}`);
}
if (ns) {
	const legacy = ns.title !== namespaceTitleFor(workerName) ? dim(" (legacy name from before deploy.ts)") : "";
	console.log(`  - KV namespace ${bold(ns.title)} (${ns.id}) — every host token${legacy}`);
} else {
	console.log(`  - ${dim(`no KV namespace "${namespaceTitleFor(workerName)}" found — nothing to delete there`)}`);
}
if (hasGenerated) console.log(`  - local ${dim("apps/web/wrangler.generated.jsonc")}`);
console.log(`Extensions pointed at it stop connecting and every invite link dies.\n`);

if (dryRun) {
	log("summary", "dry run — nothing was deleted.");
	process.exit(0);
}

if (!yes) {
	const answer = prompt(`Type the Worker name (${workerName}) to confirm:`);
	if (answer?.trim() !== workerName) fail("confirmation didn't match — nothing was deleted.");
}

if (workerExists) {
	log("worker", `deleting ${workerName}...`);
	const del = await wrangler(["delete", "--name", workerName, "--force"]);
	if (del.exitCode !== 0) fail(`\`wrangler delete\` failed:\n${del.stderr || del.stdout}`);
	log("worker", "deleted (with its Durable Objects).");
}

if (ns) {
	log("kv", `deleting namespace "${ns.title}"...`);
	const kv = await wrangler(["kv", "namespace", "delete", "--namespace-id", ns.id, "--skip-confirmation"]);
	if (kv.exitCode !== 0) fail(`\`wrangler kv namespace delete\` failed:\n${kv.stderr || kv.stdout}`);
	log("kv", "deleted.");
}

if (hasGenerated) {
	rmSync(generatedPath);
	log("config", "removed apps/web/wrangler.generated.jsonc.");
}

console.log(`\n${bold(amber("=== Undeploy complete ==="))}`);
console.log(dim("Run `bun run deploy` to start over from scratch."));
