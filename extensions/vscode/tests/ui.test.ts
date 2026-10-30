// The parts of the sidebar and the settings panel that never need an editor: what rows the tree
// shows for a state, and what the webview's own script does with the state it is sent and with a
// click on Save. The real-editor side is tests/integration/suite/ui.test.ts. `vscode` only exists
// inside an editor host, so a minimal stand-in for the few classes these modules construct is
// registered before they are imported.
import type * as vscode from "vscode";
import type { SidebarState } from "../src/sidebar";

import { expect, mock, test } from "bun:test";

mock.module("vscode", () => ({
	EventEmitter: class {
		event = () => {};
		fire() {}
	},
	TreeItem: class {
		command?: unknown;
		iconPath?: unknown;
		constructor(
			public label: string,
			public collapsibleState: number,
		) {}
	},
	TreeItemCollapsibleState: { None: 0 },
	ThemeIcon: class {
		constructor(public id: string) {}
	},
}));

const { badgeFor, createSourcebeamTreeDataProvider } = await import("../src/sidebar");
const { renderSettingsHtml } = await import("../src/settingsPanel");

type TreeRow = { label: string; command?: string };

function rowsFor(state: SidebarState) {
	const provider = createSourcebeamTreeDataProvider(() => state);
	return (provider.getChildren() as unknown as TreeRow[]).map((row) => {
		const item = provider.getTreeItem(row as never) as vscode.TreeItem;
		return { label: String(item.label), command: item.command?.command };
	});
}

test("sidebar offers Start when off and Stop while running, both bound to their commands", () => {
	const off = rowsFor({ status: "off", running: false, project: "demo" });
	expect(off).toContainEqual({ label: "Start Broadcasting", command: "sourcebeam.start" });
	expect(off.some((r) => r.command === "sourcebeam.stop")).toBe(false);

	const live = rowsFor({ status: "live", running: true, project: "demo" });
	expect(live).toContainEqual({ label: "Stop Broadcasting", command: "sourcebeam.stop" });
	expect(live.some((r) => r.command === "sourcebeam.start")).toBe(false);
});

test("sidebar shows the project id, or a placeholder, and always offers settings", () => {
	expect(rowsFor({ status: "off", running: false, project: "demo" })).toContainEqual({
		label: "Project: demo",
		command: "sourcebeam.pickProject",
	});
	expect(rowsFor({ status: "off", running: false, project: "" })[0]).toEqual({
		label: "Project: (not set)",
		command: "sourcebeam.pickProject",
	});
	for (const running of [false, true]) {
		const rows = rowsFor({ status: running ? "live" : "off", running, project: "demo" });
		expect(rows).toContainEqual({ label: "Settings…", command: "sourcebeam.moreActions" });
	}
});

test("sidebar offers Copy Invite Link only while live, not while started but still connecting", () => {
	const has = (status: "off" | "reconnecting" | "live", running: boolean) =>
		rowsFor({ status, running, project: "demo" }).some((r) => r.command === "sourcebeam.copyInvite");
	expect(has("live", true)).toBe(true);
	expect(has("off", true)).toBe(false);
	expect(has("reconnecting", true)).toBe(false);
	expect(has("off", false)).toBe(false);
});

test("the Activity Bar badge follows the status", () => {
	expect(badgeFor("off")).toBeUndefined();
	expect(badgeFor("live")?.tooltip).toBe("Sourcebeam: broadcasting");
	expect(badgeFor("reconnecting")?.tooltip).toBe("Sourcebeam: reconnecting");
});

// --- the settings webview -----------------------------------------------------

const html = renderSettingsHtml({ cspSource: "vscode-resource:" } as never);

test("settings HTML has a field for every setting, with the script allowed by a per-render nonce only", () => {
	for (const id of ["server", "project", "ttl", "token", "save", "revoke", "delete"]) {
		expect(html).toContain(`id="${id}"`);
	}
	const scriptNonce = html.match(/<script nonce="([^"]+)"/)![1];
	expect(html).toContain(`script-src 'nonce-${scriptNonce}'`);
	expect(html).toContain("default-src 'none'");
	expect(renderSettingsHtml({ cspSource: "x" } as never)).not.toContain(scriptNonce!);
});

type Element = {
	value: string;
	textContent: string;
	disabled: boolean;
	style: { display: string };
	classList: { add(c: string): void; remove(c: string): void };
	listeners: Record<string, () => void>;
	addEventListener(type: string, fn: () => void): void;
};

/** Runs the page's script against a stand-in DOM: enough to deliver a message to it and click Save. */
function runWebview() {
	const elements = new Map<string, Element>();
	const el = (id: string): Element => {
		if (!elements.has(id)) {
			elements.set(id, {
				value: "",
				textContent: "",
				disabled: false,
				style: { display: "" },
				classList: { add() {}, remove() {} },
				listeners: {},
				addEventListener(type, fn) {
					this.listeners[type] = fn;
				},
			});
		}
		return elements.get(id)!;
	};
	const posted: unknown[] = [];
	let onMessage: (event: { data: unknown }) => void = () => {};
	const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]!;
	new Function("acquireVsCodeApi", "document", "window", "setTimeout", script)(
		() => ({ postMessage: (m: unknown) => posted.push(m) }),
		{ getElementById: el },
		{ addEventListener: (_: string, fn: typeof onMessage) => (onMessage = fn) },
		() => {},
	);
	return { el, posted, send: (data: unknown) => onMessage({ data }) };
}

const state = { server: "wss://h", project: "demo", ttl: 6, hasToken: true, workspaceOpen: true, workspaceName: "demo-folder", running: false };

test("the webview fills its fields from the state it is sent and gates Revoke and Delete on running", () => {
	const page = runWebview();
	page.send({ command: "state", state });
	expect(page.el("server").value).toBe("wss://h");
	expect(page.el("project").value).toBe("demo");
	expect(page.el("ttl").value).toBe("6");
	expect(page.el("token-status").textContent).toBe("set");
	expect(page.el("scope-hint").textContent).toBe("Editing for workspace: demo-folder");
	expect(page.el("revoke").disabled).toBe(true);
	expect(page.el("delete").disabled).toBe(true);

	page.send({ command: "state", state: { ...state, running: true } });
	expect(page.el("revoke").disabled).toBe(false);
	expect(page.el("delete").disabled).toBe(false);
});

test("without a workspace the webview locks the per-workspace fields and says so", () => {
	const page = runWebview();
	page.send({ command: "state", state: { ...state, workspaceOpen: false, hasToken: false } });
	expect(page.el("project").disabled).toBe(true);
	expect(page.el("ttl").disabled).toBe(true);
	expect(page.el("token-status").textContent).toBe("not set");
	expect(page.el("scope-hint").textContent).toContain("No workspace open");
});

test("Save posts the form and then wipes the token field; an error shows under its field", () => {
	const page = runWebview();
	page.send({ command: "state", state });
	page.el("server").value = "wss://other";
	page.el("project").value = "renamed";
	page.el("ttl").value = "12";
	page.el("token").value = "secret";
	page.el("save").listeners.click!();
	expect(page.posted).toEqual([{ command: "save", server: "wss://other", project: "renamed", ttl: 12, token: "secret" }]);
	expect(page.el("token").value).toBe("");

	page.send({ command: "error", field: "server", message: "nope" });
	expect(page.el("server-error").textContent).toBe("nope");
	expect(page.el("server-error").style.display).toBe("block");
	page.el("save").listeners.click!();
	expect(page.el("server-error").style.display).toBe("none");
});

test("Revoke and Delete post their commands", () => {
	const page = runWebview();
	page.el("revoke").listeners.click!();
	page.el("delete").listeners.click!();
	expect(page.posted).toEqual([{ command: "revoke" }, { command: "delete" }]);
});
