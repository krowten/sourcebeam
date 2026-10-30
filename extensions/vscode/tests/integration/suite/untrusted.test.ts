// Restricted Mode. runner.ts loads this file in the normal run and then once more on its own in a
// VS Code with Workspace Trust enabled, where the fixture folder opens untrusted. The extension
// declares untrustedWorkspaces.supported (it only reads files and never runs anything from the
// workspace), so it has to activate and broadcast there exactly as it does in a trusted one.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

import {
	clearConfig,
	connectViewerWithTree,
	ensureToken,
	exchangeInviteForCookie,
	setConfig,
	sleep,
	uniqueProjectId,
	waitFor,
	waitForInviteUrl,
	writeText,
} from "./helpers";

const { SOURCEBEAM_IT_UNTRUSTED } = process.env;
const untrusted = SOURCEBEAM_IT_UNTRUSTED === "1";

suite("workspace trust (integration)", function () {
	this.timeout(120_000);

	suiteTeardown(async () => {
		await vscode.commands.executeCommand("sourcebeam.stop");
		await clearConfig();
	});

	// Guards the setup itself: if both runs ever ended up with the same trust state, the
	// Restricted Mode run below would prove nothing.
	test(`workspace trust: isTrusted is ${!untrusted} in this run`, () => {
		assert.equal(vscode.workspace.isTrusted, !untrusted);
	});

	(untrusted ? test : test.skip)("untrusted project: snapshot, live update, stop", async () => {
		// Without untrustedWorkspaces support VS Code never loads the extension in Restricted Mode.
		const ext = vscode.extensions.getExtension("krowten.sourcebeam-vscode");
		assert.ok(ext, "the extension is not loaded in Restricted Mode");
		await ext.activate();

		const project = uniqueProjectId("untrusted");
		await setConfig(project);
		// A fresh profile: the token from the trusted run's SecretStorage isn't here.
		await ensureToken();
		await vscode.commands.executeCommand("sourcebeam.start");

		const cookie = await exchangeInviteForCookie(await waitForInviteUrl(project));
		const { ws, messages } = await connectViewerWithTree(project, cookie, ["src/main.py", "README.md"]);
		try {
			const fileContent = (content: string) =>
				messages.some((m) => m.type === "file" && m.path === "src/main.py" && m.content === content);
			ws.send(JSON.stringify({ type: "subscribe", path: "src/main.py" }));
			await waitFor(() => fileContent("print('hello, sourcebeam')\n"), 5000, "initial file content");

			const updated = "print('hello, sourcebeam')\nprint('untrusted')\n";
			await writeText("src/main.py", updated);
			await waitFor(() => fileContent(updated), 10_000, "live-updated file content");

			await vscode.commands.executeCommand("sourcebeam.stop");
			const countAfterStop = messages.length;
			await writeText("src/main.py", "print('after stop')\n");
			await sleep(2000);
			assert.equal(messages.length, countAfterStop, "no messages should arrive on the viewer after stop()");
		} finally {
			ws.close();
		}
	});
});
