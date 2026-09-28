// Activity Bar view: the few things that change per broadcast session (project, start/stop,
// invite link), trimmed to one click each. Everything infrequent or global — server URL,
// host token, invite TTL, revoke, delete — lives one level down behind "Settings…", which opens
// a webview form with all four settings and their current values in one place instead of
// scattering them across the native Settings UI and a separate password prompt. Status isn't a
// row here: it's a badge on the Activity Bar icon itself (see TreeView.badge in extension.ts)
// and the existing status bar item.
import * as vscode from "vscode";

export type SidebarStatus = "live" | "reconnecting" | "off";

export type SidebarState = {
	status: SidebarStatus;
	running: boolean;
	project: string;
};

type Row = { label: string; icon: string; command?: string };

function buildRows(state: SidebarState): Row[] {
	return [
		{
			label: `Project: ${state.project || "(not set)"}`,
			icon: "symbol-namespace",
			command: "sourcebeam.pickProject",
		},
		state.running
			? { label: "Stop Broadcasting", icon: "debug-stop", command: "sourcebeam.stop" }
			: { label: "Start Broadcasting", icon: "play", command: "sourcebeam.start" },
		{ label: "Copy Invite Link", icon: "link", command: "sourcebeam.copyInvite" },
		{ label: "Settings…", icon: "settings-gear", command: "sourcebeam.moreActions" },
	];
}

export type SourcebeamTreeDataProvider = vscode.TreeDataProvider<Row> & { refresh(): void };

export function createSourcebeamTreeDataProvider(getState: () => SidebarState): SourcebeamTreeDataProvider {
	const emitter = new vscode.EventEmitter<void>();
	return {
		onDidChangeTreeData: emitter.event,
		refresh: () => emitter.fire(),
		getTreeItem(row: Row): vscode.TreeItem {
			const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon(row.icon);
			if (row.command) item.command = { command: row.command, title: row.label };
			return item;
		},
		getChildren(): Row[] {
			return buildRows(getState());
		},
	};
}

/** Badge shown on the Activity Bar icon itself — VS Code's supported way to reflect state on a
 * static contributed icon (there's no API to swap the icon image at runtime). */
export function badgeFor(status: SidebarStatus): vscode.ViewBadge | undefined {
	switch (status) {
		case "live":
			return { value: 1, tooltip: "Sourcebeam: broadcasting" };
		case "reconnecting":
			return { value: 1, tooltip: "Sourcebeam: reconnecting" };
		case "off":
			return undefined;
	}
}
