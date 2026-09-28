// Entry point for `bun run test:integration` — launches a real VS Code (extension host + a
// visible window; there's no headless mode without xvfb) and runs tests/integration/suite
// against it. Requires the local sourcebeam preview server (`bun run --cwd apps/web preview`)
// to already be listening on :4173 — this script doesn't manage it, see README.
//
// @vscode/test-electron's extensionTestsPath is `require()`d by the extension host itself,
// a plain Node process with no TypeScript/ESM loader — so the suite is precompiled to
// CommonJS (tsconfig.json in this folder) before runTests() is invoked below.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";

const extensionDevelopmentPath = path.resolve(import.meta.dir, "../..");
const integrationDir = path.resolve(import.meta.dir);
const extensionTestsPath = path.join(integrationDir, "out", "suite", "index.js");

function run(cmd: string[], cwd: string): void {
	const [bin, ...args] = cmd;
	const result = spawnSync(bin!, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`command failed (${result.status}): ${cmd.join(" ")}`);
	}
}

async function checkServerUp(): Promise<void> {
	try {
		const res = await fetch("http://localhost:4173/", { signal: AbortSignal.timeout(3000) });
		void res.body?.cancel();
	} catch (err) {
		throw new Error(
			"sourcebeam preview server isn't reachable on http://localhost:4173 — start it first with " +
				"`bun run --cwd apps/web preview`.\n" +
				`(${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

/** Fixture workspace: files that should sync (src/main.py, README.md) next to ones that must
 * not (node_modules/junk.js excluded via .gitignore, .env excluded by core.ts's hardcoded rule).
 *
 * node_modules also gets pushed past MAX_FILES (500, see core.ts) on its own — regression
 * coverage for a bug where the cap was checked against the *raw* findFiles scan instead of the
 * .gitignore-filtered set, so any workspace with a big ignored node_modules/build dir refused to
 * broadcast even though the actually-broadcastable file count was nowhere near the cap. */
function makeWorkspace(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "sourcebeam-it-"));
	mkdirSync(path.join(dir, "src"), { recursive: true });
	mkdirSync(path.join(dir, "node_modules"), { recursive: true });
	writeFileSync(path.join(dir, "src", "main.py"), "print('hello, sourcebeam')\n");
	writeFileSync(path.join(dir, "README.md"), "# hello\n");
	writeFileSync(path.join(dir, "node_modules", "junk.js"), "console.log('should not sync');\n");
	for (let i = 0; i < 520; i++) {
		writeFileSync(path.join(dir, "node_modules", `bloat-${i}.js`), "// filler\n");
	}
	// .env is kept out by .gitignore, the only thing that decides what stays private; .prettierrc
	// has no extension and must still broadcast (any text file does).
	writeFileSync(path.join(dir, ".env"), "SECRET=nope\n");
	writeFileSync(path.join(dir, ".prettierrc"), '{ "semi": false }\n');
	writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\n");
	return dir;
}

async function main(): Promise<void> {
	await checkServerUp();

	console.log("Building extension (bun run build)...");
	run(["bun", "run", "build"], extensionDevelopmentPath);

	console.log("Compiling integration test suite (tsc)...");
	run(["bunx", "tsc", "-p", path.join(integrationDir, "tsconfig.json")], extensionDevelopmentPath);

	const workspaceDir = makeWorkspace();
	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [workspaceDir, "--disable-extensions"],
		});
	} finally {
		rmSync(workspaceDir, { recursive: true, force: true });
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err instanceof Error ? err.stack ?? err.message : err);
		process.exit(1);
	},
);
