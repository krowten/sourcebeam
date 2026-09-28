// Mocha entry point for the real-VS-Code integration suite. Compiled to CommonJS (see
// ../tsconfig.json) because @vscode/test-electron's extensionTestsPath is loaded with the
// extension host's own require() — it has no TypeScript/ESM loader.
import * as path from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: "tdd", timeout: 120_000, color: true });
	mocha.addFile(path.resolve(__dirname, "extension.test.js"));

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
