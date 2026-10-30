// Entry point for `bun run test:integration` — launches a real VS Code (extension host + a
// visible window; there's no headless mode without xvfb) and runs tests/integration/suite
// against it. Requires the local sourcebeam preview server (`bun run --cwd apps/web preview`)
// to already be listening on :4173 — this script doesn't manage it, see README.
//
// @vscode/test-electron's extensionTestsPath is `require()`d by the extension host itself,
// a plain Node process with no TypeScript/ESM loader — so the suite is precompiled to
// CommonJS (tsconfig.json in this folder) before runTests() is invoked below.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

const extensionDevelopmentPath = path.resolve(import.meta.dir, "../..");
const integrationDir = path.resolve(import.meta.dir);
const extensionTestsPath = path.join(integrationDir, "out", "suite", "index.js");

function run(cmd: string[], cwd: string, env?: Record<string, string>): void {
	const [bin, ...args] = cmd;
	const result = spawnSync(bin!, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
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
 * not (node_modules/junk.js and .env excluded via .gitignore, .git/ always, a binary and an
 * oversized file by the policy).
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
	// Never sent, whatever .gitignore says: .git/ is blocked outright, binaries and files over the
	// server's size cap (512 KiB) are skipped by the policy.
	mkdirSync(path.join(dir, ".git"), { recursive: true });
	writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
	writeFileSync(path.join(dir, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
	writeFileSync(path.join(dir, "big.txt"), "x".repeat(600 * 1024));
	return dir;
}

/** The same suite entry point again, in Restricted Mode. What differs from runTests():
 * - runTests() always passes --disable-workspace-trust, so this launches VS Code itself, with a
 *   fresh profile (no earlier trust decision leaks in) and startupPrompt "never" so the folder
 *   opens untrusted instead of behind a modal;
 * - VS Code never disables an extension under development, whatever the workspace trust, so the
 *   extension is packaged and installed like a user's copy, and --extensionDevelopmentPath points
 *   at an empty stub only because the test runner can't load without one;
 * - the compiled suite is copied into the installed extension: `require("vscode")` hands each
 *   extension its own API object by file path, and helpers.ts's stubs of vscode.window only
 *   reach the extension when the tests share its object;
 * - no --disable-extensions, which would switch the installed copy off as well.
 * SOURCEBEAM_IT_UNTRUSTED makes suite/index.ts load only untrusted.test.js. */
function runUntrusted(vscodeExecutablePath: string, workspaceDir: string): void {
	const root = path.join(extensionDevelopmentPath, ".vscode-test", "untrusted");
	const userDataDir = path.join(root, "user-data");
	const extensionsDir = path.join(root, "extensions");
	const stubDir = path.join(root, "stub");
	const vsix = path.join(root, "sourcebeam.vsix");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(path.join(userDataDir, "User"), { recursive: true });
	mkdirSync(stubDir, { recursive: true });
	writeFileSync(
		path.join(userDataDir, "User", "settings.json"),
		JSON.stringify({ "security.workspace.trust.startupPrompt": "never" }),
	);
	const profile = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`];

	run(["bunx", "@vscode/vsce", "package", "--no-dependencies", "--out", vsix], extensionDevelopmentPath);
	run(
		[resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath), ...profile, "--install-extension", vsix],
		extensionDevelopmentPath,
	);
	const installed = readdirSync(extensionsDir).find((name) => name.startsWith("krowten.sourcebeam-vscode-"));
	if (!installed) throw new Error(`the packaged extension did not install into ${extensionsDir}`);
	const suiteCopy = path.join(extensionsDir, installed, "integration-tests");
	cpSync(path.join(integrationDir, "out"), suiteCopy, { recursive: true });
	run(
		[
			vscodeExecutablePath,
			workspaceDir,
			"--no-sandbox",
			"--disable-gpu-sandbox",
			"--disable-updates",
			"--skip-welcome",
			"--skip-release-notes",
			"--no-cached-data",
			`--extensionTestsPath=${path.join(suiteCopy, "suite", "index.js")}`,
			`--extensionDevelopmentPath=${stubDir}`,
			...profile,
		],
		extensionDevelopmentPath,
		{ SOURCEBEAM_IT_UNTRUSTED: "1" },
	);
}

async function main(): Promise<void> {
	await checkServerUp();

	console.log("Building extension (bun run build)...");
	run(["bun", "run", "build"], extensionDevelopmentPath);

	console.log("Compiling integration test suite (tsc)...");
	run(["bunx", "tsc", "-p", path.join(integrationDir, "tsconfig.json")], extensionDevelopmentPath);

	const vscodeExecutablePath = await downloadAndUnzipVSCode();
	const workspaceDir = makeWorkspace();
	try {
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [workspaceDir, "--disable-extensions"],
		});
	} finally {
		rmSync(workspaceDir, { recursive: true, force: true });
	}

	console.log("Running the Restricted Mode suite (untrusted workspace)...");
	const untrustedDir = makeWorkspace();
	try {
		runUntrusted(vscodeExecutablePath, untrustedDir);
	} finally {
		rmSync(untrustedDir, { recursive: true, force: true });
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err instanceof Error ? err.stack ?? err.message : err);
		process.exit(1);
	},
);
