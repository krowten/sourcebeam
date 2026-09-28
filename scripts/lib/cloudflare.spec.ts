import { describe, expect, test } from "bun:test";
import { hasAuthenticatedAccounts, pickAccountId } from "./cloudflare";

describe("hasAuthenticatedAccounts", () => {
	test("true when the JSON lists at least one account", () => {
		expect(hasAuthenticatedAccounts('{"accounts":[{"id":"a","name":"A"}]}')).toBe(true);
	});

	test("false for an authenticated-but-empty account list", () => {
		expect(hasAuthenticatedAccounts('{"accounts":[]}')).toBe(false);
	});

	// The bug this guards against: `wrangler whoami` exits 0 either way, so only the parsed
	// content — not the exit code — can tell "not authenticated" apart from "authenticated".
	test("false for the unauthenticated shape (no accounts field at all)", () => {
		expect(hasAuthenticatedAccounts('{"error":"You are not authenticated"}')).toBe(false);
	});

	test("false for garbage, empty, or non-JSON stdout", () => {
		expect(hasAuthenticatedAccounts("")).toBe(false);
		expect(hasAuthenticatedAccounts("not json")).toBe(false);
		expect(hasAuthenticatedAccounts("{not valid json")).toBe(false);
	});

	test("tolerates banner text before the JSON object, same as the real CLI output", () => {
		expect(hasAuthenticatedAccounts('Some banner line\n{"accounts":[{"id":"a"}]}')).toBe(true);
	});
});

describe("pickAccountId", () => {
	const accounts = [{ id: "a" }, { id: "b" }];

	test("a single account is picked automatically, no env var needed", () => {
		expect(pickAccountId([{ id: "solo" }], undefined)).toBe("solo");
	});

	test("more than one account with no CLOUDFLARE_ACCOUNT_ID: refuses to guess", () => {
		expect(pickAccountId(accounts, undefined)).toBeUndefined();
	});

	test("CLOUDFLARE_ACCOUNT_ID selects the matching account among several", () => {
		expect(pickAccountId(accounts, "b")).toBe("b");
	});

	test("a CLOUDFLARE_ACCOUNT_ID that matches nothing this session can see is not picked", () => {
		expect(pickAccountId(accounts, "nonexistent")).toBeUndefined();
	});

	test("an empty account list never resolves, even with a matching-looking env var", () => {
		expect(pickAccountId([], "a")).toBeUndefined();
		expect(pickAccountId([], undefined)).toBeUndefined();
	});
});
