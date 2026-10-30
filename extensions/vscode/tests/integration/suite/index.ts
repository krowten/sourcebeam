// Mocha entry point for the real-VS-Code integration suite. Compiled to CommonJS (see
// ../tsconfig.json) because @vscode/test-electron's extensionTestsPath is loaded with the
// extension host's own require() — it has no TypeScript/ESM loader.
import { readdirSync } from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";

// Set by runner.ts's Restricted Mode run, which wants untrusted.test.js alone.
const { SOURCEBEAM_IT_UNTRUSTED } = process.env;

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: "tdd", timeout: 120_000, color: true });
	// Every *.test.js next to this file, extension.test.js first: it holds the activation checks
	// the other files take for granted.
	const files = readdirSync(__dirname).filter((f) =>
		SOURCEBEAM_IT_UNTRUSTED === "1" ? f === "untrusted.test.js" : f.endsWith(".test.js"),
	);
	files.sort((a, b) => Number(b === "extension.test.js") - Number(a === "extension.test.js") || a.localeCompare(b));
	for (const file of files) mocha.addFile(path.resolve(__dirname, file));

	return new Promise((resolve, reject) => {
		try {
			mocha.run((failures: number) => {
				if (failures > 0) reject(new Error(`${failures} integration test(s) failed.`));
				else resolve();
			});
		} catch (err) {
			reject(err);
		}
	});
}
