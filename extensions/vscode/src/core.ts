// Pure logic for the VS Code extension — no `vscode` import here on purpose, so this
// file is unit-testable with `bun test`. Wire types live in packages/protocol.

import ignoreFactory from "ignore";
import {
  DEBOUNCE_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  type FilePolicy,
  isHardBlocked,
  isText,
  isValidProjectId,
} from "@sourcebeam/protocol";

export const MAX_FILES = 500;
// Timing comes from the protocol package — both editor extensions coalesce for the same
// window and back off within the same bounds.
export { DEBOUNCE_MS, RECONNECT_MAX_MS, RECONNECT_MIN_MS };

// --- config -------------------------------------------------------------
// serverUrl/project come from VS Code settings, the host token from SecretStorage — see
// extension.ts's loadConfig(). This is the pure validation part, kept testable here.

export type Config = { server: string; token: string; project: string };

/** Validated to an origin only: ws(s)://host[:port], no path/query/fragment/credentials.
 *
 * The host token is scoped to this exact string (see hostTokenKey) — a workspace's committed
 * settings can set sourcebeam.serverUrl to anything, and cloning an untrusted repo must not be
 * able to redirect an already-saved token to a different origin by adding a path or query
 * string that still "looks like" the same server. Normalizing to a bare origin here, once,
 * means every later use of `server` (the WS URL, the token lookup, the copy-invite link) is
 * built from the same validated value instead of re-trusting the raw setting each time. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function validateServerUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("sourcebeam.serverUrl: must be a valid ws:// or wss:// URL.");
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error("sourcebeam.serverUrl: must start with ws:// or wss://.");
	}
	// Plain ws:// would send the code and the host token unencrypted. A deployed Worker is always
	// wss://; ws:// only exists for a local `wrangler dev`.
	if (url.protocol === "ws:" && !LOCAL_HOSTS.has(url.hostname)) {
		throw new Error("sourcebeam.serverUrl: ws:// is only allowed for localhost — use wss://.");
	}
	if (url.username || url.password) {
		throw new Error("sourcebeam.serverUrl: must not include a username or password.");
	}
	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Error("sourcebeam.serverUrl: must be an origin only — no path, query or fragment.");
	}
	return `${url.protocol}//${url.host}`;
}

/** SecretStorage key for a given (unvalidated) server setting — one token per origin, shared by
 * every workspace, not one global token shared across every server the setting has pointed at. */
export function hostTokenKey(server: string): string {
	return `sourcebeam.hostToken::${validateServerUrl(server)}`;
}

/** Best-effort default project id from the workspace folder's name: lowercased, anything outside
 * [a-z0-9_-] replaced with a hyphen, leading hyphens/underscores stripped since isValidProjectId
 * forbids them there. Only ever used as a fallback for an unset field — never overwrites a value
 * someone actually typed, valid or not. Mirrored in the JetBrains plugin's Settings.kt. */
export function sanitizeProjectId(name: string): string {
	const lowered = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	const trimmed = lowered.replace(/^[-_]+/, "").slice(0, 64);
	return trimmed || "project";
}

export function validateConfig(input: { server: string; project: string; token: string }): Config {
	const project = input.project.trim();

	if (!input.server.trim() || !project) {
		throw new Error("Set sourcebeam.serverUrl and sourcebeam.project in your settings.");
	}
	const server = validateServerUrl(input.server);
	if (!isValidProjectId(project)) {
		throw new Error(
			"sourcebeam.project: lowercase letters, digits, hyphens, underscores; can't start with a hyphen or underscore."
		);
	}
	if (!input.token) {
		throw new Error("No token set. Run the \"Sourcebeam: Set Host Token\" command.");
	}
	return { server, token: input.token, project };
}

/** The invite URL the server returns (`invite.url`) is relative to the http(s) origin, not the
 * ws(s) one the watcher connects with — swap the scheme for building the copy-to-clipboard link. */
export function toHttpUrl(serverUrl: string): string {
	return serverUrl.replace(/^ws/, "http");
}

// --- policy ---------------------------------------------------------------
// Every text file .gitignore doesn't exclude is broadcast. The server sends its size cap as the
// first message on every connection (see project-room.ts); text detection and the `.git/` block
// are @sourcebeam/protocol's own, shared with the server. The `.git/` block runs earlier, in the
// ignore chain below, so nothing under it is ever even read.

export function allowedByPolicy(byteLength: number, content: string, policy: FilePolicy): boolean {
	return byteLength <= policy.maxBytes && isText(content);
}

// --- ignore -----------------------------------------------------------
// Ignore-rule chain: `.git/` (always), then the project's .gitignore.

function scopedIgnores(text: string): (path: string) => boolean {
	const ig = ignoreFactory().add(text.split(/\r?\n/));
	return (path: string) => ig.ignores(path);
}

/** Builds a matcher: true means the given posix-relative path is ignored.
 *
 * `gitignoreText` is the content of the project's root `.gitignore` if present, else null.
 * `.git/` is always ignored, whatever .gitignore says; everything else (.env, keys) is up to the
 * project's .gitignore. Only the root
 * file — see buildNestedIgnoreMatcher for a workspace with nested .gitignore files too. */
export function buildIgnoreMatcher(gitignoreText: string | null): (relPath: string) => boolean {
	const matches = scopedIgnores(gitignoreText ?? "");
	return (relPath: string) => isHardBlocked(relPath) || matches(relPath);
}

/** `dir` is the posix path (relative to the workspace root) of the directory containing that
 * `.gitignore` — "" for the root itself. */
export type IgnoreSource = { dir: string; text: string };

/** Same as buildIgnoreMatcher, but folds in nested .gitignore files too — only the root one
 * used to be read, so a nested .gitignore's rules (e.g. `apps/web/.gitignore` excluding a
 * secret under `apps/web/`) were silently never applied.
 *
 * Each file's rules are scoped to its own directory: a pattern from `apps/web/.gitignore` is
 * only tested against paths under `apps/web/`, rebased relative to it — mirroring git's own
 * per-directory .gitignore semantics. A file is excluded if any applicable level, root down to
 * its containing directory, matches it. Cross-level negation (a nested file un-ignoring
 * something a parent excluded) isn't modeled; that only errs toward excluding a touch more
 * than git would, never toward leaking a file a shallower rule meant to keep out. */
export function buildNestedIgnoreMatcher(sources: IgnoreSource[]): (relPath: string) => boolean {
	const levels = sources.map(({ dir, text }) => ({ dir, matches: scopedIgnores(text) }));
	return (relPath: string) => {
		if (isHardBlocked(relPath)) return true;
		for (const { dir, matches } of levels) {
			if (dir !== "" && !relPath.startsWith(dir + "/")) continue;
			const sub = dir === "" ? relPath : relPath.slice(dir.length + 1);
			if (sub && matches(sub)) return true;
		}
		return false;
	};
}

// --- fatal errors -----------------------------------------------------
// Tags an error as "stop the reconnect loop, don't retry" — used for both a rejected (403)
// handshake and an oversized workspace (> MAX_FILES).

export function fatalError(message: string): Error {
	const err = new Error(message);
	(err as Error & { fatal: true }).fatal = true;
	return err;
}

export function isFatalError(err: unknown): boolean {
	return err instanceof Error && (err as Error & { fatal?: boolean }).fatal === true;
}

// --- reconnect backoff --------------------------------------------------

export function nextReconnectDelay(current: number): number {
	return Math.min(current * 2, RECONNECT_MAX_MS);
}

/** Cancelable via AbortSignal — used for the reconnect backoff pause. On abort, resolves right
 * away instead of waiting out the remaining delay, so stop() never leaves a live timer behind. */
export function cancelableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// --- coalescer ----------------------------------------------------------
// Per-path coalescing: a burst of fs events on the same path (save + external writes, git
// checkout, ...) collapses into one fire after `delayMs` of silence on that path.

export type Coalescer = { touch(key: string): void; cancelAll(): void };

export function createCoalescer(delayMs: number, onFire: (key: string) => void): Coalescer {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	function touch(key: string): void {
		const existing = timers.get(key);
		if (existing !== undefined) clearTimeout(existing);
		timers.set(
			key,
			setTimeout(() => {
				timers.delete(key);
				onFire(key);
			}, delayMs),
		);
	}

	function cancelAll(): void {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	}

	return { touch, cancelAll };
}
