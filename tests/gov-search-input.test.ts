import assert from "node:assert/strict";
import test from "node:test";
import { GovSearchError } from "../lib/gov-search/errors.ts";
import { requestBody, validateInput } from "../lib/gov-search/input.ts";

const rejects = (input: unknown, pattern: RegExp) => assert.throws(() => validateInput(input), (error: unknown) => error instanceof GovSearchError && error.code === "input" && pattern.test(error.message));

test("a plain query gets the default k and no filters", () => {
	assert.deepEqual(validateInput({ query: "  small claims limit  " }), { query: "small claims limit", k: 10 });
	assert.deepEqual(validateInput({ query: "q", k: 100 }), { query: "q", k: 100 });
});

test("filters are trimmed and normalized", () => {
	assert.deepEqual(validateInput({ query: "q", jurisdiction: " US-CA ", court: "CA9", courtType: "State-Supreme", cites: " 42 U.S.C. § 1983 ", domain: "WWW.IRS.GOV." }), {
		query: "q", k: 10, jurisdiction: "us-ca", court: "ca9", courtType: "state-supreme", cites: "42 U.S.C. § 1983", domain: "www.irs.gov",
	});
	assert.equal(validateInput({ query: "q", jurisdiction: "us" }).jurisdiction, "us");
	assert.equal(validateInput({ query: "q", domain: "bücher.gov" }).domain, "xn--bcher-kva.gov");
	assert.equal(validateInput({ query: "q", court: null }).court, undefined, "null reads as not given");
});

test("bad input is refused with the field and the rule", () => {
	rejects(undefined, /object/);
	rejects([], /object/);
	rejects({}, /query must be a string/);
	rejects({ query: "   " }, /query must not be empty/);
	rejects({ query: "a".repeat(1001) }, /longer than 1000/);
	rejects({ query: "a\u0000b" }, /control characters/);
	for (const k of [0, 101, 2.5, "10"]) rejects({ query: "q", k }, /k must be a whole number from 1 to 100/);
	for (const jurisdiction of ["ca", "us-california", "us_ca", "eu"]) rejects({ query: "q", jurisdiction }, /jurisdiction must be us/);
	rejects({ query: "q", court: "ca 9" }, /CourtListener/);
	rejects({ query: "q", courtType: "supreme" }, /courtType must be one of federal-supreme/);
	for (const domain of ["https://irs.gov", "irs.gov/path", "localhost", "irs..gov"]) rejects({ query: "q", domain }, /domain must be a site name/);
	rejects({ query: "q", cites: "x".repeat(201) }, /cites is longer/);
	rejects({ query: "q", limit: 5 }, /unknown field "limit"/);
});

test("the body holds only the fields the API knows", () => {
	assert.deepEqual(JSON.parse(requestBody(validateInput({ query: "q" }))), { query: "q", k: 10 });
	const full = validateInput({ query: "qualified immunity", k: 5, jurisdiction: "us-ca", courtType: "state-supreme", cites: "5 U.S. 137", court: "cal", domain: "courts.ca.gov" });
	assert.deepEqual(JSON.parse(requestBody(full)), { query: "qualified immunity", k: 5, jurisdiction: "us-ca", court: "cal", courtType: "state-supreme", cites: "5 U.S. 137", domain: "courts.ca.gov" });
});
