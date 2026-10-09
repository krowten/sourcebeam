import { expect, test } from "bun:test";
import { DEFAULT_POLICY, isValidProjectId } from "@sourcebeam/protocol";
import {
	allowedByPolicy,
	buildIgnoreMatcher,
	buildNestedIgnoreMatcher,
	cancelableSleep,
	createCoalescer,
	fatalError,
	hostTokenKey,
	isFatalError,
	nextReconnectDelay,
	RECONNECT_MAX_MS,
	RECONNECT_MIN_MS,
	sanitizeProjectId,
	toHttpUrl,
	validateConfig,
	validateServerUrl,
} from "../src/core";

test("validateConfig requires server, project and token", () => {
	expect(() => validateConfig({ server: "", project: "demo", token: "t" })).toThrow(/serverUrl/);
	expect(() => validateConfig({ server: "wss://h", project: "", token: "t" })).toThrow(/serverUrl/);
	expect(() => validateConfig({ server: "wss://h", project: "-bad", token: "t" })).toThrow(/project/);
	expect(() => validateConfig({ server: "wss://h", project: "demo-1", token: "" })).toThrow(/Set Host Token/i);
	expect(validateConfig({ server: "wss://h", project: "demo-1", token: "t" })).toEqual({
		server: "wss://h",
		token: "t",
		project: "demo-1",
	});
});

test("validateConfig trims whitespace around server/project", () => {
	expect(validateConfig({ server: " wss://h ", project: " demo ", token: "t" })).toEqual({
		server: "wss://h",
		token: "t",
		project: "demo",
	});
});

test("toHttpUrl swaps ws(s) for http(s), leaves the rest untouched", () => {
	expect(toHttpUrl("wss://sourcebeam.example.workers.dev")).toBe("https://sourcebeam.example.workers.dev");
	expect(toHttpUrl("ws://localhost:8787")).toBe("http://localhost:8787");
});

test("allowedByPolicy: any text file within the size cap passes, whatever its name", () => {
	const policy = DEFAULT_POLICY;
	expect(allowedByPolicy(100, "const x = 1;", policy)).toBe(true);
	expect(allowedByPolicy(2, "{}", policy)).toBe(true); // e.g. .prettierrc, no extension
	expect(allowedByPolicy(policy.maxBytes, "x", policy)).toBe(true);
	expect(allowedByPolicy(0, "", policy)).toBe(true);
	expect(allowedByPolicy(policy.maxBytes + 1, "x", policy)).toBe(false);
});

test("allowedByPolicy: binary content is rejected — lossy decode marker or NUL byte", () => {
	expect(allowedByPolicy(10, "bad \uFFFD byte", DEFAULT_POLICY)).toBe(false);
	expect(allowedByPolicy(10, "PNG\0data", DEFAULT_POLICY)).toBe(false);
});

test("allowedByPolicy: uses the given policy's cap, not a hardcoded default", () => {
	expect(allowedByPolicy(5, "hello", { maxBytes: 10 })).toBe(true);
	expect(allowedByPolicy(25, "hello".repeat(5), { maxBytes: 10 })).toBe(false);
});

test("buildIgnoreMatcher: only .git/ is ignored without a .gitignore — .env and keys are the project's call", () => {
	const ignored = buildIgnoreMatcher(null);
	expect(ignored("nested/.git/HEAD")).toBe(true);
	for (const path of ["src/main.ts", ".env", ".env.example", "certs/localhost.pem", ".npmrc", ".prettierrc"]) {
		expect(ignored(path)).toBe(false);
	}
});

test("buildIgnoreMatcher: .env and keys are excluded exactly when .gitignore says so", () => {
	const ignored = buildIgnoreMatcher([".env*", "!.env.example", "*.pem"].join("\n"));
	expect(ignored(".env")).toBe(true);
	expect(ignored("apps/web/.env.local")).toBe(true);
	expect(ignored(".env.example")).toBe(false);
	expect(ignored("certs/localhost.pem")).toBe(true);
});

test("buildIgnoreMatcher: applies the project's .gitignore rules on top of hardcoded ones", () => {
	const ignored = buildIgnoreMatcher(["dist/", "*.log"].join("\n"));
	expect(ignored("dist/bundle.js")).toBe(true);
	expect(ignored("app.log")).toBe(true);
	expect(ignored("src/main.ts")).toBe(false);
});

test("validateConfig: whitespace-only server/project fail the same way as empty", () => {
	expect(() => validateConfig({ server: "   ", project: "demo", token: "t" })).toThrow(/serverUrl/);
	expect(() => validateConfig({ server: "wss://h", project: "  ", token: "t" })).toThrow(/serverUrl/);
});

test("validateConfig: uppercase and dotted project ids are rejected", () => {
	expect(() => validateConfig({ server: "wss://h", project: "Demo", token: "t" })).toThrow(/project/);
	expect(() => validateConfig({ server: "wss://h", project: "a.b", token: "t" })).toThrow(/project/);
});

test("validateConfig: underscores are allowed in project ids", () => {
	expect(validateConfig({ server: "wss://h", project: "snake_case_id", token: "t" }).project).toBe(
		"snake_case_id"
	);
	expect(() => validateConfig({ server: "wss://h", project: "_bad", token: "t" })).toThrow(/project/);
});

test("sanitizeProjectId lowercases and replaces disallowed characters", () => {
	expect(sanitizeProjectId("My Project")).toBe("my-project");
	expect(sanitizeProjectId("MyRepo42")).toBe("myrepo42");
	expect(sanitizeProjectId("a.b.c")).toBe("a-b-c");
	expect(sanitizeProjectId("already_valid-id")).toBe("already_valid-id");
});

test("sanitizeProjectId strips a leading hyphen or underscore, since isValidProjectId forbids it", () => {
	expect(sanitizeProjectId("-project-name")).toBe("project-name");
	expect(sanitizeProjectId("_project-name")).toBe("project-name");
	expect(sanitizeProjectId("--__project-name")).toBe("project-name");
});

test("sanitizeProjectId falls back to a fixed name when nothing usable survives", () => {
	expect(sanitizeProjectId("")).toBe("project");
	expect(sanitizeProjectId("---")).toBe("project");
	expect(sanitizeProjectId("___")).toBe("project");
});

test("sanitizeProjectId output always satisfies isValidProjectId", () => {
	for (const name of ["My Project", "", "---", "already_valid-id", "日本語", "a".repeat(200)]) {
		expect(isValidProjectId(sanitizeProjectId(name))).toBe(true);
	}
});

test("toHttpUrl leaves an already-http url and mid-string 'ws' untouched", () => {
	expect(toHttpUrl("http://localhost:8787")).toBe("http://localhost:8787");
	// only the scheme prefix is swapped, not a 'ws' appearing later in the host
	expect(toHttpUrl("wss://ws.example.dev")).toBe("https://ws.example.dev");
});

test("buildIgnoreMatcher: empty-string gitignore behaves like none", () => {
	const ignored = buildIgnoreMatcher("");
	expect(ignored("src/main.ts")).toBe(false);
	expect(ignored(".env")).toBe(false);
	expect(ignored(".git/config")).toBe(true);
});

test("buildIgnoreMatcher: negation re-includes, but never .git/", () => {
	const ignored = buildIgnoreMatcher(["*.log", "!keep.log", "!.git/config"].join("\n"));
	expect(ignored("server.log")).toBe(true);
	expect(ignored("keep.log")).toBe(false);
	expect(ignored(".git/config")).toBe(true);
});

test("buildIgnoreMatcher: CRLF line endings parse the same as LF", () => {
	const ignored = buildIgnoreMatcher("dist/\r\n*.log\r\n");
	expect(ignored("dist/bundle.js")).toBe(true);
	expect(ignored("app.log")).toBe(true);
	expect(ignored("src/main.ts")).toBe(false);
});

test("buildIgnoreMatcher: anchored and double-star rules", () => {
	const ignored = buildIgnoreMatcher(["/dist", "docs/**/tmp"].join("\n"));
	expect(ignored("dist/app.js")).toBe(true);
	expect(ignored("packages/x/dist/app.js")).toBe(false);
	expect(ignored("docs/a/b/tmp")).toBe(true);
	expect(ignored("other/docs/tmp")).toBe(false);
});

test("fatalError / isFatalError round-trip", () => {
	expect(isFatalError(fatalError("boom"))).toBe(true);
	expect(isFatalError(new Error("boom"))).toBe(false);
	expect(isFatalError("boom")).toBe(false);
});

test("nextReconnectDelay doubles and caps at RECONNECT_MAX_MS", () => {
	let delay = RECONNECT_MIN_MS;
	const seen = [delay];
	for (let i = 0; i < 6; i++) {
		delay = nextReconnectDelay(delay);
		seen.push(delay);
	}
	expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
	expect(nextReconnectDelay(RECONNECT_MAX_MS)).toBe(RECONNECT_MAX_MS);
});

test("cancelableSleep resolves immediately on abort, not after the full delay", async () => {
	const controller = new AbortController();
	const t0 = Date.now();
	const promise = cancelableSleep(10_000, controller.signal);

	setTimeout(() => controller.abort(), 20);
	await promise;

	expect(Date.now() - t0).toBeLessThan(500);
});

test("cancelableSleep resolves after the delay when never aborted", async () => {
	const t0 = Date.now();
	await cancelableSleep(50);
	expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
});

test("createCoalescer: a burst of touches on the same key fires once, after the delay", async () => {
	const fired: string[] = [];
	const coalescer = createCoalescer(30, (key) => fired.push(key));

	coalescer.touch("a");
	coalescer.touch("a");
	coalescer.touch("a");
	coalescer.touch("b");

	await new Promise((resolve) => setTimeout(resolve, 60));

	expect(fired.sort()).toEqual(["a", "b"]);
});

test("createCoalescer: cancelAll drops pending timers without firing them", async () => {
	const fired: string[] = [];
	const coalescer = createCoalescer(30, (key) => fired.push(key));

	coalescer.touch("a");
	coalescer.cancelAll();

	await new Promise((resolve) => setTimeout(resolve, 60));

	expect(fired).toEqual([]);
});

test("cancelableSleep: an already-aborted signal resolves without waiting", async () => {
	const controller = new AbortController();
	controller.abort();
	const t0 = Date.now();
	await cancelableSleep(10_000, controller.signal);
	expect(Date.now() - t0).toBeLessThan(500);
});

test("createCoalescer: a touch after a fire re-arms the same key", async () => {
	const fired: string[] = [];
	const coalescer = createCoalescer(20, (key) => fired.push(key));

	coalescer.touch("a");
	await new Promise((resolve) => setTimeout(resolve, 50));
	coalescer.touch("a");
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(fired).toEqual(["a", "a"]);
});

test("validateServerUrl: accepts a bare ws(s) origin, normalizes a trailing slash away", () => {
	expect(validateServerUrl("wss://sourcebeam.example.workers.dev")).toBe(
		"wss://sourcebeam.example.workers.dev",
	);
	expect(validateServerUrl("ws://localhost:8787")).toBe("ws://localhost:8787");
	expect(validateServerUrl("wss://h/")).toBe("wss://h");
	expect(validateServerUrl("  wss://h  ")).toBe("wss://h");
});

test("validateServerUrl: rejects anything beyond a bare origin", () => {
	expect(() => validateServerUrl("not a url")).toThrow(/valid ws/);
	expect(() => validateServerUrl("http://h")).toThrow(/ws:\/\/ or wss:\/\//);
	expect(() => validateServerUrl("https://h")).toThrow(/ws:\/\/ or wss:\/\//);
	expect(() => validateServerUrl("wss://h/some/path")).toThrow(/origin only/);
	expect(() => validateServerUrl("wss://h?x=1")).toThrow(/origin only/);
	expect(() => validateServerUrl("wss://h#frag")).toThrow(/origin only/);
	expect(() => validateServerUrl("wss://user:pass@h")).toThrow(/username or password/);
});

test("validateServerUrl: plain ws:// only for localhost, never for a remote host", () => {
	expect(validateServerUrl("ws://127.0.0.1:4173")).toBe("ws://127.0.0.1:4173");
	expect(validateServerUrl("ws://[::1]:4173")).toBe("ws://[::1]:4173");
	expect(() => validateServerUrl("ws://sourcebeam.example.workers.dev")).toThrow(/only allowed for localhost/);
	expect(() => validateServerUrl("ws://192.168.1.10:8787")).toThrow(/only allowed for localhost/);
	expect(() => validateServerUrl("ws://localhost.evil.dev")).toThrow(/only allowed for localhost/);
});

test("hostTokenKey: one key per origin, distinct origins never collide", () => {
	expect(hostTokenKey("wss://a.example.dev")).not.toBe(hostTokenKey("wss://b.example.dev"));
	expect(hostTokenKey("wss://h")).toBe(hostTokenKey("wss://h/"));
	expect(hostTokenKey("wss://h:1")).not.toBe(hostTokenKey("wss://h:2"));
	expect(() => hostTokenKey("not a url")).toThrow();
});

test("validateConfig: normalizes the server to a bare origin and rejects a path/query/creds server", () => {
	expect(validateConfig({ server: "wss://h/", project: "demo", token: "t" }).server).toBe("wss://h");
	expect(() => validateConfig({ server: "wss://h/x", project: "demo", token: "t" })).toThrow(
		/origin only/,
	);
	expect(() => validateConfig({ server: "http://h", project: "demo", token: "t" })).toThrow(
		/ws:\/\/ or wss:\/\//,
	);
});

test("buildNestedIgnoreMatcher: folds in a nested .gitignore, scoped to its own directory", () => {
	const ignored = buildNestedIgnoreMatcher([
		{ dir: "", text: "dist/\n*.log" },
		{ dir: "apps/web", text: "*.secret\n.env.local" },
	]);
	expect(ignored("dist/bundle.js")).toBe(true); // root rule
	expect(ignored("apps/web/config.secret")).toBe(true); // nested rule, own subtree
	expect(ignored("apps/web/.env.local")).toBe(true);
	expect(ignored("other/config.secret")).toBe(false); // same pattern, different subtree
	expect(ignored("apps/web/src/main.ts")).toBe(false);
	expect(ignored(".env")).toBe(false); // no rule excludes it at the root
});

test("buildNestedIgnoreMatcher: a nested pattern without a leading slash still only matches its own subtree", () => {
	const ignored = buildNestedIgnoreMatcher([{ dir: "pkg", text: "build" }]);
	expect(ignored("pkg/build")).toBe(true);
	expect(ignored("pkg/nested/build")).toBe(true); // unanchored, matches at any depth *within pkg*
	expect(ignored("build")).toBe(false); // outside the nested gitignore's own directory
	expect(ignored("other/build")).toBe(false);
});

test("buildNestedIgnoreMatcher: with no sources at all, only .git/ is ignored", () => {
	const ignored = buildNestedIgnoreMatcher([]);
	expect(ignored("src/main.ts")).toBe(false);
	expect(ignored(".env")).toBe(false);
	expect(ignored(".git/HEAD")).toBe(true);
});

test("createCoalescer: cancelAll does not break later touches", async () => {
	const fired: string[] = [];
	const coalescer = createCoalescer(20, (key) => fired.push(key));

	coalescer.touch("a");
	coalescer.cancelAll();
	coalescer.touch("b");
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(fired).toEqual(["b"]);
});
