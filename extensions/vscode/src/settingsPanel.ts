// The JetBrains plugin's Settings | Tools | Sourcebeam is one dialog with every field visible at
// once; VS Code's native Settings UI can't do that for an extension's own settings (they're just
// rows in a flat list, one per setting, alongside every other extension's). A webview is the only
// way to get the same "one form" feel here, so this renders one instead of chaining separate
// QuickPick/InputBox prompts (what "Settings…" used to do — see extension.ts's old moreActions).
//
// Deliberately plain HTML/CSS driven entirely by VS Code's own `--vscode-*` CSS variables, no
// webview-ui-toolkit or other dependency — four fields and three buttons don't need one, and the
// variables already make it look native in whatever theme is active.
import * as vscode from "vscode";

export type SettingsPanelState = {
	server: string;
	project: string;
	ttl: number;
	hasToken: boolean;
	workspaceOpen: boolean;
	workspaceName: string;
	running: boolean;
};

export type FromWebviewMessage =
	| { command: "save"; server: string; project: string; ttl: number; token: string }
	| { command: "revoke" }
	| { command: "delete" };

export type ToWebviewMessage =
	| { command: "state"; state: SettingsPanelState }
	| { command: "error"; field: "server" | "project" | "ttl" | "token"; message: string }
	| { command: "saved" };

function nonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let text = "";
	for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
	return text;
}

export function renderSettingsHtml(webview: vscode.Webview): string {
	const n = nonce();
	const csp = [
		`default-src 'none'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${n}'`,
	].join("; ");

	return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		padding: 0 20px 20px;
		max-width: 560px;
	}
	h2 { font-weight: 600; margin-bottom: 4px; }
	.field { margin-bottom: 16px; }
	label { display: block; font-weight: 600; margin-bottom: 4px; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
	.error { color: var(--vscode-errorForeground); font-size: 0.9em; margin-top: 4px; display: none; }
	input[type="text"], input[type="password"], input[type="number"] {
		width: 100%;
		box-sizing: border-box;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent);
		padding: 4px 6px;
		border-radius: 2px;
	}
	input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	fieldset { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 12px 16px; margin: 24px 0; }
	legend { padding: 0 6px; color: var(--vscode-descriptionForeground); }
	button {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		padding: 6px 14px;
		border-radius: 2px;
		cursor: pointer;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled { opacity: 0.5; cursor: not-allowed; }
	.actions { display: flex; gap: 8px; margin-top: 20px; }
	.danger-zone { display: flex; gap: 8px; }
	.saved-flash { color: var(--vscode-terminal-ansiGreen, #89d185); font-size: 0.9em; margin-left: 12px; opacity: 0; transition: opacity 0.2s; }
	.saved-flash.show { opacity: 1; }
</style>
</head>
<body>
	<h2>Sourcebeam</h2>
	<p class="hint" id="scope-hint"></p>

	<div class="field">
		<label for="server">Server URL</label>
		<input type="text" id="server" placeholder="wss://sourcebeam.&lt;sub&gt;.workers.dev">
		<div class="hint">Global — shared by every workspace on this machine.</div>
		<div class="error" id="server-error"></div>
	</div>

	<div class="field">
		<label for="project">Project id</label>
		<input type="text" id="project" placeholder="lowercase, digits, hyphens, underscores">
		<div class="hint">Per-workspace — defaults to the folder's name, sanitized, if left blank.</div>
		<div class="error" id="project-error"></div>
	</div>

	<div class="field">
		<label for="ttl">Invite link lifetime (hours)</label>
		<input type="number" id="ttl" min="1" max="720" step="1">
		<div class="hint">Per-workspace — 6 hours unless you change it here.</div>
		<div class="error" id="ttl-error"></div>
	</div>

	<fieldset>
		<legend>Host token</legend>
		<div class="field" style="margin-bottom: 8px">
			<label for="token">Currently: <span id="token-status"></span> — leave blank to keep it unchanged</label>
			<input type="password" id="token" placeholder="paste a new token to set or replace it">
			<div class="hint">Global — stored per server URL, shared by every workspace.</div>
			<div class="error" id="token-error"></div>
		</div>
	</fieldset>

	<div class="actions">
		<button id="save">Save</button>
		<span class="saved-flash" id="saved-flash">Saved</span>
	</div>

	<fieldset>
		<legend>Danger zone</legend>
		<div class="danger-zone">
			<button class="secondary" id="revoke">Revoke Invite Links</button>
			<button class="secondary" id="delete">Delete Project</button>
		</div>
		<div class="hint">Both require broadcasting to be running.</div>
	</fieldset>

	<script nonce="${n}">
		const vscode = acquireVsCodeApi();
		const el = (id) => document.getElementById(id);

		function applyState(state) {
			el("server").value = state.server;
			el("project").value = state.project;
			el("ttl").value = String(state.ttl);
			el("token-status").textContent = state.hasToken ? "set" : "not set";
			el("scope-hint").textContent = state.workspaceOpen
				? "Editing for workspace: " + state.workspaceName
				: "No workspace open — the project id and invite link lifetime aren't available.";
			el("project").disabled = !state.workspaceOpen;
			el("ttl").disabled = !state.workspaceOpen;
			el("revoke").disabled = !state.running;
			el("delete").disabled = !state.running;
		}

		function clearErrors() {
			for (const field of ["server", "project", "ttl", "token"]) {
				const e = el(field + "-error");
				e.style.display = "none";
				e.textContent = "";
			}
		}

		window.addEventListener("message", (event) => {
			const msg = event.data;
			if (msg.command === "state") applyState(msg.state);
			else if (msg.command === "error") {
				const e = el(msg.field + "-error");
				e.textContent = msg.message;
				e.style.display = "block";
			} else if (msg.command === "saved") {
				const flash = el("saved-flash");
				flash.classList.add("show");
				setTimeout(() => flash.classList.remove("show"), 1500);
			}
		});

		el("save").addEventListener("click", () => {
			clearErrors();
			vscode.postMessage({
				command: "save",
				server: el("server").value,
				project: el("project").value,
				ttl: Number(el("ttl").value),
				token: el("token").value,
			});
			el("token").value = "";
		});
		el("revoke").addEventListener("click", () => vscode.postMessage({ command: "revoke" }));
		el("delete").addEventListener("click", () => vscode.postMessage({ command: "delete" }));
	</script>
</body>
</html>`;
}
