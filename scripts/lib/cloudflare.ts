// Shared wrangler/KV plumbing for scripts/deploy.ts, undeploy.ts, token.ts and project.ts.
import { homedir } from "node:os";

import { file, spawn } from "bun";

const { CLOUDFLARE_ACCOUNT_ID, SOURCEBEAM_WORKER_NAME = "sourcebeam" } = process.env;

export const ROOT = new URL("../../", import.meta.url).pathname;
export const WEB_DIR = `${ROOT}apps/web`;

const LOCAL_WRANGLER = `${WEB_DIR}/node_modules/.bin/wrangler`;
export const WRANGLER: string[] = (await file(LOCAL_WRANGLER).exists()) ? [LOCAL_WRANGLER] : ["bunx", "wrangler"];

// Wrangler refuses to run when both an API token and an OAuth session are present in the
// environment. These scripts always want the OAuth login from `wrangler login`, so strip any
// Cloudflare API credentials the shell happens to carry before spawning wrangler.
export const WRANGLER_ENV = { ...process.env };
delete WRANGLER_ENV.CLOUDFLARE_API_TOKEN;
delete WRANGLER_ENV.CLOUDFLARE_API_KEY;
delete WRANGLER_ENV.CLOUDFLARE_EMAIL;

export function fail(msg: string): never {
	console.error(`\nerror: ${msg}`);
	process.exit(1);
}

/** Run a wrangler subcommand, capturing output (non-interactive). */
export async function wrangler(args: string[]) {
	const proc = spawn([...WRANGLER, ...args], {
		cwd: WEB_DIR,
		env: WRANGLER_ENV,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/** Pure parse of `wrangler whoami --json`'s stdout (which may have banner text before the
 * JSON object) into whether the session is actually authenticated — exported for testing. */
export function hasAuthenticatedAccounts(whoamiJsonStdout: string): boolean {
	try {
		const start = whoamiJsonStdout.indexOf("{");
		if (start < 0) return false;
		const parsed = JSON.parse(whoamiJsonStdout.slice(start)) as { accounts?: unknown[] };
		return Array.isArray(parsed.accounts) && parsed.accounts.length > 0;
	} catch {
		return false;
	}
}

/** `wrangler whoami` exits 0 whether or not a session exists — "You are not authenticated" is
 * printed as informational output, not a failure. The `--json` form is the one that actually
 * distinguishes the two: an authenticated session lists at least one account. */
async function isAuthenticated(): Promise<boolean> {
	const who = await wrangler(["whoami", "--json"]);
	return who.exitCode === 0 && hasAuthenticatedAccounts(who.stdout);
}

/** Opens the browser for `wrangler login` (OAuth) if there's no valid session yet. A no-op
 * when already logged in, so every script that touches the Cloudflare API can call this first
 * instead of failing on a stale/missing session with a raw API error. */
export async function ensureLoggedIn(): Promise<void> {
	if (await isAuthenticated()) return;
	console.log("Not logged in to Cloudflare — opening the browser for `wrangler login`...");
	const loginProc = spawn([...WRANGLER, "login"], {
		cwd: WEB_DIR,
		env: WRANGLER_ENV,
		stdio: ["inherit", "inherit", "inherit"],
	});
	await loginProc.exited;
	if (!(await isAuthenticated())) {
		fail("still not authenticated after `wrangler login` — run it manually from apps/web and retry.");
	}
}

export function resolveWorkerName(): string {
	const rawName = SOURCEBEAM_WORKER_NAME;
	const NAME_RE = /^[a-z0-9][a-z0-9-]{0,53}$/;
	if (!NAME_RE.test(rawName)) {
		fail(
			`SOURCEBEAM_WORKER_NAME "${rawName}" is not a valid Worker name — it must match ` +
				`${NAME_RE} (lowercase letters, digits and hyphens, 1-54 chars, starting with a ` +
				`letter or digit).`,
		);
	}
	return rawName;
}

/** Picks which account to resolve the workers.dev subdomain against — exported for testing.
 * With more than one account on this session and no CLOUDFLARE_ACCOUNT_ID, returns undefined
 * rather than guessing: silently taking accounts[0] could resolve a different account's
 * subdomain, pointing `bun run project delete` (or the deploy summary's URL) at the wrong
 * deployment. Callers treat undefined the same as "couldn't work it out automatically" and fall
 * back to an explicit --server/SOURCEBEAM_SERVER_URL. */
export function pickAccountId(accounts: { id: string }[], envAccountId: string | undefined): string | undefined {
	if (envAccountId) return accounts.find((a) => a.id === envAccountId)?.id;
	return accounts.length === 1 ? accounts[0]!.id : undefined;
}

/** Derives the default `wss://<worker>.<subdomain>.workers.dev` URL the same way wrangler
 * itself does after a real deploy — there's no wrangler subcommand for it, so this reads the
 * account id from `wrangler whoami --json` and the workers.dev subdomain from the Cloudflare
 * API directly, using the OAuth token wrangler already stores at
 * ~/.config/.wrangler/config/default.toml (the path it prints itself in `wrangler whoami`).
 * Returns null instead of failing outright — callers should fall back to an explicit
 * --server/SOURCEBEAM_SERVER_URL for workers behind a custom domain instead of workers.dev. */
export async function resolveDefaultServerUrl(workerName: string): Promise<string | null> {
	const who = await wrangler(["whoami", "--json"]);
	if (who.exitCode !== 0) return null;
	let accounts: { id: string }[] | undefined;
	try {
		const start = who.stdout.indexOf("{");
		const parsed = JSON.parse(who.stdout.slice(start)) as { accounts?: { id: string }[] };
		accounts = parsed.accounts;
	} catch {
		return null;
	}
	if (!accounts || accounts.length === 0) return null;
	const accountId = pickAccountId(accounts, CLOUDFLARE_ACCOUNT_ID);
	if (!accountId) return null;

	let oauthToken: string | undefined;
	try {
		const toml = await file(`${homedir()}/.config/.wrangler/config/default.toml`).text();
		oauthToken = toml.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
	} catch {
		return null;
	}
	if (!oauthToken) return null;

	try {
		const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
			headers: { Authorization: `Bearer ${oauthToken}` },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { result?: { subdomain?: string } };
		const subdomain = body.result?.subdomain;
		if (!subdomain) return null;
		return `wss://${workerName}.${subdomain}.workers.dev`;
	} catch {
		return null;
	}
}

export type KvNamespace = { id: string; title: string };

export function namespaceTitleFor(workerName: string): string {
	return `${workerName}-HOST_TOKENS`;
}

export async function listNamespaces(): Promise<KvNamespace[]> {
	const res = await wrangler(["kv", "namespace", "list"]);
	if (res.exitCode !== 0) fail(`\`wrangler kv namespace list\` failed:\n${res.stderr}`);
	try {
		return JSON.parse(res.stdout) as KvNamespace[];
	} catch {
		fail(`could not parse \`wrangler kv namespace list\` output as JSON:\n${res.stdout}`);
	}
}

// The bare "HOST_TOKENS" fallback picks up a namespace created by hand with
// `wrangler kv namespace create HOST_TOKENS` before scripts/deploy.ts existed — reuse it
// rather than strand its tokens.
export function findNamespace(namespaces: KvNamespace[], workerName: string): KvNamespace | undefined {
	const namespaceTitle = namespaceTitleFor(workerName);
	return namespaces.find((n) => n.title === namespaceTitle) ?? namespaces.find((n) => n.title === "HOST_TOKENS");
}
