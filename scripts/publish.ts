#!/usr/bin/env bun
// Publishes an already-released build to the marketplaces — the exact .vsix/.zip that
// release.yml attached to the GitHub Release for the tag, never a fresh local build, so what
// ships is what anyone can download from that release. Tokens come from the environment and are
// passed to vsce/ovsx the way they read them natively (VSCE_PAT/OVSX_PAT), never on a command
// line where they'd show up in the process list.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { $, file } from "bun";

import { fail, ROOT } from "./lib/cloudflare";

const { VSCE_PAT, OVSX_PAT, JETBRAINS_TOKEN } = process.env;

function usage(): never {
	console.log(`Usage:
  bun run release:publish vscode <x.y.z> [--dry-run]      VS Code Marketplace (VSCE_PAT) and/or Open VSX (OVSX_PAT)
  bun run release:publish jetbrains <x.y.z> [--dry-run]   JetBrains Marketplace (JETBRAINS_TOKEN)

Downloads the track's artifact from the GitHub Release tagged v<x.y.z> (needs the gh CLI,
signed in) and publishes that file. --dry-run downloads and checks it, uploads nothing.`);
	process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [track, version] = args.filter((a) => a !== "--dry-run");
if (!track || !version || (track !== "vscode" && track !== "jetbrains")) usage();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${version}" isn't a plain x.y.z semver.`);

const tag = `v${version}`;
const pattern = track === "vscode" ? "*.vsix" : "*.zip";
const dir = mkdtempSync(path.join(tmpdir(), "sourcebeam-release-"));
// Not try/finally: fail() calls process.exit, which skips finally blocks.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const dl = await $`gh release download ${tag} --pattern ${pattern} --dir ${dir}`.cwd(ROOT).nothrow();
if (dl.exitCode !== 0) fail(`could not download ${pattern} from release ${tag}:\n${dl.stderr.toString()}`);

const files = readdirSync(dir);
if (files.length !== 1) fail(`expected exactly one ${pattern} in release ${tag}, found: ${files.join(", ") || "none"}`);
const artifact = path.join(dir, files[0]!);
if (!files[0]!.includes(version)) fail(`${files[0]} doesn't carry version ${version} in its name — wrong release?`);
console.log(`[release] ${tag}: ${files[0]}`);

if (track === "vscode") {
	const targets = [
		{ name: "VS Code Marketplace", env: "VSCE_PAT", token: VSCE_PAT, cmd: ["x", "@vscode/vsce", "publish", "--packagePath", artifact] },
		{ name: "Open VSX", env: "OVSX_PAT", token: OVSX_PAT, cmd: ["x", "ovsx", "publish", artifact] },
	].filter((t) => {
		if (t.token || dryRun) return true;
		console.log(`[skip] ${t.name}: ${t.env} not set`);
		return false;
	});
	if (targets.length === 0) fail("set VSCE_PAT and/or OVSX_PAT — nothing to publish to.");
	for (const t of targets) {
		if (dryRun) {
			console.log(`[dry-run] would publish to ${t.name}${t.token ? "" : ` (${t.env} not set yet)`}`);
			continue;
		}
		console.log(`[publish] ${t.name}...`);
		// cwd = extensions/vscode so bun x resolves the workspace's own vsce/ovsx versions.
		const res = await $`bun ${t.cmd}`.cwd(path.join(ROOT, "extensions/vscode")).nothrow();
		if (res.exitCode !== 0) fail(`${t.name} publish failed (exit ${res.exitCode}).`);
	}
} else {
	const pluginXml = await file(path.join(ROOT, "extensions/jetbrains/src/main/resources/META-INF/plugin.xml")).text();
	const xmlId = pluginXml.match(/<id>([^<]+)<\/id>/)?.[1];
	if (!xmlId) fail("could not read <id> from plugin.xml.");
	if (dryRun) {
		console.log(`[dry-run] would upload to JetBrains Marketplace as ${xmlId}`);
	} else {
		if (!JETBRAINS_TOKEN) fail("set JETBRAINS_TOKEN (a permanent token from plugins.jetbrains.com → My Tokens).");
		// https://plugins.jetbrains.com/docs/marketplace/plugin-upload.html — only works for a
		// plugin that already exists there; the very first version is uploaded through the web UI.
		const form = new FormData();
		form.set("xmlId", xmlId);
		form.set("file", file(artifact), files[0]);
		console.log("[publish] JetBrains Marketplace...");
		const res = await fetch("https://plugins.jetbrains.com/api/updates/upload", {
			method: "POST",
			headers: { Authorization: `Bearer ${JETBRAINS_TOKEN}` },
			body: form,
		});
		if (!res.ok) fail(`JetBrains Marketplace upload failed: HTTP ${res.status}\n${await res.text()}`);
		console.log("[publish] uploaded — live once JetBrains Marketplace finishes its checks.");
	}
}
