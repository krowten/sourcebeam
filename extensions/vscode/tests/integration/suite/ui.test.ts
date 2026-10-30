// The UI pieces — settings commands, the settings panel, the status bar toggle, the sidebar's
// commands and their dialogs — driven through the entry points a user triggers, without a DOM
// robot. The JetBrains counterpart is UiIntegrationTest.kt; scenario names match where both hosts
// have the concept. What the extension host cannot observe (status bar text, sidebar rows, the
// panel's HTML and its message handling) is covered as pure logic in tests/ui.test.ts instead.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

import {
	SERVER_URL,
	clearConfig,
	connectViewerWithTree,
	ensureToken,
	exchangeInviteForCookie,
	setConfig,
	sleep,
	stub,
	uniqueProjectId,
	waitFor,
	waitForInviteUrl,
	withLiveViewer,
} from "./helpers";

type InputBoxOptions = { prompt?: string; value?: string; validateInput?: (value: string) => string | null | undefined };

const config = () => vscode.workspace.getConfiguration("sourcebeam");

/** Seconds until an invite link stops opening, read from the `<expiry>.<mac>` token in it. */
function inviteSecondsLeft(url: string): number {
	return Number(new URL(url).searchParams.get("token")!.split(".")[0]) - Date.now() / 1000;
}

/** Runs a command that answers through showInputBox and waits for the prompt to have been shown
 * and answered (the command handlers are fire-and-forget, so executeCommand resolves early). */
async function answerInput(command: string, answer: string | undefined): Promise<InputBoxOptions> {
	const inputs = stub("showInputBox", async () => answer);
	try {
		await vscode.commands.executeCommand(command);
		await waitFor(() => inputs.calls.length > 0, 5000, `${command} to ask for input`);
		await sleep(300);
		return inputs.calls[0]![0] as InputBoxOptions;
	} finally {
		inputs.restore();
	}
}

function settingsTabs(): vscode.Tab[] {
	return vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("sourcebeam.settings"));
}

async function closeSettingsTabs(): Promise<void> {
	await vscode.window.tabGroups.close(settingsTabs());
	await waitFor(() => settingsTabs().length === 0, 5000, "the settings panel to close");
}

suite("sourcebeam UI (integration)", function () {
	this.timeout(120_000);

	suiteSetup(async () => {
		await setConfig(uniqueProjectId("ui"));
		await ensureToken();
	});

	teardown(async () => {
		await vscode.commands.executeCommand("sourcebeam.stop");
		await config().update("inviteTtlHours", undefined, vscode.ConfigurationTarget.Workspace);
		await closeSettingsTabs();
	});

	suiteTeardown(async () => {
		await clearConfig();
	});

	test("settings round trip: server URL, project, TTL and token set through the UI are what start uses", async () => {
		await clearConfig();
		await config().update("project", undefined, vscode.ConfigurationTarget.Workspace);
		const project = uniqueProjectId("ui-rt");
		// Same Worker, different origin: the token stored for localhost does not carry over to it.
		const otherOrigin = "ws://127.0.0.1:4173";

		// Server URL: a trailing slash is what people paste; the stored value is the bare origin.
		await answerInput("sourcebeam.pickServer", `${otherOrigin}/`);
		await waitFor(() => config().get("serverUrl") === otherOrigin, 5000, "the server URL to be stored normalized");
		await answerInput("sourcebeam.pickProject", project);
		await waitFor(() => config().get("project") === project, 5000, "the project to be stored");
		// Invite lifetime has no prompt: it is a plain per-workspace setting.
		await config().update("inviteTtlHours", 1, vscode.ConfigurationTarget.Workspace);

		const errors = stub("showErrorMessage", () => undefined);
		const infos = stub("showInformationMessage", () => undefined);
		try {
			await vscode.commands.executeCommand("sourcebeam.start");
			await waitFor(() => errors.calls.some((c) => String(c[0]).includes("No token set")), 5000, "the no-token error");

			await answerInput("sourcebeam.setToken", "dev-host");
			await waitFor(() => infos.calls.some((c) => String(c[0]).includes("token saved")), 5000, "token saved confirmation");
		} finally {
			infos.restore();
			errors.restore();
		}

		await vscode.commands.executeCommand("sourcebeam.start");
		// waitForInviteUrl only knows the localhost origin, so poll the clipboard here.
		await vscode.env.clipboard.writeText("");
		const prefix = `http://127.0.0.1:4173/${project}?token=`;
		let invite = "";
		for (const deadline = Date.now() + 15_000; !invite.startsWith(prefix) && Date.now() < deadline; ) {
			await vscode.commands.executeCommand("sourcebeam.copyInvite");
			await sleep(400);
			invite = await vscode.env.clipboard.readText();
		}
		assert.ok(invite.startsWith(prefix), `invite for the edited server and project, got: ${invite}`);
		const left = inviteSecondsLeft(invite);
		assert.ok(left > 3500 && left < 3700, `invite lifetime ~1h, got ${left}s`);
	});

	test("settings round trip: the prompts show the current value and a cancelled prompt changes nothing", async () => {
		const project = uniqueProjectId("ui-cancel");
		await setConfig(project);

		const server = await answerInput("sourcebeam.pickServer", undefined);
		assert.equal(server.value, SERVER_URL);
		assert.equal(config().get("serverUrl"), SERVER_URL);

		const picked = await answerInput("sourcebeam.pickProject", undefined);
		assert.equal(picked.value, project);
		assert.equal(config().get("project"), project);

		// An empty answer is how a user clears the field.
		await answerInput("sourcebeam.pickServer", "");
		await waitFor(() => config().get("serverUrl") === "", 5000, "the server URL to be cleared");
	});

	test("settings round trip: invalid input is rejected with the user-facing message", async () => {
		await setConfig(uniqueProjectId("ui-invalid"));

		const server = await answerInput("sourcebeam.pickServer", undefined);
		const checkServer = server.validateInput!;
		assert.equal(checkServer("ws://example.com"), "sourcebeam.serverUrl: ws:// is only allowed for localhost — use wss://.");
		assert.equal(checkServer("http://localhost:4173"), "sourcebeam.serverUrl: must start with ws:// or wss://.");
		assert.equal(checkServer("wss://example.com/path"), "sourcebeam.serverUrl: must be an origin only — no path, query or fragment.");
		assert.equal(checkServer("not a url"), "sourcebeam.serverUrl: must be a valid ws:// or wss:// URL.");
		assert.equal(checkServer(""), null, "empty clears the setting");
		assert.equal(checkServer(SERVER_URL), null);

		const project = await answerInput("sourcebeam.pickProject", undefined);
		const checkProject = project.validateInput!;
		const rule = "lowercase letters, digits, hyphens, underscores; can't start with a hyphen or underscore";
		assert.equal(checkProject("Not Valid"), rule);
		assert.equal(checkProject("-leading-hyphen"), rule);
		assert.equal(checkProject("x".repeat(65)), rule);
		assert.equal(checkProject(""), null, "empty means the folder-name default");
		assert.equal(checkProject("fine_id-1"), null);
	});

	test("set host token: without a valid server URL it says so and does not ask for a token", async () => {
		await clearConfig();
		const errors = stub("showErrorMessage", () => undefined);
		const inputs = stub("showInputBox", async () => "should-not-be-asked");
		try {
			await vscode.commands.executeCommand("sourcebeam.setToken");
			await waitFor(() => errors.calls.length > 0, 5000, "the missing-server error");
			assert.equal(errors.calls[0]![0], "Sourcebeam: set a valid sourcebeam.serverUrl first — the token is stored per server.");
			assert.equal(inputs.calls.length, 0);
		} finally {
			inputs.restore();
			errors.restore();
		}
	});

	test("set host token: a wrong token is rejected by the server, a corrected one goes live", async () => {
		const project = uniqueProjectId("ui-token");
		await setConfig(project);
		const infos = stub("showInformationMessage", () => undefined);
		const errors = stub("showErrorMessage", () => undefined);
		try {
			await answerInput("sourcebeam.setToken", "wrong-token");
			await waitFor(() => infos.calls.length > 0, 5000, "token saved confirmation");
			await vscode.commands.executeCommand("sourcebeam.start");
			await waitFor(() => errors.calls.some((c) => String(c[0]).includes("invalid host token")), 15_000, "the rejected-token error");

			// Entering nothing or cancelling keeps whatever is stored.
			const saved = infos.calls.length;
			await answerInput("sourcebeam.setToken", "");
			await answerInput("sourcebeam.setToken", undefined);
			assert.equal(infos.calls.length, saved, "no confirmation when no token was entered");
		} finally {
			infos.restore();
			errors.restore();
		}

		// The correction goes through the same command and replaces the stored value.
		await ensureToken();
		await vscode.commands.executeCommand("sourcebeam.start");
		await waitForInviteUrl(project);
	});

	test("commands while stopped: they say to start first and do not prompt", async () => {
		await setConfig(uniqueProjectId("ui-stopped"));
		await vscode.env.clipboard.writeText("untouched");
		const infos = stub("showInformationMessage", () => undefined);
		const warnings = stub("showWarningMessage", async () => "Delete");
		try {
			for (const command of ["sourcebeam.copyInvite", "sourcebeam.revokeInvites", "sourcebeam.deleteProject"]) {
				const before = infos.calls.length;
				await vscode.commands.executeCommand(command);
				await waitFor(() => infos.calls.length > before, 5000, `${command} to answer`);
				assert.match(String(infos.calls[before]![0]), /start broadcasting first/);
			}
			assert.equal(warnings.calls.length, 0, "no confirmation is shown for a project that is not live");
			assert.equal(await vscode.env.clipboard.readText(), "untouched");

			await vscode.commands.executeCommand("sourcebeam.stop");
		} finally {
			warnings.restore();
			infos.restore();
		}
	});

	test("commands while running: start again says so instead of starting a second broadcast", async () => {
		await setConfig(uniqueProjectId("ui-twice"));
		await vscode.commands.executeCommand("sourcebeam.start");
		const infos = stub("showInformationMessage", () => undefined);
		try {
			await vscode.commands.executeCommand("sourcebeam.start");
			await waitFor(() => infos.calls.some((c) => String(c[0]).includes("already running")), 5000, "the already-running notice");
		} finally {
			infos.restore();
		}
	});

	test("status surfaces: the status bar item's toggle command starts and stops broadcasting", async () => {
		const project = uniqueProjectId("ui-toggle");
		await setConfig(project);

		await vscode.commands.executeCommand("sourcebeam.toggle");
		await waitForInviteUrl(project);

		await vscode.commands.executeCommand("sourcebeam.toggle");
		const infos = stub("showInformationMessage", () => undefined);
		try {
			await vscode.commands.executeCommand("sourcebeam.copyInvite");
			await waitFor(() => infos.calls.length > 0, 5000, "the stopped notice");
			assert.match(String(infos.calls[0]![0]), /start broadcasting first/);
		} finally {
			infos.restore();
		}
	});

	test("copy invite: a working link lands on the clipboard", async () => {
		await withLiveViewer("ui-copy", ["README.md"], async ({ project }) => {
			const infos = stub("showInformationMessage", () => undefined);
			try {
				await vscode.env.clipboard.writeText("");
				await vscode.commands.executeCommand("sourcebeam.copyInvite");
				await waitFor(() => infos.calls.some((c) => String(c[0]).includes("link copied to clipboard")), 10_000, "the copied confirmation");
			} finally {
				infos.restore();
			}
			const link = await vscode.env.clipboard.readText();
			assert.ok(link.startsWith(`http://localhost:4173/${project}?token=`), `unexpected clipboard content: ${link}`);

			// The link is the one a viewer follows: it must open the project and show its files.
			const { ws } = await connectViewerWithTree(project, await exchangeInviteForCookie(link), ["README.md"]);
			ws.close();
		});
	});

	test("delete project: asks for confirmation and does nothing when cancelled", async () => {
		await withLiveViewer("ui-del", ["README.md"], async ({ project, messages }) => {
			const warnings = stub("showWarningMessage", async () => undefined);
			try {
				await vscode.commands.executeCommand("sourcebeam.deleteProject");
				await waitFor(() => warnings.calls.length > 0, 5000, "the confirmation prompt");
				const [message, options, ...items] = warnings.calls[0]!;
				assert.match(String(message), /no way to undo/);
				assert.deepEqual(options, { modal: true });
				assert.deepEqual(items, ["Delete"]);

				await sleep(1500);
				assert.ok(!messages.some((m) => m.type === "project_deleted"), "the viewer must not be told the project is gone");
				await waitForInviteUrl(project); // still broadcasting
			} finally {
				warnings.restore();
			}

			const confirm = stub("showWarningMessage", async () => "Delete");
			try {
				await vscode.commands.executeCommand("sourcebeam.deleteProject");
				await waitFor(() => messages.some((m) => m.type === "project_deleted"), 10_000, "project_deleted after confirming");
			} finally {
				confirm.restore();
			}
		});
	});

	test("settings panel: Settings… opens one panel, reveals it instead of opening a second, and reopens after closing", async () => {
		assert.equal(settingsTabs().length, 0);

		await vscode.commands.executeCommand("sourcebeam.moreActions");
		await waitFor(() => settingsTabs().length === 1, 5000, "the settings panel to open");
		assert.equal(settingsTabs()[0]!.label, "Sourcebeam Settings");

		await vscode.commands.executeCommand("sourcebeam.moreActions");
		await sleep(500);
		assert.equal(settingsTabs().length, 1, "a second invocation must reveal the open panel");

		await closeSettingsTabs();
		await vscode.commands.executeCommand("sourcebeam.moreActions");
		await waitFor(() => settingsTabs().length === 1, 5000, "the settings panel to open again after being closed");
	});
});
