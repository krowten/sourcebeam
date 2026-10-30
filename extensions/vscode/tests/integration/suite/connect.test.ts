// A broadcast that cannot connect: it must not pretend to be running. A failed first connect
// stops it with an error that says what is wrong, and Copy Invite stays unavailable until the
// connection is live instead of copying something else.
import type { AddressInfo } from "node:net";

import * as assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import * as vscode from "vscode";

import { clearConfig, ensureToken, stub, uniqueProjectId, waitFor } from "./helpers";
import { startProxy } from "./proxy";

async function useServer(url: string): Promise<void> {
	const cfg = vscode.workspace.getConfiguration("sourcebeam");
	await cfg.update("serverUrl", url, vscode.ConfigurationTarget.Global);
	await cfg.update("project", uniqueProjectId("connect"), vscode.ConfigurationTarget.Workspace);
	// The token is stored per server origin.
	await ensureToken();
}

/** Starts, waits for the error naming `expected`, then checks the broadcast really stopped. */
async function expectStartToFail(expected: string): Promise<void> {
	await vscode.env.clipboard.writeText("untouched");
	const errors = stub("showErrorMessage", () => undefined);
	const infos = stub("showInformationMessage", () => undefined);
	try {
		await vscode.commands.executeCommand("sourcebeam.start");
		await waitFor(() => errors.calls.some((c) => String(c[0]).includes(expected)), 15_000, `an error mentioning "${expected}"`);
		// Stopped for real: Copy Invite asks to start (not to wait), and a new start is not "already running".
		await vscode.commands.executeCommand("sourcebeam.copyInvite");
		await waitFor(() => infos.calls.length > 0, 5000, "the copy invite notice");
		assert.match(String(infos.calls[0]![0]), /start broadcasting first/);
		assert.equal(await vscode.env.clipboard.readText(), "untouched");
	} finally {
		infos.restore();
		errors.restore();
	}
}

suite("sourcebeam connect errors (integration)", function () {
	this.timeout(60_000);

	teardown(async () => {
		await vscode.commands.executeCommand("sourcebeam.stop");
	});

	suiteTeardown(clearConfig);

	test("connect error: an unreachable server stops the broadcast with an error naming it", async () => {
		const closed = createServer();
		await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
		const url = `ws://127.0.0.1:${(closed.address() as AddressInfo).port}`;
		await new Promise((resolve) => closed.close(resolve));

		await useServer(url);
		await expectStartToFail(`can't connect to ${url}`);
	});

	test("connect error: a server that is not Sourcebeam (HTTP 404) stops the broadcast", async () => {
		const notFound = createHttpServer((_req, res) => res.writeHead(404).end());
		await new Promise<void>((resolve) => notFound.listen(0, "127.0.0.1", resolve));
		try {
			await useServer(`ws://127.0.0.1:${(notFound.address() as AddressInfo).port}`);
			await expectStartToFail("HTTP 404");
		} finally {
			notFound.closeAllConnections();
			await new Promise((resolve) => notFound.close(resolve));
		}
	});

	test("connect error: while still connecting, Copy Invite says so and copies nothing", async () => {
		const proxy = await startProxy();
		try {
			await useServer(proxy.url);
			proxy.hold();
			await vscode.env.clipboard.writeText("untouched");
			const infos = stub("showInformationMessage", () => undefined);
			try {
				await vscode.commands.executeCommand("sourcebeam.start");
				await waitFor(() => proxy.attempts() > 0, 10_000, "the connect attempt", 50);
				await vscode.commands.executeCommand("sourcebeam.copyInvite");
				await waitFor(() => infos.calls.length > 0, 5000, "the copy invite notice");
				assert.match(String(infos.calls[0]![0]), /not connected to the server yet/);
				assert.equal(await vscode.env.clipboard.readText(), "untouched");
			} finally {
				infos.restore();
			}
		} finally {
			await vscode.commands.executeCommand("sourcebeam.stop");
			proxy.release();
			await proxy.close();
		}
	});
});
