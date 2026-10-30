// Invite lifetime as the host asks for it: the link minted by sourcebeam.copyInvite expires after
// the configured number of hours, 6 when the workspace sets none. The expiry is read the way the
// server does, from the `<unix-seconds>.<mac>` token in the copied URL.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

import { clearConfig, ensureToken, setConfig, uniqueProjectId, waitForInviteUrl } from "./helpers";

const SLACK_SECONDS = 120;

async function setTtlHours(target: vscode.ConfigurationTarget, hours: number | undefined): Promise<void> {
	await vscode.workspace.getConfiguration("sourcebeam").update("inviteTtlHours", hours, target);
}

/** Starts a fresh project, copies one invite and returns how many seconds from now it expires. */
async function mintedLifetimeSeconds(): Promise<number> {
	const project = uniqueProjectId("vs-ttl");
	await setConfig(project);
	await vscode.commands.executeCommand("sourcebeam.start");
	try {
		const before = Math.floor(Date.now() / 1000);
		const url = new URL(await waitForInviteUrl(project));
		const expiry = Number(url.searchParams.get("token")!.split(".")[0]);
		assert.ok(Number.isInteger(expiry), "the invite token starts with an integer expiry");
		return expiry - before;
	} finally {
		await vscode.commands.executeCommand("sourcebeam.stop");
	}
}

function assertAbout(actual: number, hours: number): void {
	const expected = hours * 3600;
	assert.ok(
		Math.abs(actual - expected) <= SLACK_SECONDS,
		`expected a lifetime near ${hours} h (${expected} s), got ${actual} s`,
	);
}

suite("invite lifetime (integration)", function () {
	this.timeout(120_000);

	suiteSetup(async () => {
		await setConfig(uniqueProjectId("vs-ttl")); // setToken needs the server URL first
		await ensureToken();
	});

	teardown(async () => {
		await setTtlHours(vscode.ConfigurationTarget.Workspace, undefined);
		await setTtlHours(vscode.ConfigurationTarget.Global, undefined);
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand("sourcebeam.stop");
		await clearConfig();
	});

	test("invite lifetime - the configured hours are what the minted link expires after", async () => {
		await setTtlHours(vscode.ConfigurationTarget.Workspace, 2);
		assertAbout(await mintedLifetimeSeconds(), 2);
	});

	test("invite lifetime - 6 hours when the workspace sets none, and a User-level value is ignored", async () => {
		assertAbout(await mintedLifetimeSeconds(), 6);

		await setTtlHours(vscode.ConfigurationTarget.Global, 1);
		assertAbout(await mintedLifetimeSeconds(), 6);
	});
});
