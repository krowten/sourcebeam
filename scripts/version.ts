#!/usr/bin/env bun
// Bumps both extensions to the same version — they share the wire protocol, so they're released
// together from one `v<x.y.z>` tag. Only touches the version fields themselves; CHANGELOG.md /
// changeNotes are hand-written prose and this won't guess at their wording.
import { file, write } from "bun";

import { fail } from "./lib/cloudflare";

const [version] = process.argv.slice(2);
if (!version) {
	console.log("Usage: bun run bump-version <x.y.z>   bump extensions/vscode and extensions/jetbrains");
	process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${version}" isn't a plain x.y.z semver.`);

const targets = [
	{ path: "extensions/vscode/package.json", find: /"version":\s*"[^"]+"/, replace: `"version": "${version}"` },
	{ path: "extensions/jetbrains/gradle.properties", find: /pluginVersion\s*=\s*\S+/, replace: `pluginVersion = ${version}` },
];
for (const t of targets) {
	const src = await file(t.path).text();
	const updated = src.replace(t.find, t.replace);
	if (updated === src && !src.includes(t.replace)) fail(`could not find the version field in ${t.path}.`);
	await write(t.path, updated);
	console.log(`${t.path} -> ${version}`);
}
console.log(
	"Don't forget extensions/vscode/CHANGELOG.md and the changeNotes block in extensions/jetbrains/build.gradle.kts.",
);
